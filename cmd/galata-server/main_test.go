package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mehmetb/galata-dergisi/internal/application"
	"github.com/mehmetb/galata-dergisi/internal/site"
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

func TestRequiredEnvironmentRejectsBlankValues(t *testing.T) {
	const key = "GALATA_REQUIRED_ENV_TEST"
	t.Setenv(key, "  ")
	if _, err := requiredEnvironment(key); err == nil {
		t.Fatal("blank required environment must fail")
	}
	t.Setenv(key, " value ")
	value, err := requiredEnvironment(key)
	if err != nil || value != "value" {
		t.Fatalf("value=%q err=%v", value, err)
	}
}

func TestParseAllowedHostnames(t *testing.T) {
	hostnames, err := parseAllowedHostnames("galatadergisi.org, www.galatadergisi.org")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(hostnames, ",") != "galatadergisi.org,www.galatadergisi.org" {
		t.Fatalf("hostnames=%q", hostnames)
	}

	invalid := []string{
		"", "*", "*.galatadergisi.org", "DEV.galatadergisi.org",
		"dev.galatadergisi.org,dev.galatadergisi.org", ".galatadergisi.org",
		"dev.galatadergisi.org.", "-dev.galatadergisi.org", "dev_.galatadergisi.org",
		"dev.galatadergisi.org,,galatadergisi.org",
	}
	for _, value := range invalid {
		if _, err := parseAllowedHostnames(value); err == nil {
			t.Errorf("parseAllowedHostnames(%q) unexpectedly succeeded", value)
		}
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

func TestProductionApplicationRoutesHealthSiteAndContributions(t *testing.T) {
	staticSite, err := site.NewEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	contributionCalls := 0
	contributionHandler := http.HandlerFunc(func(
		writer http.ResponseWriter,
		request *http.Request,
	) {
		contributionCalls++
		if request.Method != http.MethodPost {
			t.Fatalf("contribution method=%q", request.Method)
		}
		writer.WriteHeader(http.StatusCreated)
	})
	handler, err := application.New(application.Config{
		Site:          staticSite,
		SiteRelease:   staticSite.Release(),
		Contributions: contributionHandler,
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

	contribution := httptest.NewRecorder()
	handler.ServeHTTP(
		contribution,
		httptest.NewRequest(http.MethodPost, "/katkida-bulunun", nil),
	)
	if contribution.Code != http.StatusCreated || contributionCalls != 1 {
		t.Fatalf(
			"contribution status=%d calls=%d",
			contribution.Code,
			contributionCalls,
		)
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
