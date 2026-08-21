package application

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutesHealthAndSite(t *testing.T) {
	handler, err := New(Config{
		Site: http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte("site"))
		}),
		SiteRelease: "test-release",
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
	if !status.OK || status.Release != "test-release" {
		t.Fatalf("health response=%+v", status)
	}

	homepage := httptest.NewRecorder()
	handler.ServeHTTP(homepage, httptest.NewRequest(http.MethodGet, "/", nil))
	if homepage.Code != http.StatusOK || homepage.Body.String() != "site" {
		t.Fatalf("homepage status=%d body=%q", homepage.Code, homepage.Body.String())
	}
}

func TestOptionalRoutesDoNotAffectProductionFallback(t *testing.T) {
	handler, err := New(Config{
		Site:        http.NotFoundHandler(),
		SiteRelease: "release",
		ConfigureRoutes: func(mux *http.ServeMux) {
			mux.HandleFunc("GET /optional", func(writer http.ResponseWriter, _ *http.Request) {
				writer.WriteHeader(http.StatusNoContent)
			})
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/optional", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("optional status=%d", response.Code)
	}
}
