package api

import (
	"net/http"
)

// HandleGraph handles GET /api/graph[?namespace=].
func (h *Handlers) HandleGraph(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	namespace := r.URL.Query().Get("namespace")
	snap := h.store.Snapshot(namespace)
	writeJSON(w, snap, http.StatusOK)
}
