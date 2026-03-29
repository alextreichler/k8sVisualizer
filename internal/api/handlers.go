package api

import (
	"net/http"
	"sync/atomic"

	"github.com/alextreichler/k8svisualizer/internal/store"
)

// Config holds server-wide security and operational settings.
// Values are populated from environment variables at startup.
type Config struct {
	// ReadOnly disables all mutating API endpoints (POST/PUT/DELETE).
	// Visitors can view the graph but cannot modify state.
	ReadOnly bool

	// AllowedOrigins is the list of origins permitted for CORS.
	// Empty slice means all origins are allowed ("*").
	AllowedOrigins []string

	// MaxSSEClients is the maximum number of concurrent SSE connections (0 = unlimited).
	MaxSSEClients int

	// MaxConcurrentScenarios caps how many scenario goroutines can run at once (0 = unlimited).
	MaxConcurrentScenarios int
}

// Handlers holds shared dependencies for all HTTP handlers.
type Handlers struct {
	store           *store.ClusterStore
	broker          *SSEBroker
	cfg             Config
	activeScenarios int32 // atomic counter
}

// NewHandlers creates a Handlers with the given dependencies.
func NewHandlers(s *store.ClusterStore, b *SSEBroker, cfg Config) *Handlers {
	return &Handlers{store: s, broker: b, cfg: cfg}
}

// incScenarios atomically increments the active scenario counter.
// Returns false if the cap is reached.
func (h *Handlers) incScenarios() bool {
	max := int32(h.cfg.MaxConcurrentScenarios)
	if max <= 0 {
		atomic.AddInt32(&h.activeScenarios, 1)
		return true
	}
	for {
		cur := atomic.LoadInt32(&h.activeScenarios)
		if cur >= max {
			return false
		}
		if atomic.CompareAndSwapInt32(&h.activeScenarios, cur, cur+1) {
			return true
		}
	}
}

func (h *Handlers) decScenarios() {
	atomic.AddInt32(&h.activeScenarios, -1)
}

// HandleHealth handles GET /healthz.
// Used by Kubernetes liveness and readiness probes.
func (h *Handlers) HandleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]string{"status": "ok"}, http.StatusOK)
}
