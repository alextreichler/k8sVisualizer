package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
	"github.com/alextreichler/k8svisualizer/internal/store"
)

// HandleResources handles GET /api/resources and POST /api/resources.
func (h *Handlers) HandleResources(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listResources(w, r)
	case http.MethodPost:
		h.createResource(w, r)
	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleResource handles GET/PUT/DELETE /api/resources/{id}.
func (h *Handlers) HandleResource(w http.ResponseWriter, r *http.Request) {
	id := resourceIDFromPath(r.URL.Path)
	if !isValidResourceID(id) {
		writeError(w, "invalid resource id", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.getResource(w, r, id)
	case http.MethodPut:
		h.updateResource(w, r, id)
	case http.MethodDelete:
		h.deleteResource(w, r, id)
	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleEdges handles GET /api/edges and POST /api/edges.
func (h *Handlers) HandleEdges(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, h.store.ListEdges(), http.StatusOK)
	case http.MethodPost:
		var e models.Edge
		if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
			writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
			return
		}
		if e.ID == "" {
			e.ID = store.EdgeID(e.Source, e.Target, e.Type)
		}
		h.store.AddEdge(&e)
		writeJSON(w, e, http.StatusCreated)
	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleEdge handles DELETE /api/edges/{id}.
func (h *Handlers) HandleEdge(w http.ResponseWriter, r *http.Request) {
	id := resourceIDFromPath(r.URL.Path)
	if !isValidResourceID(id) {
		writeError(w, "invalid edge id", http.StatusBadRequest)
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	h.store.RemoveEdge(id)
	w.WriteHeader(http.StatusNoContent)
}

// --- private helpers ---

func (h *Handlers) listResources(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kind := q.Get("kind")
	namespace := q.Get("namespace")

	var nodes []*models.Node
	switch {
	case kind != "" && namespace != "":
		nodes = h.store.FilterByKindAndNamespace(kind, namespace)
	case kind != "":
		nodes = h.store.FilterByKind(kind)
	case namespace != "":
		nodes = h.store.FilterByNamespace(namespace)
	default:
		nodes = h.store.List()
	}
	writeJSON(w, nodes, http.StatusOK)
}

func (h *Handlers) getResource(w http.ResponseWriter, r *http.Request, id string) {
	n, ok := h.store.Get(id)
	if !ok {
		writeError(w, "not found", http.StatusNotFound)
		return
	}
	writeJSON(w, n, http.StatusOK)
}

func (h *Handlers) createResource(w http.ResponseWriter, r *http.Request) {
	var n models.Node
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if n.Kind == "" || n.Name == "" {
		writeError(w, "kind and name are required", http.StatusBadRequest)
		return
	}
	if n.ID == "" {
		n.ID = generateID(n.Kind, n.Name)
	}
	n.ObjectMeta.CreatedAt = time.Now()
	h.store.Add(&n)
	// Trigger async side-effects (e.g. LoadBalancer IP assignment).
	go store.OnServiceCreated(h.store, &n)
	w.Header().Set("Location", "/api/resources/"+n.ID)
	writeJSON(w, n, http.StatusCreated)
}

func (h *Handlers) updateResource(w http.ResponseWriter, r *http.Request, id string) {
	_, ok := h.store.Get(id)
	if !ok {
		writeError(w, "not found", http.StatusNotFound)
		return
	}
	var n models.Node
	if err := json.NewDecoder(r.Body).Decode(&n); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	n.ID = id
	h.store.Update(&n)
	writeJSON(w, n, http.StatusOK)
}

func (h *Handlers) deleteResource(w http.ResponseWriter, _ *http.Request, id string) {
	deleted, ok := h.store.Get(id)
	if !ok {
		writeError(w, "not found", http.StatusNotFound)
		return
	}
	h.store.Delete(id)
	// Simulate downstream effects of removing critical infrastructure components.
	go store.CascadeOnDelete(h.store, deleted)
	w.WriteHeader(http.StatusNoContent)
}

// --- shared response helpers ---

func writeJSON(w http.ResponseWriter, v any, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, msg string, status int) {
	writeJSON(w, map[string]string{"error": msg}, status)
}

func resourceIDFromPath(path string) string {
	parts := strings.Split(strings.TrimSuffix(path, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

// isValidResourceID checks that an ID contains only safe characters and is
// within the 253-character DNS subdomain length limit (same constraint Kubernetes uses).
func isValidResourceID(id string) bool {
	if id == "" || len(id) > 253 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			return false
		}
	}
	return true
}

func generateID(kind, name string) string {
	return strings.ToLower(kind) + "-" + strings.ReplaceAll(name, "/", "-") + "-" + randomSuffix()
}

func randomSuffix() string {
	return fmt.Sprintf("%08x", uint32(time.Now().UnixNano()))
}
