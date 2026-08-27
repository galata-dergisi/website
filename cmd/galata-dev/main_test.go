package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func testSite(t *testing.T, root string) {
	t.Helper()
	content := []byte("<!doctype html><title>development</title>")
	digest := sha256.Sum256(content)
	name := hex.EncodeToString(digest[:]) + ".html"
	if err := os.MkdirAll(filepath.Join(root, "files"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "files", name), content, 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := map[string]any{
		"version": 1,
		"release": "test-release",
		"routes": map[string]any{
			"/": map[string]any{
				"file": "files/" + name, "contentType": "text/html; charset=utf-8",
				"etag": `"test"`, "cacheControl": "no-store", "size": len(content),
			},
		},
		"redirects":        map[string]string{},
		"contributorSlugs": map[string]string{},
		"notFound": map[string]any{
			"file": "files/" + name, "contentType": "text/html; charset=utf-8",
			"etag": `"test"`, "cacheControl": "no-store", "size": len(content),
		},
		"summary": map[string]int{},
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDevelopmentFilesServeImagesAndAudioRanges(t *testing.T) {
	root := t.TempDir()
	publicRoot := filepath.Join(root, "public")
	mediaRoot := filepath.Join(root, "media")
	if err := os.MkdirAll(filepath.Join(publicRoot, "images", "sayi1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(mediaRoot, "images", "sayi1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(mediaRoot, "audio", "sayi1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(publicRoot, "images", "first-shelf.png"),
		[]byte("current-shelf"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(mediaRoot, "images", "first-shelf.png"),
		[]byte("stale-shelf"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(publicRoot, "images", "sayi1", "thumbnail.jpg"),
		[]byte("stale-thumbnail"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(mediaRoot, "images", "sayi1", "thumbnail.jpg"),
		[]byte("thumbnail"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(mediaRoot, "audio", "sayi1", "reading.mp3"),
		[]byte("0123456789"),
		0o644,
	); err != nil {
		t.Fatal(err)
	}
	handler := developmentFiles{
		publicRoot: publicRoot,
		mediaRoot:  mediaRoot,
		next:       http.NotFoundHandler(),
	}

	shelf := httptest.NewRecorder()
	handler.ServeHTTP(
		shelf,
		httptest.NewRequest(http.MethodGet, "/images/first-shelf.png", nil),
	)
	if shelf.Code != http.StatusOK || shelf.Body.String() != "current-shelf" {
		t.Fatalf("shelf status=%d body=%q", shelf.Code, shelf.Body.String())
	}
	post := httptest.NewRecorder()
	handler.ServeHTTP(
		post,
		httptest.NewRequest(http.MethodPost, "/images/first-shelf.png", nil),
	)
	if post.Code != http.StatusMethodNotAllowed || post.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("post status=%d allow=%q", post.Code, post.Header().Get("Allow"))
	}

	image := httptest.NewRecorder()
	handler.ServeHTTP(
		image,
		httptest.NewRequest(http.MethodGet, "/images/sayi1/thumbnail.jpg", nil),
	)
	if image.Code != http.StatusOK || image.Body.String() != "thumbnail" {
		t.Fatalf("image status=%d body=%q", image.Code, image.Body.String())
	}

	head := httptest.NewRecorder()
	handler.ServeHTTP(
		head,
		httptest.NewRequest(
			http.MethodHead,
			"/magazines/sayi1/audio/reading.mp3",
			nil,
		),
	)
	if head.Code != http.StatusOK || head.Body.Len() != 0 ||
		head.Header().Get("Content-Length") != "10" ||
		head.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf(
			"head status=%d length=%q ranges=%q body=%q",
			head.Code,
			head.Header().Get("Content-Length"),
			head.Header().Get("Accept-Ranges"),
			head.Body.String(),
		)
	}

	for _, test := range []struct {
		name          string
		rangeHeader   string
		status        int
		body          string
		contentRange  string
		contentLength string
	}{
		{
			name: "bounded", rangeHeader: "bytes=2-5", status: http.StatusPartialContent,
			body: "2345", contentRange: "bytes 2-5/10", contentLength: "4",
		},
		{
			name: "open-ended", rangeHeader: "bytes=2-", status: http.StatusPartialContent,
			body: "23456789", contentRange: "bytes 2-9/10", contentLength: "8",
		},
		{
			name: "suffix", rangeHeader: "bytes=-4", status: http.StatusPartialContent,
			body: "6789", contentRange: "bytes 6-9/10", contentLength: "4",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodGet,
				"/magazines/sayi1/audio/reading.mp3",
				nil,
			)
			request.Header.Set("Range", test.rangeHeader)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.status ||
				response.Body.String() != test.body ||
				response.Header().Get("Accept-Ranges") != "bytes" ||
				response.Header().Get("Content-Range") != test.contentRange ||
				response.Header().Get("Content-Length") != test.contentLength {
				t.Fatalf(
					"status=%d headers=%v body=%q",
					response.Code,
					response.Header(),
					response.Body.String(),
				)
			}
		})
	}

	unsatisfiableRequest := httptest.NewRequest(
		http.MethodGet,
		"/magazines/sayi1/audio/reading.mp3",
		nil,
	)
	unsatisfiableRequest.Header.Set("Range", "bytes=20-")
	unsatisfiable := httptest.NewRecorder()
	handler.ServeHTTP(unsatisfiable, unsatisfiableRequest)
	if unsatisfiable.Code != http.StatusRequestedRangeNotSatisfiable ||
		unsatisfiable.Header().Get("Content-Range") != "bytes */10" {
		t.Fatalf(
			"unsatisfiable status=%d headers=%v body=%q",
			unsatisfiable.Code,
			unsatisfiable.Header(),
			unsatisfiable.Body.String(),
		)
	}
}

func TestDevelopmentFilesRejectDirectoriesAndTraversal(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "images"), 0o755); err != nil {
		t.Fatal(err)
	}
	handler := developmentFiles{
		publicRoot: root,
		mediaRoot:  root,
		next:       http.NotFoundHandler(),
	}
	for _, target := range []string{
		"/images/",
		"/images/../secret",
		"/images/%2e%2e/secret",
		"/images/%5c..%5csecret",
		"/images/%00secret",
	} {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status=%d", target, response.Code)
		}
	}
}

func TestDevelopmentFilesUseRootedSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks requires additional privileges on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "images"), 0o755); err != nil {
		t.Fatal(err)
	}
	insideFile := filepath.Join(root, "inside.txt")
	if err := os.WriteFile(insideFile, []byte("inside"), 0o644); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(
		filepath.Join("..", "inside.txt"),
		filepath.Join(root, "images", "inside.txt"),
	); err != nil {
		t.Fatal(err)
	}
	escapingTarget, err := filepath.Rel(filepath.Join(root, "images"), outsideFile)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(
		escapingTarget,
		filepath.Join(root, "images", "outside.txt"),
	); err != nil {
		t.Fatal(err)
	}

	handler := developmentFiles{
		publicRoot: root,
		mediaRoot:  root,
		next:       http.NotFoundHandler(),
	}
	inside := httptest.NewRecorder()
	handler.ServeHTTP(
		inside,
		httptest.NewRequest(http.MethodGet, "/images/inside.txt", nil),
	)
	if inside.Code != http.StatusOK || inside.Body.String() != "inside" {
		t.Fatalf("inside status=%d body=%q", inside.Code, inside.Body.String())
	}

	escaping := httptest.NewRecorder()
	handler.ServeHTTP(
		escaping,
		httptest.NewRequest(http.MethodGet, "/images/outside.txt", nil),
	)
	if escaping.Code != http.StatusNotFound || strings.Contains(escaping.Body.String(), "outside") {
		t.Fatalf("escaping status=%d body=%q", escaping.Code, escaping.Body.String())
	}
}

