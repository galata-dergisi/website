// Copyright 2026 Mehmet Baker
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/galata-dergisi/galata-dergisi/internal/application"
	"github.com/galata-dergisi/galata-dergisi/internal/dotenv"
	"github.com/galata-dergisi/galata-dergisi/internal/site"
)

const productionEnvironmentFilename = ".env.production"

func loadProductionEnvironment(arguments []string) (string, error) {
	flags := flag.NewFlagSet("galata-server", flag.ContinueOnError)
	environmentFile := ""
	flags.StringVar(&environmentFile, "env-file", "", "production environment file")
	if err := flags.Parse(arguments); err != nil {
		return "", err
	}
	if flags.NArg() != 0 {
		return "", fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}

	explicit := false
	flags.Visit(func(option *flag.Flag) {
		if option.Name == "env-file" {
			explicit = true
		}
	})
	if explicit && environmentFile == "" {
		return "", errors.New("--env-file must not be empty")
	}
	if !explicit {
		environmentFile = productionEnvironmentFilename
	}

	loaded, err := dotenv.Load(environmentFile)
	if err != nil {
		return "", err
	}
	if explicit && loaded == "" {
		return "", fmt.Errorf("environment file does not exist: %s", environmentFile)
	}
	return loaded, nil
}

func run(arguments []string) error {
	if _, err := loadProductionEnvironment(arguments); err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	staticSite, err := site.NewEmbedded()
	if err != nil {
		return err
	}
	handler, err := application.New(application.Config{
		Site:        staticSite,
		SiteRelease: staticSite.Release(),
	})
	if err != nil {
		return err
	}

	address := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if address == "" {
		address = "0.0.0.0:3000"
	}
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
	go func() {
		signal := <-signals
		logger.Info("shutdown requested", "signal", signal.String())
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if shutdownErr := server.Shutdown(ctx); shutdownErr != nil {
			logger.Error("graceful shutdown failed", "error", shutdownErr)
		}
	}()

	logger.Info(
		"server starting",
		"address", address,
		"release", staticSite.Release(),
	)
	err = server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
