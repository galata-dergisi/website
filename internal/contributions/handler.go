// Copyright 2026 Mehmet Baker
//
// Private, append-only filesystem inbox for new contributions.
package contributions

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxFileSize        int64 = 50 * 1024 * 1024
	maxRequestSize           = MaxFileSize + 2*1024*1024
	metadataVersion          = 1
	throttleRetryAfter       = "60"
	throttleMessage          = "Çok fazla gönderi işleniyor. Lütfen bir dakika sonra tekrar deneyin."
)

var (
	errCaptchaInvalid = errors.New("captcha verification failed")
	allowedTypes      = map[string]string{
		"siir": "document", "oyku": "document", "deneme": "document",
		"roportaj": "document", "elestiri": "document",
		"resim": "image", "ses": "audio", "video": "video",
	}
	allowedExtensions = map[string]map[string][]string{
		"document": {
			".txt":  {"text/plain", "application/octet-stream"},
			".pdf":  {"application/pdf"},
			".doc":  {"application/msword", "application/octet-stream"},
			".docx": {"application/zip", "application/octet-stream"},
			".odt":  {"application/zip", "application/octet-stream"},
			".rtf":  {"text/plain", "application/rtf", "text/rtf", "application/octet-stream"},
		},
		"image": {
			".png":  {"image/png"},
			".jpg":  {"image/jpeg"},
			".jpeg": {"image/jpeg"},
			".bmp":  {"image/bmp", "application/octet-stream"},
			".tif":  {"image/tiff", "application/octet-stream"},
			".tiff": {"image/tiff", "application/octet-stream"},
		},
		"audio": {
			".mp3": {"audio/mpeg", "application/octet-stream"},
			".ogg": {"audio/ogg", "application/ogg", "application/octet-stream"},
		},
	}
)

type CaptchaVerifier interface {
	Verify(context.Context, string) error
}

type TurnstileVerifier struct {
	Secret           string
	Client           *http.Client
	Endpoint         string
	ExpectedAction   string
	AllowedHostnames []string
}