func TestDevelopmentFilesPreserveFallbackAndRootErrors(t *testing.T) {
	root := t.TempDir()
	fallback := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusTeapot)
	})
	handler := developmentFiles{
		publicRoot: root,
		mediaRoot:  root,
		next:       fallback,
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(
		missing,
		httptest.NewRequest(http.MethodGet, "/missing.txt", nil),
	)
	if missing.Code != http.StatusTeapot {
		t.Fatalf("missing status=%d", missing.Code)
	}

	unavailable := developmentFiles{
		publicRoot: filepath.Join(root, "unavailable"),
		mediaRoot:  filepath.Join(root, "unavailable"),
		next:       fallback,
	}
	response := httptest.NewRecorder()
	unavailable.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/missing.txt", nil),
	)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("unavailable root status=%d", response.Code)
	}
}

func TestDevelopmentStatus(t *testing.T) {
	root := t.TempDir()
	siteRoot := filepath.Join(root, "site")
	mediaRoot := filepath.Join(root, "public")
	testSite(t, siteRoot)
	if err := os.MkdirAll(mediaRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	handler, err := newDevelopmentHandler(serverConfig{
		SiteRoot:        siteRoot,
		PublicRoot:      mediaRoot,
		MediaRoot:       mediaRoot,
		GenerationToken: "generation-1",
		ServerToken:     "server-1",
	})
	if err != nil {
		t.Fatal(err)
	}

	status := httptest.NewRecorder()
	handler.ServeHTTP(
		status,
		httptest.NewRequest(http.MethodGet, "/__dev/status", nil),
	)
	if status.Code != http.StatusOK ||
		!strings.Contains(status.Body.String(), `"generation":"generation-1"`) ||
		!strings.Contains(status.Body.String(), `"server":"server-1"`) ||
		status.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d headers=%v body=%q", status.Code, status.Header(), status.Body)
	}
}
