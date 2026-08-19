// Copyright 2026 Mehmet Baker
//
// Embedded, immutable public-site handler.
package site

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
)

//go:embed dist/manifest.json dist/files
var embeddedFiles embed.FS

type Entry struct {
	File         string `json:"file"`
	GzipFile     string `json:"gzipFile,omitempty"`
	ContentType  string `json:"contentType"`
	ETag         string `json:"etag"`
	CacheControl string `json:"cacheControl"`
	Size         int64  `json:"size"`
}

type Summary struct {
	Magazines                int `json:"magazines"`
	PageVariants             int `json:"pageVariants"`
	Works                    int `json:"works"`
	Contributors             int `json:"contributors"`
	Recitations              int `json:"recitations"`
	InlineMediaContributions int `json:"inlineMediaContributions"`
	Routes                   int `json:"routes"`
	UniqueFiles              int `json:"uniqueFiles"`
}

type Manifest struct {
	Version          int               `json:"version"`
	Release          string            `json:"release"`
	Routes           map[string]Entry  `json:"routes"`
	Redirects        map[string]string `json:"redirects"`
	ContributorSlugs map[string]string `json:"contributorSlugs"`
	NotFound         Entry             `json:"notFound"`
	Summary          Summary           `json:"summary"`
}

type Handler struct {
	files    fs.FS
	manifest Manifest
}

var contributorPathPattern = regexp.MustCompile(
	`^/katkida-bulunanlar/([0-9]+)(?:-[^/]*)?/?$`,
)

func New(files fs.FS) (*Handler, error) {
	content, err := fs.ReadFile(files, "manifest.json")
	if err != nil {
		return nil, fmt.Errorf("read generated manifest: %w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(content, &manifest); err != nil {
		return nil, fmt.Errorf("decode generated manifest: %w", err)
	}
	if manifest.Version != 1 {
		return nil, fmt.Errorf("unsupported generated manifest version %d", manifest.Version)
	}
	if manifest.Release == "" || len(manifest.Routes) == 0 {
		return nil, errors.New("generated manifest is incomplete")
	}
	for requestPath, entry := range manifest.Routes {
		if err := validateEntry(files, requestPath, entry); err != nil {
			return nil, err
		}
	}
	if err := validateEntry(files, "notFound", manifest.NotFound); err != nil {
		return nil, err
	}
	return &Handler{files: files, manifest: manifest}, nil
}

func NewEmbedded() (*Handler, error) {
	files, err := fs.Sub(embeddedFiles, "dist")
	if err != nil {
		return nil, fmt.Errorf("open embedded site: %w", err)
	}
	return New(files)
}

func validateEntry(files fs.FS, requestPath string, entry Entry) error {
	if entry.File == "" || entry.ContentType == "" || entry.ETag == "" {
		return fmt.Errorf("manifest entry %q is incomplete", requestPath)
	}
	for _, filename := range []string{entry.File, entry.GzipFile} {
		if filename == "" {
			continue
		}
		if !fs.ValidPath(filename) || strings.HasPrefix(filename, "/") {
			return fmt.Errorf("manifest entry %q has invalid file %q", requestPath, filename)
		}
		if _, err := fs.Stat(files, filename); err != nil {
			return fmt.Errorf("manifest entry %q file %q: %w", requestPath, filename, err)
		}
	}
	return nil
}

func (handler *Handler) Release() string {
	return handler.manifest.Release
}

func (handler *Handler) Manifest() Manifest {
	return handler.manifest
}

func acceptsGzip(header string) bool {
	for _, item := range strings.Split(header, ",") {
		parts := strings.Split(item, ";")
		encoding := strings.TrimSpace(parts[0])
		if encoding != "gzip" && encoding != "*" {
			continue
		}
		accepted := true
		for _, parameter := range parts[1:] {
			name, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
			if found && strings.EqualFold(name, "q") {
				quality, err := strconv.ParseFloat(value, 64)
				if err == nil && quality == 0 {
					accepted = false
				}
			}
		}
		if accepted {
			return true
		}
	}
	return false
}

func etagMatches(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || candidate == etag || candidate == "W/"+etag {
			return true
		}
	}
	return false
}

func (handler *Handler) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		http.Error(writer, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	requestPath := request.URL.Path
	if target, ok := handler.manifest.Redirects[requestPath]; ok {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		http.Redirect(writer, request, target, http.StatusMovedPermanently)
		return
	}
	if matches := contributorPathPattern.FindStringSubmatch(requestPath); matches != nil {
		if slug, ok := handler.manifest.ContributorSlugs[matches[1]]; ok {
			canonical := "/katkida-bulunanlar/" + matches[1] + "-" + slug
			if requestPath != canonical {
				writer.Header().Set("X-Content-Type-Options", "nosniff")
				http.Redirect(writer, request, canonical, http.StatusMovedPermanently)
				return
			}
		}
	}

	if entry, ok := handler.manifest.Routes[requestPath]; ok {
		handler.serveEntry(writer, request, entry, http.StatusOK)
		return
	}
	handler.serveEntry(writer, request, handler.manifest.NotFound, http.StatusNotFound)
}

func (handler *Handler) serveEntry(
	writer http.ResponseWriter,
	request *http.Request,
	entry Entry,
	status int,
) {
	header := writer.Header()
	header.Set("Cache-Control", entry.CacheControl)
	header.Set("Content-Type", entry.ContentType)
	header.Set("ETag", entry.ETag)
	header.Set("X-Content-Type-Options", "nosniff")
	if strings.HasPrefix(request.URL.Path, "/magazines") {
		header.Set("X-Robots-Tag", "noindex")
	}
	if etagMatches(request.Header.Get("If-None-Match"), entry.ETag) {
		writer.WriteHeader(http.StatusNotModified)
		return
	}

	filename := entry.File
	if entry.GzipFile != "" && acceptsGzip(request.Header.Get("Accept-Encoding")) {
		filename = entry.GzipFile
		header.Set("Content-Encoding", "gzip")
		header.Set("Vary", "Accept-Encoding")
	}
	file, err := handler.files.Open(path.Clean(filename))
	if err != nil {
		http.Error(writer, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	defer file.Close()

	if info, statErr := file.Stat(); statErr == nil {
		header.Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	}
	writer.WriteHeader(status)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = io.Copy(writer, file)
}
