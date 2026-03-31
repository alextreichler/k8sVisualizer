package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/alextreichler/k8svisualizer/internal/api"
	"github.com/alextreichler/k8svisualizer/internal/k8sversions"
	"github.com/alextreichler/k8svisualizer/internal/models"
	"github.com/alextreichler/k8svisualizer/internal/simulation"
	"github.com/alextreichler/k8svisualizer/internal/store"
)

//go:embed static
var staticFiles embed.FS

// Version is injected at build time via -ldflags "-X main.Version=v1.2.3"
var Version = "dev"

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
		log.Printf("warning: invalid value for %s, using default %d", key, def)
	}
	return def
}

func main() {
	port := flag.Int("port", 8090, "HTTP server port")
	version := flag.String("k8s-version", k8sversions.DefaultVersion, "Kubernetes version to simulate")
	mode := flag.String("mode", "none", "Startup mode: 'full' (full sample cluster), 'empty' (control plane only), or 'none' (completely empty)")
	flag.Parse()

	if !k8sversions.IsSupported(*version) {
		fmt.Fprintf(os.Stderr, "unsupported k8s version %q. Supported: %v\n",
			*version, k8sversions.SupportedVersions)
		os.Exit(1)
	}
	if *mode != "full" && *mode != "empty" && *mode != "none" {
		fmt.Fprintf(os.Stderr, "unsupported mode %q. Supported: full, empty, none\n", *mode)
		os.Exit(1)
	}

	// --- Store ---
	s := store.New()

	// --- Security config from environment ---
	cfg := api.Config{
		ReadOnly:               os.Getenv("READ_ONLY") == "true",
		MaxSSEClients:          envInt("MAX_SSE_CLIENTS", 100),
		MaxConcurrentScenarios: envInt("MAX_CONCURRENT_SCENARIOS", 3),
		Version:                Version,
	}
	if origins := os.Getenv("ALLOWED_ORIGINS"); origins != "" {
		cfg.AllowedOrigins = strings.Split(origins, ",")
	}
	if cfg.ReadOnly {
		log.Println("read-only mode enabled: all mutating endpoints are disabled")
	}
	if len(cfg.AllowedOrigins) > 0 {
		log.Printf("CORS restricted to origins: %v", cfg.AllowedOrigins)
	}

	// --- SSE Broker ---
	broker := api.NewSSEBroker(cfg.MaxSSEClients)

	// Wire store mutations to SSE broker
	s.OnChange = func(event models.SSEEvent) {
		broker.Publish(event)
	}

	// --- Bootstrap cluster ---
	if *mode == "empty" {
		store.LoadEmptyControlPlane(s, *version)
		log.Printf("empty mode: loaded control plane for K8s %s: %d resources, %d edges",
			*version, len(s.List()), len(s.ListEdges()))
	} else if *mode == "full" {
		store.LoadSampleState(s, *version)
		log.Printf("loaded sample cluster for K8s %s: %d resources, %d edges",
			*version, len(s.List()), len(s.ListEdges()))
	} else {
		s.ActiveVersion = *version
		log.Printf("none mode: loaded completely empty cluster for K8s %s", *version)
	}

	// --- Simulation engine ---
	engine := simulation.New(s)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go engine.Start(ctx)

	// --- HTTP router ---
	// Strip the "static/" prefix so files are served at "/" not "/static/".
	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatalf("failed to sub static FS: %v", err)
	}
	handler := api.NewRouter(s, broker, staticFS, cfg)

	addr := fmt.Sprintf(":%d", *port)
	srv := &http.Server{
		Addr:    addr,
		Handler: handler,
	}

	// Graceful shutdown on SIGTERM/SIGINT
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
		<-sig
		log.Println("shutting down...")
		cancel()
		srv.Shutdown(context.Background())
	}()

	log.Printf("k8sVisualizer listening on http://localhost%s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}
