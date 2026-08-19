package site

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testHandler(t *testing.T) *Handler {
	t.Helper()
	manifest := Manifest{
		Version: 1,
		Release: "test-release",
		Routes: map[string]Entry{
			"/": {
				File: "files/home.html", GzipFile: "files/home.html.gz",
				ContentType: "text/html; charset=utf-8",
				ETag:        `"home"`, CacheControl: "public, max-age=0, must-revalidate",
				Size: 4,
			},
			"/bundle.js": {
				File:         "files/bundle.js",
				ContentType:  "text/javascript; charset=utf-8",
				ETag:         `"bundle"`,
				CacheControl: "public, max-age=0, must-revalidate",
				Size:         6,
			},
			"/magazines": {
				File:        "files/magazines.json",
				ContentType: "application/json; charset=utf-8",
				ETag:        `"magazines"`, CacheControl: "public, max-age=0, must-revalidate",
				Size: 12,
			},
			"/magazines/1/seo": {
				File:        "files/seo.json",
				ContentType: "application/json; charset=utf-8",
				ETag:        `"seo"`, CacheControl: "public, max-age=0, must-revalidate",
				Size: 12,
			},
			"/katkida-bulunanlar/1-test": {
				File:        "files/profile.html",
				ContentType: "text/html; charset=utf-8",
				ETag:        `"profile"`, CacheControl: "public, max-age=0, must-revalidate",
				Size: 7,
			},
		},
		Redirects:        map[string]string{"/home/": "/"},
		ContributorSlugs: map[string]string{"1": "test"},
		NotFound: Entry{
			File: "files/404.html", ContentType: "text/html; charset=utf-8",
			ETag: `"404"`, CacheControl: "public, max-age=0, must-revalidate",
			Size: 9,
		},
	}
	manifestJSON, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{
		"manifest.json":        {Data: manifestJSON},
		"files/home.html":      {Data: []byte("home")},
		"files/home.html.gz":   {Data: gzipContent(t, []byte("home"))},
		"files/bundle.js":      {Data: []byte("bundle")},
		"files/magazines.json": {Data: []byte(`{"ok":true}`)},
		"files/seo.json":       {Data: []byte(`{"ok":true}`)},
		"files/profile.html":   {Data: []byte("profile")},
		"files/404.html":       {Data: []byte("not found")},
	}
	handler, err := New(files)
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func TestHandlerIgnoresAssetVersionQueryForRouting(t *testing.T) {
	handler := testHandler(t)

	plain := httptest.NewRecorder()
	handler.ServeHTTP(
		plain,
		httptest.NewRequest(http.MethodGet, "/bundle.js", nil),
	)
	versioned := httptest.NewRecorder()
	handler.ServeHTTP(
		versioned,
		httptest.NewRequest(http.MethodGet, "/bundle.js?v=0123456789abcdef", nil),
	)

	if versioned.Code != http.StatusOK || versioned.Body.String() != plain.Body.String() {
		t.Fatalf(
			"versioned response: status=%d body=%q",
			versioned.Code,
			versioned.Body.String(),
		)
	}
	if versioned.Header().Get("ETag") != plain.Header().Get("ETag") {
		t.Fatalf(
			"versioned ETag=%q plain ETag=%q",
			versioned.Header().Get("ETag"),
			plain.Header().Get("ETag"),
		)
	}
}

func gzipContent(t *testing.T, content []byte) []byte {
	t.Helper()
	var recorder responseBuffer
	writer := gzip.NewWriter(&recorder)
	if _, err := writer.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return recorder.content
}

type responseBuffer struct {
	content []byte
}

func (buffer *responseBuffer) Write(content []byte) (int, error) {
	buffer.content = append(buffer.content, content...)
	return len(content), nil
}

func TestHandlerServesIdentityGzipHeadAndETag(t *testing.T) {
	handler := testHandler(t)

	identity := httptest.NewRecorder()
	handler.ServeHTTP(identity, httptest.NewRequest(http.MethodGet, "/", nil))
	if identity.Code != http.StatusOK || identity.Body.String() != "home" {
		t.Fatalf("identity response: status=%d body=%q", identity.Code, identity.Body.String())
	}
	if identity.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff header is missing")
	}

	compressed := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Accept-Encoding", "br, gzip")
	handler.ServeHTTP(compressed, request)
	if compressed.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("gzip response was not selected")
	}
	reader, err := gzip.NewReader(compressed.Body)
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(reader)
	if err != nil || string(content) != "home" {
		t.Fatalf("gzip content=%q err=%v", content, err)
	}

	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/", nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD response: status=%d body=%q", head.Code, head.Body.String())
	}
	if head.Header().Get("Content-Length") != "4" {
		t.Fatalf("HEAD content length=%q", head.Header().Get("Content-Length"))
	}

	notModified := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("If-None-Match", `"home"`)
	handler.ServeHTTP(notModified, request)
	if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 {
		t.Fatalf("304 response: status=%d body=%q", notModified.Code, notModified.Body.String())
	}
}

func TestHandlerNoindexesReaderMetadata(t *testing.T) {
	handler := testHandler(t)
	response := httptest.NewRecorder()
	handler.ServeHTTP(
		response,
		httptest.NewRequest(http.MethodGet, "/magazines/1/seo", nil),
	)
	if response.Code != http.StatusOK || response.Body.String() != `{"ok":true}` {
		t.Fatalf("SEO response: status=%d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("X-Robots-Tag") != "noindex" {
		t.Fatal("reader SEO JSON must be noindexed")
	}
}

func TestHandlerRedirectsCanonicalProfilesAndReturnsGenerated404(t *testing.T) {
	handler := testHandler(t)
	for _, requestPath := range []string{
		"/katkida-bulunanlar/1",
		"/katkida-bulunanlar/1-old-slug",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, requestPath, nil))
		if response.Code != http.StatusMovedPermanently {
			t.Fatalf("%s status=%d", requestPath, response.Code)
		}
		if response.Header().Get("Location") != "/katkida-bulunanlar/1-test" {
			t.Fatalf("%s location=%q", requestPath, response.Header().Get("Location"))
		}
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(
		missing,
		httptest.NewRequest(http.MethodGet, "/dergiler/sayi999/1", nil),
	)
	if missing.Code != http.StatusNotFound || missing.Body.String() != "not found" {
		t.Fatalf("404 response: status=%d body=%q", missing.Code, missing.Body.String())
	}
}

func TestEmbeddedManifestBaseline(t *testing.T) {
	handler, err := NewEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	summary := handler.Manifest().Summary
	if summary.Magazines != 47 ||
		summary.PageVariants != 1824 ||
		summary.Works != 589 ||
		summary.Contributors != 130 ||
		summary.Recitations != 218 {
		t.Fatalf("unexpected generated baseline: %+v", summary)
	}
}

func TestEmbeddedRepresentativeRoutes(t *testing.T) {
	handler, err := NewEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	prefixes := []string{"/dergiler/", "/katkida-bulunanlar/"}
	for _, prefix := range prefixes {
		route := ""
		for candidate := range handler.Manifest().Routes {
			if strings.HasPrefix(candidate, prefix) {
				route = candidate
				break
			}
		}
		if route == "" {
			t.Fatalf("generated manifest has no %q route", prefix)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Code != http.StatusOK || response.Body.Len() == 0 {
			t.Fatalf(
				"%s response: status=%d bytes=%d",
				route,
				response.Code,
				response.Body.Len(),
			)
		}
	}
}
