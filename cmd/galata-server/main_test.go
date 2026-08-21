package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/galata-dergisi/galata-dergisi/internal/application"
	"github.com/galata-dergisi/galata-dergisi/internal/site"
)

func TestProductionEnvironmentFileDiscoveryAndPrecedence(t *testing.T) {
	const fileKey = "GALATA_DOTENV_TEST_FILE"
	const existingKey = "GALATA_DOTENV_TEST_EXISTING"
	unsetEnvironmentForTest(t, fileKey)
	unsetEnvironmentForTest(t, existingKey)
	if err := os.Setenv(existingKey, "shell"); err != nil {
		t.Fatal(err)
	}

	directory := t.TempDir()
	t.Chdir(directory)
	environmentPath := filepath.Join(directory, productionEnvironmentFilename)
	contents := fileKey + "=from-file\n" + existingKey + "=from-file\n"
	if err := os.WriteFile(environmentPath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	loaded, err := loadProductionEnvironment(nil)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != productionEnvironmentFilename {
		t.Fatalf("loaded path=%q", loaded)
	}
	if actual := os.Getenv(fileKey); actual != "from-file" {
		t.Fatalf("file value=%q", actual)
	}
	if actual := os.Getenv(existingKey); actual != "shell" {
		t.Fatalf("shell value=%q", actual)
	}
}

func TestProductionEnvironmentFileMissingBehavior(t *testing.T) {
	t.Chdir(t.TempDir())
	loaded, err := loadProductionEnvironment(nil)
	if err != nil || loaded != "" {
		t.Fatalf("optional default loaded=%q err=%v", loaded, err)
	}

	missing := filepath.Join(t.TempDir(), "missing.env")
	_, err = loadProductionEnvironment([]string{"--env-file", missing})
	if err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("explicit missing error=%v", err)
	}
	if _, err := loadProductionEnvironment([]string{"--env-file="}); err == nil {
		t.Fatal("empty explicit env path must fail")
	}
}

func TestProductionEnvironmentFileExplicitPath(t *testing.T) {
	const key = "GALATA_DOTENV_TEST_EXPLICIT"
	unsetEnvironmentForTest(t, key)
	environmentPath := filepath.Join(t.TempDir(), "production.env")
	if err := os.WriteFile(environmentPath, []byte(key+"=loaded\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadProductionEnvironment([]string{"--env-file", environmentPath})
	if err != nil {
		t.Fatal(err)
	}
	if loaded != environmentPath || os.Getenv(key) != "loaded" {
		t.Fatalf("loaded=%q value=%q", loaded, os.Getenv(key))
	}
}

func unsetEnvironmentForTest(t *testing.T, key string) {
	t.Helper()
	original, existed := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if existed {
			_ = os.Setenv(key, original)
			return
		}
		_ = os.Unsetenv(key)
	})
}

func TestProductionApplicationRoutesHealthAndSite(t *testing.T) {
	staticSite, err := site.NewEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	handler, err := application.New(application.Config{
		Site:        staticSite,
		SiteRelease: staticSite.Release(),
	})
	if err != nil {
		t.Fatal(err)
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status=%d", health.Code)
	}
	var status struct {
		OK      bool   `json:"ok"`
		Release string `json:"release"`
	}
	if err := json.Unmarshal(health.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !status.OK || status.Release != staticSite.Release() {
		t.Fatalf("health response=%+v", status)
	}

	homepage := httptest.NewRecorder()
	handler.ServeHTTP(homepage, httptest.NewRequest(http.MethodGet, "/", nil))
	if homepage.Code != http.StatusOK || homepage.Body.Len() == 0 {
		t.Fatalf("homepage status=%d bytes=%d", homepage.Code, homepage.Body.Len())
	}

	retiredPage := httptest.NewRecorder()
	handler.ServeHTTP(
		retiredPage,
		httptest.NewRequest(http.MethodGet, "/katkida-bulunun", nil),
	)
	if retiredPage.Code != http.StatusNotFound {
		t.Fatalf("retired page status=%d", retiredPage.Code)
	}
	retiredPost := httptest.NewRecorder()
	handler.ServeHTTP(
		retiredPost,
		httptest.NewRequest(http.MethodPost, "/katkida-bulunun", nil),
	)
	if retiredPost.Code != http.StatusMethodNotAllowed {
		t.Fatalf("retired POST status=%d", retiredPost.Code)
	}

	devStatus := httptest.NewRecorder()
	handler.ServeHTTP(
		devStatus,
		httptest.NewRequest(http.MethodGet, "/__dev/status", nil),
	)
	if devStatus.Code != http.StatusNotFound {
		t.Fatalf("production dev status=%d", devStatus.Code)
	}

	externalMedia := httptest.NewRecorder()
	handler.ServeHTTP(
		externalMedia,
		httptest.NewRequest(
			http.MethodGet,
			"/images/sayi47/thumbnail.jpg",
			nil,
		),
	)
	if externalMedia.Code != http.StatusNotFound {
		t.Fatalf("production external media status=%d", externalMedia.Code)
	}
}
