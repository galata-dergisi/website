package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

const siteRelease = "bbbbbbbbbbbbbbbb"

func main() {
	address := os.Getenv("LISTEN_ADDR")
	contributionsDirectory := os.Getenv("CONTRIBUTIONS_DIR")
	if address == "" || contributionsDirectory == "" {
		log.Fatal("LISTEN_ADDR and CONTRIBUTIONS_DIR are required")
	}

	logPath := filepath.Join(contributionsDirectory, "test-listen-addresses")
	logFile, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := fmt.Fprintln(logFile, address); err != nil {
		log.Fatal(err)
	}
	if err := logFile.Close(); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(writer).Encode(map[string]any{
			"ok":      true,
			"release": siteRelease,
		}); err != nil {
			log.Printf("write health response: %v", err)
		}
	})

	log.Fatal(http.ListenAndServe(address, mux))
}