func (verifier *TurnstileVerifier) Verify(ctx context.Context, token string) error {
	endpoint := verifier.Endpoint
	if endpoint == "" {
		endpoint = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	}
	client := verifier.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	form := url.Values{
		"secret":   {verifier.Secret},
		"response": {token},
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return fmt.Errorf("create captcha request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("verify captcha: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("captcha service returned %s", response.Status)
	}
	var result struct {
		Success    bool     `json:"success"`
		Hostname   string   `json:"hostname"`
		Action     string   `json:"action"`
		ErrorCodes []string `json:"error-codes"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result); err != nil {
		return fmt.Errorf("decode captcha response: %w", err)
	}
	if !result.Success {
		for _, code := range result.ErrorCodes {
			switch code {
			case "missing-input-secret", "invalid-input-secret", "bad-request", "internal-error":
				return fmt.Errorf("captcha service rejected verification request: %s", code)
			}
		}
		return errCaptchaInvalid
	}
	if verifier.ExpectedAction != "" && result.Action != verifier.ExpectedAction {
		return errCaptchaInvalid
	}
	if len(verifier.AllowedHostnames) != 0 {
		hostnameAllowed := false
		for _, hostname := range verifier.AllowedHostnames {
			if result.Hostname == hostname {
				hostnameAllowed = true
				break
			}
		}
		if !hostnameAllowed {
			return errCaptchaInvalid
		}
	}
	return nil
}

type Config struct {
	Root           string
	Verifier       CaptchaVerifier
	MaxConcurrent  int
	Logger         *slog.Logger
	Now            func() time.Time
	Random         io.Reader
	StaleAfter     time.Duration
	ForbiddenRoots []string
}

type Handler struct {
	root       string
	inbox      string
	staging    string
	verifier   CaptchaVerifier
	slots      chan struct{}
	logger     *slog.Logger
	now        func() time.Time
	random     io.Reader
	staleAfter time.Duration
}

type FileMetadata struct {
	OriginalName string `json:"originalName"`
	StoredName   string `json:"storedName"`
	MediaType    string `json:"mediaType"`
	ByteLength   int64  `json:"byteLength"`
	SHA256       string `json:"sha256"`
}

type Metadata struct {
	SchemaVersion int           `json:"schemaVersion"`
	ID            string        `json:"id"`
	ReceivedAt    string        `json:"receivedAt"`
	Name          string        `json:"name"`
	Email         string        `json:"email"`
	Title         string        `json:"title"`
	Type          string        `json:"type"`
	Message       string        `json:"message,omitempty"`
	VideoURL      string        `json:"videoUrl,omitempty"`
	File          *FileMetadata `json:"file,omitempty"`
}

type incoming struct {
	name           string
	email          string
	title          string
	assetType      string
	message        string
	videoURL       string
	captcha        string
	contactWebsite string
	originalName   string
	temporaryFile  string
	extension      string
	mediaType      string
	byteLength     int64
	hash           string
	fileCount      int
}

type clientError struct {
	status  int
	code    string
	message string
}

func (err *clientError) Error() string {
	return err.code
}

func New(config Config) (*Handler, error) {
	if strings.TrimSpace(config.Root) == "" {
		return nil, errors.New("contribution root is required")
	}
	if config.Verifier == nil {
		return nil, errors.New("captcha verifier is required")
	}
	if config.MaxConcurrent < 0 {
		return nil, errors.New("maximum concurrent contributions cannot be negative")
	}
	root, err := filepath.Abs(config.Root)
	if err != nil {
		return nil, fmt.Errorf("resolve contribution root: %w", err)
	}
	for _, forbidden := range config.ForbiddenRoots {
		if strings.TrimSpace(forbidden) == "" {
			continue
		}
		forbiddenPath, resolveErr := filepath.Abs(forbidden)
		if resolveErr != nil {
			return nil, fmt.Errorf("resolve forbidden root: %w", resolveErr)
		}
		if pathsOverlap(root, forbiddenPath) {
			return nil, fmt.Errorf(
				"contribution root %q overlaps served/media root %q",
				root,
				forbiddenPath,
			)
		}
	}
	if err := ensurePrivateDirectory(root); err != nil {
		return nil, fmt.Errorf("prepare contribution root: %w", err)
	}
	staging := filepath.Join(root, ".staging")
	inbox := filepath.Join(root, "inbox")
	for _, directory := range []string{staging, inbox} {
		if err := ensurePrivateDirectory(directory); err != nil {
			return nil, fmt.Errorf("prepare contribution directory: %w", err)
		}
	}
	handler := &Handler{
		root:       root,
		inbox:      inbox,
		staging:    staging,
		verifier:   config.Verifier,
		logger:     config.Logger,
		now:        config.Now,
		random:     config.Random,
		staleAfter: config.StaleAfter,
	}
	if config.MaxConcurrent > 0 {
		handler.slots = make(chan struct{}, config.MaxConcurrent)
	}
	if handler.logger == nil {
		handler.logger = slog.Default()
	}
	if handler.now == nil {
		handler.now = time.Now
	}
	if handler.random == nil {
		handler.random = rand.Reader
	}
	if handler.staleAfter == 0 {
		handler.staleAfter = 24 * time.Hour
	}
	if err := handler.cleanStaleStaging(); err != nil {
		return nil, err
	}
	return handler, nil
}

func pathsOverlap(left, right string) bool {
	relative, err := filepath.Rel(left, right)
	if err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return true
	}
	relative, err = filepath.Rel(right, left)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func ensurePrivateDirectory(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	return os.Chmod(directory, 0o700)
}

func (handler *Handler) cleanStaleStaging() error {
	entries, err := os.ReadDir(handler.staging)
	if err != nil {
		return fmt.Errorf("read contribution staging: %w", err)
	}
	cutoff := handler.now().UTC().Add(-handler.staleAfter)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return fmt.Errorf("inspect staged contribution: %w", infoErr)
		}
		if info.ModTime().Before(cutoff) {
			target := filepath.Join(handler.staging, entry.Name())
			if err := os.RemoveAll(target); err != nil {
				return fmt.Errorf("remove stale staged contribution: %w", err)
			}
			handler.logger.Info("removed stale staged contribution", "directory", entry.Name())
		}
	}
	return nil
}

func (handler *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writer.Header().Set("Allow", "POST")
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{
			"ok": false, "code": "method_not_allowed", "message": "Yönteme izin verilmiyor.",
		})
		return
	}
	if handler.slots != nil {
		select {
		case handler.slots <- struct{}{}:
			defer func() { <-handler.slots }()
		default:
			writer.Header().Set("Retry-After", throttleRetryAfter)
			writeJSON(writer, http.StatusTooManyRequests, map[string]any{
				"ok": false, "code": "submission_throttled",
				"message": throttleMessage,
			})
			return
		}
	}
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestSize)
	id, err := handler.accept(request)
	if err == nil {
		writeJSON(writer, http.StatusCreated, map[string]any{"ok": true, "id": id})
		return
	}
	var publicError *clientError
	if errors.As(err, &publicError) {
		writeJSON(writer, publicError.status, map[string]any{
			"ok": false, "code": publicError.code, "message": publicError.message,
		})
		return
	}
	handler.logger.Error("failed to store contribution", "error", err)
	writeJSON(writer, http.StatusInternalServerError, map[string]any{
		"ok":      false,
		"code":    "storage_failed",
		"message": "Gönderi kaydedilemedi. Lütfen daha sonra tekrar deneyin.",
	})
}

func (handler *Handler) accept(request *http.Request) (string, error) {
	receivedAt := handler.now().UTC()
	id, err := handler.newID(receivedAt)
	if err != nil {
		return "", fmt.Errorf("create submission id: %w", err)
	}
	stage := filepath.Join(handler.staging, id)
	if err := os.Mkdir(stage, 0o700); err != nil {
		return "", fmt.Errorf("create staging directory: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			if cleanupErr := os.RemoveAll(stage); cleanupErr != nil {
				handler.logger.Error(
					"failed to clean contribution staging",
					"directory", id,
					"error", cleanupErr,
				)
			}
		}
	}()

	submission, err := handler.readMultipart(request, stage)
	if err != nil {
		return "", err
	}
	if submission.contactWebsite != "" {
		handler.logger.Info("rejected contribution", "reason", "honeypot")
		return "", captchaInvalidClientError()
	}
	if err := validateSubmission(submission); err != nil {
		return "", err
	}
	if err := handler.verifier.Verify(request.Context(), submission.captcha); err != nil {
		if errors.Is(err, errCaptchaInvalid) {
			return "", captchaInvalidClientError()
		}
		return "", fmt.Errorf("captcha service failure: %w", err)
	}

	var fileMetadata *FileMetadata
	if submission.fileCount == 1 {
		storedName := "asset" + submission.extension
		storedPath := filepath.Join(stage, storedName)
		if err := os.Rename(submission.temporaryFile, storedPath); err != nil {
			return "", fmt.Errorf("finalize staged asset: %w", err)
		}
		fileMetadata = &FileMetadata{
			OriginalName: submission.originalName,
			StoredName:   storedName,
			MediaType:    submission.mediaType,
			ByteLength:   submission.byteLength,
			SHA256:       submission.hash,
		}
	}
	metadata := Metadata{
		SchemaVersion: metadataVersion,
		ID:            id,
		ReceivedAt:    receivedAt.Format(time.RFC3339Nano),
		Name:          submission.name,
		Email:         submission.email,
		Title:         submission.title,
		Type:          submission.assetType,
		Message:       submission.message,
		VideoURL:      submission.videoURL,
		File:          fileMetadata,
	}
	if err := writeMetadata(stage, metadata); err != nil {
		return "", err
	}
	if err := syncDirectory(stage); err != nil {
		return "", fmt.Errorf("sync staged contribution: %w", err)
	}
	finalPath := filepath.Join(handler.inbox, id)
	if err := os.Rename(stage, finalPath); err != nil {
		return "", fmt.Errorf("commit contribution: %w", err)
	}
	if err := syncDirectory(handler.inbox); err != nil {
		return "", fmt.Errorf("sync contribution inbox: %w", err)
	}
	committed = true
	return id, nil
}

func (handler *Handler) readMultipart(
	request *http.Request,
	stage string,
) (*incoming, error) {
	reader, err := request.MultipartReader()
	if err != nil {
		return nil, &clientError{
			status: http.StatusBadRequest, code: "invalid_multipart",
			message: "Gönderi biçimi geçersiz.",
		}
	}
	result := &incoming{}
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			if strings.Contains(nextErr.Error(), "request body too large") {
				return nil, fileTooLargeError()
			}
			return nil, &clientError{
				status: http.StatusBadRequest, code: "invalid_multipart",
				message: "Gönderi biçimi geçersiz.",
			}
		}
		if part.FileName() != "" {
			if err := handler.readFilePart(part, stage, result); err != nil {
				part.Close()
				return nil, err
			}
		} else if err := readTextPart(part, result); err != nil {
			part.Close()
			return nil, err
		}
		part.Close()
	}
	return result, nil
}

func (handler *Handler) readFilePart(
	part *multipart.Part,
	stage string,
	result *incoming,
) error {
	if part.FormName() != "file" || result.fileCount != 0 {
		return &clientError{
			status: http.StatusBadRequest, code: "invalid_file_count",
			message: "Yalnızca bir dosya yükleyebilirsiniz.",
		}
	}
	result.fileCount++
	result.originalName = filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/"))
	result.extension = strings.ToLower(filepath.Ext(result.originalName))
	result.temporaryFile = filepath.Join(stage, "asset.upload")

	file, err := os.OpenFile(
		result.temporaryFile,
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0o600,
	)
	if err != nil {
		return fmt.Errorf("create staged asset: %w", err)
	}
	defer file.Close()

	prefix := make([]byte, 512)
	prefixLength, readErr := io.ReadFull(part, prefix)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return &clientError{
			status: http.StatusBadRequest, code: "invalid_file",
			message: "Dosya okunamadı.",
		}
	}
	prefix = prefix[:prefixLength]
	digest := sha256.New()
	writer := io.MultiWriter(file, digest)
	if _, err := writer.Write(prefix); err != nil {
		return fmt.Errorf("write staged asset prefix: %w", err)
	}
	remaining := io.LimitReader(part, MaxFileSize-int64(prefixLength)+1)
	written, err := io.Copy(writer, remaining)
	if err != nil {
		if strings.Contains(err.Error(), "request body too large") {
			return fileTooLargeError()
		}
		return fmt.Errorf("write staged asset: %w", err)
	}
	result.byteLength = int64(prefixLength) + written
	if result.byteLength > MaxFileSize {
		return fileTooLargeError()
	}
	if result.byteLength == 0 {
		return &clientError{
			status: http.StatusBadRequest, code: "empty_file",
			message: "Dosya boş olamaz.",
		}
	}
	result.mediaType, _, _ = mime.ParseMediaType(http.DetectContentType(prefix))
	result.hash = hex.EncodeToString(digest.Sum(nil))
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync staged asset: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close staged asset: %w", err)
	}
	return nil
}

func readTextPart(part *multipart.Part, result *incoming) error {
	limits := map[string]int64{
		"name": 256, "email": 512, "title": 512, "assetType": 64,
		"message": 20 * 1024, "videoLink": 2048, "cf-turnstile-response": 2048,
		"contactWebsite": 512,
	}
	limit, known := limits[part.FormName()]
	if !known {
		return nil
	}
	content, err := io.ReadAll(io.LimitReader(part, limit+1))
	if err != nil || int64(len(content)) > limit {
		return &clientError{
			status: http.StatusBadRequest, code: "field_too_long",
			message: "Gönderi alanlarından biri çok uzun.",
		}
	}
	value := strings.TrimSpace(string(content))
	switch part.FormName() {
	case "name":
		result.name = value
	case "email":
		result.email = value
	case "title":
		result.title = value
	case "assetType":
		result.assetType = value
	case "message":
		result.message = value
	case "videoLink":
		result.videoURL = value
	case "cf-turnstile-response":
		result.captcha = value
	case "contactWebsite":
		result.contactWebsite = value
	}
	return nil
}

func captchaInvalidClientError() *clientError {
	return &clientError{
		status: http.StatusBadRequest, code: "captcha_invalid",
		message: "Güvenlik doğrulaması başarısız oldu.",
	}
}

func validateSubmission(submission *incoming) error {
	required := []struct {
		value string
		code  string
	}{
		{submission.name, "name_required"},
		{submission.email, "email_required"},
		{submission.title, "title_required"},
		{submission.assetType, "type_required"},
		{submission.captcha, "captcha_required"},
	}
	for _, field := range required {
		if field.value == "" {
			return &clientError{
				status: http.StatusBadRequest, code: field.code,
				message: "Lütfen gerekli alanları doldurun.",
			}
		}
	}
	if utf8.RuneCountInString(submission.name) > 40 ||
		utf8.RuneCountInString(submission.email) > 100 ||
		utf8.RuneCountInString(submission.title) > 120 ||
		utf8.RuneCountInString(submission.message) > 5000 ||
		utf8.RuneCountInString(submission.videoURL) > 255 {
		return &clientError{
			status: http.StatusBadRequest, code: "field_too_long",
			message: "Gönderi alanlarından biri çok uzun.",
		}
	}
	address, err := mail.ParseAddress(submission.email)
	if err != nil || address.Address != submission.email {
		return &clientError{
			status: http.StatusBadRequest, code: "email_invalid",
			message: "Lütfen geçerli bir e-posta adresi girin.",
		}
	}
	category, validType := allowedTypes[submission.assetType]
	if !validType {
		return &clientError{
			status: http.StatusBadRequest, code: "type_invalid",
			message: "Eser türü geçersiz.",
		}
	}
	if category == "video" {
		if submission.fileCount != 0 {
			return &clientError{
				status: http.StatusBadRequest, code: "video_file_not_allowed",
				message: "Video gönderileri dosya içeremez.",
			}
		}
		parsed, parseErr := url.ParseRequestURI(submission.videoURL)
		if parseErr != nil ||
			(parsed.Scheme != "https" && parsed.Scheme != "http") ||
			parsed.Host == "" ||
			parsed.User != nil {
			return &clientError{
				status: http.StatusBadRequest, code: "video_url_invalid",
				message: "Lütfen geçerli bir video adresi girin.",
			}
		}
		return nil
	}
	if submission.videoURL != "" {
		return &clientError{
			status: http.StatusBadRequest, code: "video_url_not_allowed",
			message: "Bu eser türü video adresi içeremez.",
		}
	}
	if submission.fileCount != 1 {
		return &clientError{
			status: http.StatusBadRequest, code: "file_required",
			message: "Lütfen bir dosya seçin.",
		}
	}
	types, extensionAllowed := allowedExtensions[category][submission.extension]
	if !extensionAllowed || !contains(types, submission.mediaType) {
		return &clientError{
			status: http.StatusUnsupportedMediaType, code: "media_type_invalid",
			message: "Dosya türü desteklenmiyor.",
		}
	}
	return nil
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func fileTooLargeError() error {
	return &clientError{
		status: http.StatusRequestEntityTooLarge, code: "file_too_large",
		message: "Dosya 50 MiB'den küçük veya eşit olmalıdır.",
	}
}

func writeMetadata(directory string, metadata Metadata) error {
	content, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return fmt.Errorf("encode contribution metadata: %w", err)
	}
	content = append(content, '\n')
	file, err := os.OpenFile(
		filepath.Join(directory, "metadata.json"),
		os.O_WRONLY|os.O_CREATE|os.O_EXCL,
		0o600,
	)
	if err != nil {
		return fmt.Errorf("create contribution metadata: %w", err)
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		return fmt.Errorf("write contribution metadata: %w", err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return fmt.Errorf("sync contribution metadata: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close contribution metadata: %w", err)
	}
	return nil
}

func syncDirectory(directory string) error {
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func (handler *Handler) newID(receivedAt time.Time) (string, error) {
	random := make([]byte, 16)
	if _, err := io.ReadFull(handler.random, random); err != nil {
		return "", err
	}
	return receivedAt.Format("20060102T150405.000000000Z") +
		"-" + hex.EncodeToString(random), nil
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
