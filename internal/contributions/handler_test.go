package contributions

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type verifierFunc func(context.Context, string) error

func (function verifierFunc) Verify(ctx context.Context, token string) error {
	return function(ctx, token)
}

type upload struct {
	filename string
	content  []byte
}

func newTestHandler(t *testing.T, verifier CaptchaVerifier) (*Handler, string) {
	return newTestHandlerWithMaxConcurrent(t, verifier, 0)
}

func newTestHandlerWithMaxConcurrent(
	t *testing.T,
	verifier CaptchaVerifier,
	maxConcurrent int,
) (*Handler, string) {
	t.Helper()
	root := t.TempDir()
	handler, err := New(Config{
		Root:          root,
		Verifier:      verifier,
		MaxConcurrent: maxConcurrent,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now: func() time.Time {
			return time.Date(2026, 7, 26, 12, 34, 56, 123, time.UTC)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler, root
}

func validVerifier() CaptchaVerifier {
	return verifierFunc(func(_ context.Context, token string) error {
		if token != "valid-token" {
			return errCaptchaInvalid
		}
		return nil
	})
}

func TestTurnstileVerifierSubmitsTokenWithoutOptionalIdentifiers(t *testing.T) {
	type observedRequest struct {
		method             string
		contentType        string
		secret             string
		response           string
		remoteIPPresent    bool
		idempotencyPresent bool
		parseError         error
	}
	observed := make(chan observedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		parseError := request.ParseForm()
		_, remoteIPPresent := request.Form["remoteip"]
		_, idempotencyPresent := request.Form["idempotency_key"]
		observed <- observedRequest{
			method:             request.Method,
			contentType:        request.Header.Get("Content-Type"),
			secret:             request.Form.Get("secret"),
			response:           request.Form.Get("response"),
			remoteIPPresent:    remoteIPPresent,
			idempotencyPresent: idempotencyPresent,
			parseError:         parseError,
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{
			"success": true,
			"hostname": "galatadergisi.org",
			"action": "contribution"
		}`)
	}))
	defer server.Close()

	verifier := &TurnstileVerifier{
		Secret:           "turnstile-secret",
		Client:           server.Client(),
		Endpoint:         server.URL,
		ExpectedAction:   "contribution",
		AllowedHostnames: []string{"galatadergisi.org", "www.galatadergisi.org"},
	}
	if err := verifier.Verify(context.Background(), "turnstile-token"); err != nil {
		t.Fatal(err)
	}
	request := <-observed
	if request.parseError != nil {
		t.Fatal(request.parseError)
	}
	if request.method != http.MethodPost ||
		!strings.HasPrefix(request.contentType, "application/x-www-form-urlencoded") ||
		request.secret != "turnstile-secret" ||
		request.response != "turnstile-token" ||
		request.remoteIPPresent ||
		request.idempotencyPresent {
		t.Fatalf("unexpected Siteverify request: %+v", request)
	}
}

func TestTurnstileVerifierClassifiesFailures(t *testing.T) {
	testCases := []struct {
		name        string
		status      int
		body        string
		wantInvalid bool
	}{
		{
			name: "invalid token", status: http.StatusOK,
			body:        `{"success":false,"error-codes":["invalid-input-response"]}`,
			wantInvalid: true,
		},
		{
			name: "duplicate token", status: http.StatusOK,
			body:        `{"success":false,"error-codes":["timeout-or-duplicate"]}`,
			wantInvalid: true,
		},
		{
			name: "wrong action", status: http.StatusOK,
			body:        `{"success":true,"hostname":"galatadergisi.org","action":"login"}`,
			wantInvalid: true,
		},
		{
			name: "wrong hostname", status: http.StatusOK,
			body:        `{"success":true,"hostname":"attacker.example","action":"contribution"}`,
			wantInvalid: true,
		},
		{
			name: "internal error", status: http.StatusOK,
			body: `{"success":false,"error-codes":["internal-error"]}`,
		},
		{
			name: "invalid secret", status: http.StatusOK,
			body: `{"success":false,"error-codes":["invalid-input-secret"]}`,
		},
		{
			name: "bad request", status: http.StatusOK,
			body: `{"success":false,"error-codes":["bad-request"]}`,
		},
		{
			name: "non-200 response", status: http.StatusBadGateway,
			body: `{"success":true}`,
		},
		{
			name: "malformed response", status: http.StatusOK,
			body: `{`,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(
				writer http.ResponseWriter,
				_ *http.Request,
			) {
				writer.WriteHeader(testCase.status)
				_, _ = io.WriteString(writer, testCase.body)
			}))
			defer server.Close()
			verifier := &TurnstileVerifier{
				Secret:           "secret",
				Client:           server.Client(),
				Endpoint:         server.URL,
				ExpectedAction:   "contribution",
				AllowedHostnames: []string{"galatadergisi.org"},
			}
			err := verifier.Verify(context.Background(), "token")
			if err == nil {
				t.Fatal("verification failure was accepted")
			}
			if gotInvalid := errors.Is(err, errCaptchaInvalid); gotInvalid != testCase.wantInvalid {
				t.Fatalf("error=%v invalid=%t want=%t", err, gotInvalid, testCase.wantInvalid)
			}
		})
	}
}

func TestTurnstileVerifierTreatsTransportFailureAsServiceFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	endpoint := server.URL
	client := server.Client()
	server.Close()

	verifier := &TurnstileVerifier{
		Secret:   "secret",
		Client:   client,
		Endpoint: endpoint,
	}
	err := verifier.Verify(context.Background(), "token")
	if err == nil || errors.Is(err, errCaptchaInvalid) {
		t.Fatalf("transport error classification=%v", err)
	}
}

func contributionRequest(
	t *testing.T,
	fields map[string]string,
	file *upload,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			t.Fatal(err)
		}
	}
	if file != nil {
		part, err := writer.CreateFormFile("file", file.filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(file.content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/katkida-bulunun", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func baseFields(assetType string) map[string]string {
	return map[string]string{
		"name":                  "Ada Lovelace",
		"email":                 "ada@example.com",
		"title":                 "Yeni Eser",
		"assetType":             assetType,
		"message":               "Editörlere kısa not.",
		"cf-turnstile-response": "valid-token",
		"contactWebsite":        "",
	}
}

func responseJSON(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
	return result
}

func TestAcceptedFileIsHashedPrivateAndAtomicallyVisible(t *testing.T) {
	handler, root := newTestHandler(t, validVerifier())
	content := []byte("Galata icin yeni bir siir.\n")
	request := contributionRequest(
		t,
		baseFields("siir"),
		&upload{filename: "../../poem.txt", content: content},
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	result := responseJSON(t, response)
	id, ok := result["id"].(string)
	if !ok || !strings.HasPrefix(id, "20260726T123456.000000123Z-") {
		t.Fatalf("unexpected id: %#v", result["id"])
	}

	finalDirectory := filepath.Join(root, "inbox", id)
	entries, err := os.ReadDir(finalDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("inbox files=%v", entries)
	}
	metadataContent, err := os.ReadFile(filepath.Join(finalDirectory, "metadata.json"))
	if err != nil {
		t.Fatal(err)
	}
	var metadata Metadata
	if err := json.Unmarshal(metadataContent, &metadata); err != nil {
		t.Fatal(err)
	}
	expectedHash := sha256.Sum256(content)
	if metadata.SchemaVersion != 1 ||
		metadata.File == nil ||
		metadata.File.OriginalName != "poem.txt" ||
		metadata.File.StoredName != "asset.txt" ||
		metadata.File.ByteLength != int64(len(content)) ||
		metadata.File.SHA256 != hex.EncodeToString(expectedHash[:]) {
		t.Fatalf("metadata=%+v", metadata)
	}
	for _, forbidden := range []string{
		"valid-token", "captcha", "contactWebsite", "ipAddress", "remoteAddress",
	} {
		if strings.Contains(string(metadataContent), forbidden) {
			t.Fatalf("metadata contains forbidden value %q", forbidden)
		}
	}
	for _, filename := range []string{"metadata.json", "asset.txt"} {
		info, err := os.Stat(filepath.Join(finalDirectory, filename))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("%s permissions=%o", filename, info.Mode().Perm())
		}
	}
	staged, err := os.ReadDir(filepath.Join(root, ".staging"))
	if err != nil || len(staged) != 0 {
		t.Fatalf("staging=%v err=%v", staged, err)
	}
}

func TestEveryContributionType(t *testing.T) {
	testCases := []struct {
		assetType string
		file      *upload
		extra     map[string]string
	}{
		{"siir", &upload{"work.txt", []byte("text work")}, nil},
		{"oyku", &upload{"work.txt", []byte("text work")}, nil},
		{"deneme", &upload{"work.txt", []byte("text work")}, nil},
		{"roportaj", &upload{"work.txt", []byte("text work")}, nil},
		{"elestiri", &upload{"work.txt", []byte("text work")}, nil},
		{"resim", &upload{"image.png", append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 24)...)}, nil},
		{"ses", &upload{"audio.mp3", append([]byte("ID3\x04\x00\x00"), make([]byte, 24)...)}, nil},
		{"video", nil, map[string]string{"videoLink": "https://video.example/watch?v=1"}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.assetType, func(t *testing.T) {
			handler, _ := newTestHandler(t, validVerifier())
			fields := baseFields(testCase.assetType)
			for key, value := range testCase.extra {
				fields[key] = value
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(
				response,
				contributionRequest(t, fields, testCase.file),
			)
			if response.Code != http.StatusCreated {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
		})
	}
}

func TestValidationAndCaptchaFailuresLeaveNoStagingData(t *testing.T) {
	testCases := []struct {
		name       string
		fields     map[string]string
		file       *upload
		wantStatus int
		wantCode   string
	}{
		{
			name: "missing captcha",
			fields: func() map[string]string {
				fields := baseFields("siir")
				delete(fields, "cf-turnstile-response")
				return fields
			}(),
			file:       &upload{"work.txt", []byte("valid text")},
			wantStatus: http.StatusBadRequest, wantCode: "captcha_required",
		},
		{
			name: "oversized captcha",
			fields: func() map[string]string {
				fields := baseFields("siir")
				fields["cf-turnstile-response"] = strings.Repeat("x", 2049)
				return fields
			}(),
			file:       &upload{"work.txt", []byte("valid text")},
			wantStatus: http.StatusBadRequest, wantCode: "field_too_long",
		},
		{
			name: "oversized honeypot",
			fields: func() map[string]string {
				fields := baseFields("siir")
				fields["contactWebsite"] = strings.Repeat("x", 513)
				return fields
			}(),
			file:       &upload{"work.txt", []byte("valid text")},
			wantStatus: http.StatusBadRequest, wantCode: "field_too_long",
		},
		{
			name: "missing file", fields: baseFields("siir"),
			wantStatus: http.StatusBadRequest, wantCode: "file_required",
		},
		{
			name: "unsupported file", fields: baseFields("resim"),
			file:       &upload{"image.exe", []byte("MZ executable")},
			wantStatus: http.StatusUnsupportedMediaType, wantCode: "media_type_invalid",
		},
		{
			name: "invalid video", fields: baseFields("video"),
			wantStatus: http.StatusBadRequest, wantCode: "video_url_invalid",
		},
		{
			name: "file on video",
			fields: func() map[string]string {
				fields := baseFields("video")
				fields["videoLink"] = "https://video.example/watch"
				return fields
			}(),
			file:       &upload{"work.txt", []byte("not allowed")},
			wantStatus: http.StatusBadRequest, wantCode: "video_file_not_allowed",
		},
		{
			name: "invalid captcha",
			fields: func() map[string]string {
				fields := baseFields("siir")
				fields["cf-turnstile-response"] = "invalid"
				return fields
			}(),
			file:       &upload{"work.txt", []byte("valid text")},
			wantStatus: http.StatusBadRequest, wantCode: "captcha_invalid",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, root := newTestHandler(t, validVerifier())
			response := httptest.NewRecorder()
			handler.ServeHTTP(
				response,
				contributionRequest(t, testCase.fields, testCase.file),
			)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status=%d body=%s", response.Code, response.Body)
			}
			if code := responseJSON(t, response)["code"]; code != testCase.wantCode {
				t.Fatalf("code=%v want=%s", code, testCase.wantCode)
			}
			staged, err := os.ReadDir(filepath.Join(root, ".staging"))
			if err != nil || len(staged) != 0 {
				t.Fatalf("staging=%v err=%v", staged, err)
			}
			inbox, err := os.ReadDir(filepath.Join(root, "inbox"))
			if err != nil || len(inbox) != 0 {
				t.Fatalf("inbox=%v err=%v", inbox, err)
			}
		})
	}
}

func TestFilledHoneypotBypassesTurnstileAndLeavesNoData(t *testing.T) {
	var verifierCalls atomic.Int32
	handler, root := newTestHandler(t, verifierFunc(func(context.Context, string) error {
		verifierCalls.Add(1)
		return nil
	}))
	fields := baseFields("siir")
	fields["contactWebsite"] = "https://spam.example"
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		contributionRequest(t, fields, &upload{"work.txt", []byte("valid text")}),
	)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	result := responseJSON(t, response)
	if result["code"] != "captcha_invalid" ||
		result["message"] != "Güvenlik doğrulaması başarısız oldu." {
		t.Fatalf("response=%v", result)
	}
	if calls := verifierCalls.Load(); calls != 0 {
		t.Fatalf("Turnstile calls=%d want=0", calls)
	}
	for _, directory := range []string{".staging", "inbox"} {
		entries, err := os.ReadDir(filepath.Join(root, directory))
		if err != nil || len(entries) != 0 {
			t.Fatalf("%s=%v err=%v", directory, entries, err)
		}
	}
}

type readTrackingBody struct {
	read atomic.Bool
}

func (body *readTrackingBody) Read([]byte) (int, error) {
	body.read.Store(true)
	return 0, io.EOF
}

func (*readTrackingBody) Close() error {
	return nil
}

func TestConcurrentLimitRejectsBeforeReadingBodyAndReleasesAfterSuccess(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var verifierCalls atomic.Int32
	handler, _ := newTestHandlerWithMaxConcurrent(
		t,
		verifierFunc(func(context.Context, string) error {
			verifierCalls.Add(1)
			entered <- struct{}{}
			<-release
			return nil
		}),
		1,
	)

	firstFields := baseFields("video")
	firstFields["videoLink"] = "https://video.example/first"
	firstRequest := contributionRequest(t, firstFields, nil)
	firstResponse := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		handler.ServeHTTP(firstResponse, firstRequest)
	}()
	<-entered

	trackedBody := &readTrackingBody{}
	secondRequest := httptest.NewRequest(http.MethodPost, "/katkida-bulunun", nil)
	secondRequest.Body = trackedBody
	secondRequest.Header.Set("Content-Type", "multipart/form-data; boundary=unused")
	secondResponse := httptest.NewRecorder()
	handler.ServeHTTP(secondResponse, secondRequest)

	if secondResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("status=%d body=%s", secondResponse.Code, secondResponse.Body)
	}
	if retryAfter := secondResponse.Header().Get("Retry-After"); retryAfter != "60" {
		t.Fatalf("Retry-After=%q", retryAfter)
	}
	result := responseJSON(t, secondResponse)
	if result["ok"] != false || result["code"] != "submission_throttled" ||
		result["message"] != throttleMessage {
		t.Fatalf("response=%v", result)
	}
	if trackedBody.read.Load() {
		t.Fatal("saturated request body was read")
	}
	if calls := verifierCalls.Load(); calls != 1 {
		t.Fatalf("verifier calls=%d want=1", calls)
	}

	close(release)
	<-firstDone
	if firstResponse.Code != http.StatusCreated {
		t.Fatalf("first status=%d body=%s", firstResponse.Code, firstResponse.Body)
	}

	thirdFields := baseFields("video")
	thirdFields["videoLink"] = "https://video.example/third"
	thirdResponse := httptest.NewRecorder()
	handler.ServeHTTP(thirdResponse, contributionRequest(t, thirdFields, nil))
	if thirdResponse.Code != http.StatusCreated {
		t.Fatalf("third status=%d body=%s", thirdResponse.Code, thirdResponse.Body)
	}
}

func TestConcurrentLimitReleasesAfterFailure(t *testing.T) {
	handler, _ := newTestHandlerWithMaxConcurrent(
		t,
		verifierFunc(func(context.Context, string) error {
			return errors.New("verification service unavailable")
		}),
		1,
	)
	for attempt := 0; attempt < 2; attempt++ {
		fields := baseFields("video")
		fields["videoLink"] = "https://video.example/failure"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, contributionRequest(t, fields, nil))
		if response.Code != http.StatusInternalServerError {
			t.Fatalf("attempt=%d status=%d body=%s", attempt, response.Code, response.Body)
		}
	}
}

func TestNegativeConcurrentLimitFailsStartup(t *testing.T) {
	_, err := New(Config{
		Root:          t.TempDir(),
		Verifier:      validVerifier(),
		MaxConcurrent: -1,
	})
	if err == nil || !strings.Contains(err.Error(), "cannot be negative") {
		t.Fatalf("error=%v", err)
	}
}

func TestCaptchaServiceFailureReturnsGenericErrorAndLeavesNoData(t *testing.T) {
	handler, root := newTestHandler(t, verifierFunc(func(context.Context, string) error {
		return errors.New("verification service unavailable")
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		contributionRequest(
			t,
			baseFields("siir"),
			&upload{"work.txt", []byte("valid text")},
		),
	)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if code := responseJSON(t, response)["code"]; code != "storage_failed" {
		t.Fatalf("code=%v", code)
	}
	for _, directory := range []string{".staging", "inbox"} {
		entries, err := os.ReadDir(filepath.Join(root, directory))
		if err != nil || len(entries) != 0 {
			t.Fatalf("%s=%v err=%v", directory, entries, err)
		}
	}
}

func TestConcurrentSubmissionsCreateDistinctCompleteDirectories(t *testing.T) {
	handler, root := newTestHandler(t, validVerifier())
	const count = 12
	var wait sync.WaitGroup
	wait.Add(count)
	errorsChannel := make(chan error, count)
	for index := 0; index < count; index++ {
		go func(index int) {
			defer wait.Done()
			fields := baseFields("siir")
			fields["title"] = "Work " + string(rune('A'+index))
			response := httptest.NewRecorder()
			handler.ServeHTTP(
				response,
				contributionRequest(t, fields, &upload{
					"work.txt", []byte("concurrent contribution"),
				}),
			)
			if response.Code != http.StatusCreated {
				errorsChannel <- errors.New(response.Body.String())
			}
		}(index)
	}
	wait.Wait()
	close(errorsChannel)
	for err := range errorsChannel {
		t.Error(err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "inbox"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != count {
		t.Fatalf("inbox count=%d want=%d", len(entries), count)
	}
	for _, entry := range entries {
		for _, filename := range []string{"metadata.json", "asset.txt"} {
			if _, err := os.Stat(filepath.Join(root, "inbox", entry.Name(), filename)); err != nil {
				t.Fatalf("%s is incomplete: %v", entry.Name(), err)
			}
		}
	}
}

func TestStartupRemovesOnlyStaleStagingDirectories(t *testing.T) {
	root := t.TempDir()
	staging := filepath.Join(root, ".staging")
	if err := os.MkdirAll(filepath.Join(staging, "old"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(staging, "new"), 0o700); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(
		filepath.Join(staging, "old"),
		now.Add(-25*time.Hour),
		now.Add(-25*time.Hour),
	); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(
		filepath.Join(staging, "new"),
		now.Add(-23*time.Hour),
		now.Add(-23*time.Hour),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := New(Config{
		Root: root, Verifier: validVerifier(), Now: func() time.Time { return now },
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(staging, "old")); !os.IsNotExist(err) {
		t.Fatalf("old staging still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(staging, "new")); err != nil {
		t.Fatalf("new staging was removed: %v", err)
	}
}

func TestContributionRootCannotOverlapMediaRoot(t *testing.T) {
	root := t.TempDir()
	_, err := New(Config{
		Root:           filepath.Join(root, "media", "contributions"),
		Verifier:       validVerifier(),
		ForbiddenRoots: []string{filepath.Join(root, "media")},
	})
	if err == nil || !strings.Contains(err.Error(), "overlaps") {
		t.Fatalf("error=%v", err)
	}
}

type zeroReader struct{}

func (zeroReader) Read(content []byte) (int, error) {
	for index := range content {
		content[index] = 0
	}
	return len(content), nil
}

func oversizedRequest(t *testing.T) *http.Request {
	t.Helper()
	reader, writer := io.Pipe()
	multipartWriter := multipart.NewWriter(writer)
	go func() {
		defer writer.Close()
		for key, value := range baseFields("siir") {
			if err := multipartWriter.WriteField(key, value); err != nil {
				writer.CloseWithError(err)
				return
			}
		}
		part, err := multipartWriter.CreateFormFile("file", "large.txt")
		if err != nil {
			writer.CloseWithError(err)
			return
		}
		if _, err := io.CopyN(part, zeroReader{}, MaxFileSize+1); err != nil {
			writer.CloseWithError(err)
			return
		}
		if err := multipartWriter.Close(); err != nil {
			writer.CloseWithError(err)
		}
	}()
	request := httptest.NewRequest(http.MethodPost, "/katkida-bulunun", reader)
	request.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	return request
}

func TestOversizedFileIsRejectedAndCleaned(t *testing.T) {
	handler, root := newTestHandler(t, validVerifier())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, oversizedRequest(t))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if code := responseJSON(t, response)["code"]; code != "file_too_large" {
		t.Fatalf("code=%v", code)
	}
	for _, directory := range []string{".staging", "inbox"} {
		entries, err := os.ReadDir(filepath.Join(root, directory))
		if err != nil || len(entries) != 0 {
			t.Fatalf("%s=%v err=%v", directory, entries, err)
		}
	}
}

func TestStorageFailureReturnsGenericError(t *testing.T) {
	handler, _ := newTestHandler(t, validVerifier())
	if err := os.Chmod(handler.staging, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(handler.staging, 0o700)
	})
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		contributionRequest(
			t,
			baseFields("siir"),
			&upload{"work.txt", []byte("valid text")},
		),
	)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	result := responseJSON(t, response)
	if result["code"] != "storage_failed" ||
		result["message"] != "Gönderi kaydedilemedi. Lütfen daha sonra tekrar deneyin." {
		t.Fatalf("response=%v", result)
	}
}

func TestRestartPreservesCommittedInbox(t *testing.T) {
	handler, root := newTestHandler(t, validVerifier())
	fields := baseFields("video")
	fields["videoLink"] = "https://video.example/watch?v=restart"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, contributionRequest(t, fields, nil))
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	id := responseJSON(t, response)["id"].(string)

	if _, err := New(Config{
		Root:     root,
		Verifier: validVerifier(),
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "inbox", id, "metadata.json")); err != nil {
		t.Fatalf("committed contribution did not survive restart: %v", err)
	}
}
