package application

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutesHealthSiteAndContributions(t *testing.T) {
	contributionCalls := 0
	handler, err := New(Config{
		Site: http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			_, _ = writer.Write([]byte("site"))
		}),
		SiteRelease: "test-release",
		Contributions: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			contributionCalls++
			if request.Method != http.MethodPost {
				t.Fatalf("contribution method=%q", request.Method)
			}
			writer.WriteHeader(http.StatusCreated)
		}),
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
}

func TestOptionalRoutesDoNotAffectProductionFallback(t *testing.T) {
	handler, err := New(Config{
		Site:        http.NotFoundHandler(),
		SiteRelease: "release",
		Contributions: http.HandlerFunc(func(
			http.ResponseWriter,
			*http.Request,
		) {
		}),
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
