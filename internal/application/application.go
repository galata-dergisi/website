// Copyright 2026 Mehmet Baker
//
// Shared HTTP application routing used by the production and development
// binaries.
package application

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

type Config struct {
	Site            http.Handler
	SiteRelease     string
	ConfigureRoutes func(*http.ServeMux)
}

func New(config Config) (http.Handler, error) {
	if config.Site == nil {
		return nil, errors.New("site handler is required")
	}
	if config.SiteRelease == "" {
		return nil, errors.New("site release is required")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"ok": true, "release": config.SiteRelease,
		})
	})
	if config.ConfigureRoutes != nil {
		config.ConfigureRoutes(mux)
	}
	mux.Handle("/", config.Site)
	return mux, nil
}

type responseRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (recorder *responseRecorder) WriteHeader(status int) {
	if recorder.status != 0 {
		return
	}
	recorder.status = status
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *responseRecorder) Write(content []byte) (int, error) {
	if recorder.status == 0 {
		recorder.WriteHeader(http.StatusOK)
	}
	written, err := recorder.ResponseWriter.Write(content)
	recorder.bytes += written
	return written, err
}

func LogRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started := time.Now()
		recorder := &responseRecorder{ResponseWriter: writer}
		next.ServeHTTP(recorder, request)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		logger.Info(
			"http request",
			"method", request.Method,
			"path", request.URL.Path,
			"status", status,
			"bytes", recorder.bytes,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}
