// Copyright 2026 Mehmet Baker
//
// Local development server. This command is intentionally separate from the
// release command and is never built by scripts/build-release.sh.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/galata-dergisi/galata-dergisi/internal/application"
	"github.com/galata-dergisi/galata-dergisi/internal/site"
)

var audioPathPattern = regexp.MustCompile(
	`^/magazines/sayi([1-9][0-9]*)/audio/(.+)$`,
)

var issueImagePathPattern = regexp.MustCompile(
	`^/images/sayi[1-9][0-9]*/`,
)

type developmentFiles struct {
	publicRoot string
	mediaRoot  string
	next       http.Handler
}

func unsafeRequestPath(request *http.Request) bool {
	escaped := request.URL.EscapedPath()
	if strings.Contains(escaped, `\`) {
		return true
	}
	decoded, err := url.PathUnescape(escaped)
	if err != nil || strings.Contains(decoded, `\`) || strings.ContainsRune(decoded, 0) {
		return true
	}
	for _, segment := range strings.Split(decoded, "/") {
		if segment == "." || segment == ".." {
			return true
		}
	}
	return false
}

func (handler developmentFiles) ServeHTTP(
	writer http.ResponseWriter,
	request *http.Request,
) {
	if unsafeRequestPath(request) {
		http.NotFound(writer, request)
		return
	}
	if request.URL.Path == "/__dev/status" ||
		request.URL.Path == "/healthz" {
		handler.next.ServeHTTP(writer, request)
		return
	}

	root := handler.publicRoot
	relative := strings.TrimPrefix(request.URL.Path, "/")
	if issueImagePathPattern.MatchString(request.URL.Path) {
		root = handler.mediaRoot
	}
	if matches := audioPathPattern.FindStringSubmatch(request.URL.Path); matches != nil {
		root = handler.mediaRoot
		relative = filepath.ToSlash(filepath.Join(
			"audio",
			"sayi"+matches[1],
			filepath.FromSlash(matches[2]),
		))
	}
	if relative == "" {
		handler.next.ServeHTTP(writer, request)
		return
	}

	filename := filepath.Join(root, filepath.FromSlash(relative))
	resolvedRoot, err := filepath.Abs(root)
	if err != nil {
		http.Error(writer, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	resolvedFile, err := filepath.Abs(filename)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	withinRoot, err := filepath.Rel(resolvedRoot, resolvedFile)
	if err != nil || withinRoot == ".." ||
		strings.HasPrefix(withinRoot, ".."+string(filepath.Separator)) {
		http.NotFound(writer, request)
		return
	}

	realRoot, err := filepath.EvalSymlinks(resolvedRoot)
	if err != nil {
		http.Error(writer, "Internal Server Error", http.StatusInternalServerError)
		return
	}
	realFile, err := filepath.EvalSymlinks(resolvedFile)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			handler.next.ServeHTTP(writer, request)
			return
		}
		http.NotFound(writer, request)
		return
	}
	withinRoot, err = filepath.Rel(realRoot, realFile)
	if err != nil || withinRoot == ".." ||
		strings.HasPrefix(withinRoot, ".."+string(filepath.Separator)) {
		http.NotFound(writer, request)
		return
	}

	file, err := os.Open(realFile)
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.NotFound(writer, request)
		return
	}
	if info.IsDir() {
		if strings.HasSuffix(request.URL.Path, "/") {
			http.NotFound(writer, request)
			return
		}
		handler.next.ServeHTTP(writer, request)
		return
	}
	if !info.Mode().IsRegular() {
		http.NotFound(writer, request)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.Header().Set("Allow", "GET, HEAD")
		http.Error(writer, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(writer, request, filepath.Base(resolvedFile), info.ModTime(), file)
}

type serverConfig struct {
	SiteRoot        string
	PublicRoot      string
	MediaRoot       string
	GenerationToken string
	ServerToken     string
}

func newDevelopmentHandler(config serverConfig) (http.Handler, error) {
	staticSite, err := site.New(os.DirFS(config.SiteRoot))
	if err != nil {
		return nil, err
	}
	app, err := application.New(application.Config{
		Site:        staticSite,
		SiteRelease: staticSite.Release(),
		ConfigureRoutes: func(mux *http.ServeMux) {
			mux.HandleFunc("/__dev/status", func(
				writer http.ResponseWriter,
				request *http.Request,
			) {
				if request.Method != http.MethodGet && request.Method != http.MethodHead {
					writer.Header().Set("Allow", "GET, HEAD")
					http.Error(writer, "Method Not Allowed", http.StatusMethodNotAllowed)
					return
				}
				writer.Header().Set("Cache-Control", "no-store")
				writer.Header().Set("Content-Type", "application/json; charset=utf-8")
				writer.Header().Set("X-Content-Type-Options", "nosniff")
				if request.Method == http.MethodHead {
					return
				}
				_ = json.NewEncoder(writer).Encode(map[string]string{
					"generation": config.GenerationToken,
					"server":     config.ServerToken,
				})
			})
		},
	})
	if err != nil {
		return nil, err
	}
	return developmentFiles{
		publicRoot: config.PublicRoot,
		mediaRoot:  config.MediaRoot,
		next:       app,
	}, nil
}

type options struct {
	port            int
	siteRoot        string
	publicRoot      string
	mediaRoot       string
	generationToken string
	serverToken     string
}

func parseOptions(arguments []string) (options, error) {
	var result options
	flags := flag.NewFlagSet("galata-dev", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.IntVar(&result.port, "port", 3000, "loopback HTTP port")
	flags.StringVar(&result.siteRoot, "site-root", "", "generated development site")
	flags.StringVar(&result.publicRoot, "public-root", "public", "built browser asset root")
	flags.StringVar(&result.mediaRoot, "media-root", "public", "local public/media root")
	flags.StringVar(
		&result.generationToken,
		"generation-token",
		"",
		"development site generation token",
	)
	flags.StringVar(
		&result.serverToken,
		"server-token",
		"",
		"development server incarnation token",
	)
	if err := flags.Parse(arguments); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 {
		return options{}, fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	if result.port < 1 || result.port > 65535 {
		return options{}, errors.New("--port must be between 1 and 65535")
	}
	if strings.TrimSpace(result.siteRoot) == "" {
		return options{}, errors.New("--site-root is required")
	}
	if strings.TrimSpace(result.generationToken) == "" {
		return options{}, errors.New("--generation-token is required")
	}
	if strings.TrimSpace(result.serverToken) == "" {
		return options{}, errors.New("--server-token is required")
	}
	return result, nil
}

func run(arguments []string) error {
	options, err := parseOptions(arguments)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	handler, err := newDevelopmentHandler(serverConfig{
		SiteRoot:        options.siteRoot,
		PublicRoot:      options.publicRoot,
		MediaRoot:       options.mediaRoot,
		GenerationToken: options.generationToken,
		ServerToken:     options.serverToken,
	})
	if err != nil {
		return err
	}
	address := "127.0.0.1:" + strconv.Itoa(options.port)
	server := &http.Server{
		Addr:              address,
		Handler:           application.LogRequests(logger, handler),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    64 * 1024,
		ErrorLog:          log.New(os.Stderr, "http: ", 0),
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		signal := <-signals
		logger.Info("shutdown requested", "signal", signal.String())
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if shutdownErr := server.Shutdown(ctx); shutdownErr != nil {
			logger.Error("graceful shutdown failed", "error", shutdownErr)
		}
	}()

	logger.Info(
		"development server starting",
		"address", address,
		"site_root", filepath.Clean(options.siteRoot),
		"public_root", filepath.Clean(options.publicRoot),
		"media_root", filepath.Clean(options.mediaRoot),
		"generation", options.generationToken,
		"server", options.serverToken,
	)
	err = server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("development server failed", "error", err)
		os.Exit(1)
	}
}
