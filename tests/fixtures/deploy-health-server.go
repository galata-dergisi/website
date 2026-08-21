package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

const siteRelease = "bbbbbbbbbbbbbbbb"

func main() {
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		log.Fatal("LISTEN_ADDR is required")
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
