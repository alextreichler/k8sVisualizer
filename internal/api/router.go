package api

import (
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/simulation"
	"github.com/alextreichler/k8svisualizer/internal/store"
)

// NewRouter wires all routes and returns a ready http.Handler.
// staticFS is the embedded (or OS) filesystem containing static assets.
func NewRouter(s *store.ClusterStore, broker *SSEBroker, staticFS fs.FS, cfg Config, engine *simulation.Engine) http.Handler {
	h := NewHandlers(s, broker, cfg, engine)
	mux := http.NewServeMux()

	// Static files — served from embedded FS, no disk access required.
	// noCacheOn404 prevents browsers from caching 404 responses across deployments.
	mux.Handle("/", noCacheOn404(http.FileServer(http.FS(staticFS))))

	// Graph
	mux.HandleFunc("/api/graph", h.HandleGraph)

	// Resources
	mux.HandleFunc("/api/resources", h.HandleResources)
	mux.HandleFunc("/api/resources/", h.HandleResource)

	// Edges
	mux.HandleFunc("/api/edges", h.HandleEdges)
	mux.HandleFunc("/api/edges/", h.HandleEdge)

	// Simulation endpoints
	mux.HandleFunc("/api/simulate/scale", h.HandleSimulateScale)
	mux.HandleFunc("/api/simulate/pod-phase", h.HandleSimulatePodPhase)
	mux.HandleFunc("/api/simulate/scenario", h.HandleSimulateScenario)
	mux.HandleFunc("/api/simulate/pvc-unbind", h.HandleSimulatePVCUnbind)
	mux.HandleFunc("/api/simulate/pvc-bind", h.HandleSimulatePVCBind)
	mux.HandleFunc("/api/simulate/bootstrap", h.HandleBootstrap)
	mux.HandleFunc("/api/simulate/failure", h.HandleSimulateFailure)
	mux.HandleFunc("/api/simulate/rolling-update", h.HandleSimulateRollingUpdate)
	mux.HandleFunc("/api/simulate/uninstall", h.HandleSimulateUninstall)
	mux.HandleFunc("/api/simulate/delete-namespace", h.HandleSimulateDeleteNamespace)
	mux.HandleFunc("/api/simulate/helm-apply", h.HandleSimulateHelmApply)
	mux.HandleFunc("/api/simulate/reset", h.HandleSimulateReset)
	mux.HandleFunc("/api/simulate/speed", h.HandleSimulateSpeed)

	// Versions
	mux.HandleFunc("/api/versions", h.HandleVersions)
	mux.HandleFunc("/api/versions/set", h.HandleSetVersion)
	mux.HandleFunc("/api/versions/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/features"):
			h.HandleVersionFeatures(w, r)
		case strings.HasSuffix(path, "/changelog"):
			h.HandleVersionChangelog(w, r)
		default:
			writeError(w, "not found", http.StatusNotFound)
		}
	})

	// SSE
	mux.HandleFunc("/api/events", h.HandleSSE)

	// CRD schemas (read-only, always available)
	mux.HandleFunc("/api/schemas", h.HandleSchemas)
	mux.HandleFunc("/api/schemas/", h.HandleSchemas)

	// Health — always available regardless of read-only mode
	mux.HandleFunc("/healthz", h.HandleHealth)

	// Build info — version string injected at build time
	mux.HandleFunc("/api/buildinfo", h.HandleBuildInfo)

	return loggingMiddleware(corsMiddleware(cfg, readOnlyMiddleware(cfg.ReadOnly, bodyLimitMiddleware(64*1024, mux))))
}

// bodyLimitMiddleware caps request body size to prevent large-payload abuse.
func bodyLimitMiddleware(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > limit {
			writeError(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}

func readOnlyMiddleware(enabled bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if enabled && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
			writeError(w, "server is in read-only mode", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func corsMiddleware(cfg Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(cfg.AllowedOrigins) == 0 {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else {
			origin := r.Header.Get("Origin")
			for _, allowed := range cfg.AllowedOrigins {
				if allowed == origin {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Vary", "Origin")
					break
				}
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// noCacheOn404 wraps a handler and adds Cache-Control: no-store to 404 responses,
// preventing browsers from caching missing-file errors across deployments.
func noCacheOn404(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nw := &notFoundCacheWriter{ResponseWriter: w}
		next.ServeHTTP(nw, r)
	})
}

type notFoundCacheWriter struct {
	http.ResponseWriter
}

func (w *notFoundCacheWriter) WriteHeader(code int) {
	if code == http.StatusNotFound {
		w.ResponseWriter.Header().Set("Cache-Control", "no-store")
	}
	w.ResponseWriter.WriteHeader(code)
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)
		// Only log API calls, not static assets
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %d %s", r.Method, r.URL.Path, rw.status, time.Since(start))
		}
	})
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.status = code
	rw.ResponseWriter.WriteHeader(code)
}

// Flush forwards to the underlying ResponseWriter if it supports http.Flusher.
// This is required for SSE to work through the logging middleware.
func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
