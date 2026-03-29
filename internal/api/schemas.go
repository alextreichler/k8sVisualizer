package api

import (
	"net/http"
	"strings"

	"github.com/alextreichler/k8svisualizer/internal/schemas"
)

// HandleSchemas handles:
//
//	GET /api/schemas              → index of all available CRDs and their versions
//	GET /api/schemas/{Kind}       → schema for the latest version of that Kind
//	GET /api/schemas/{Kind}?version=v24.3.1 → schema for a specific version
func (h *Handlers) HandleSchemas(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Strip "/api/schemas" prefix and split the remaining path.
	rest := strings.TrimPrefix(r.URL.Path, "/api/schemas")
	rest = strings.Trim(rest, "/")

	// No kind specified → return index.
	if rest == "" {
		idx := schemas.GetIndex()
		if idx == nil {
			writeError(w, "schema index not available", http.StatusNotFound)
			return
		}
		writeJSON(w, idx, http.StatusOK)
		return
	}

	kind := rest
	version := r.URL.Query().Get("version") // empty = latest

	schema, err := schemas.Get(kind, version)
	if err != nil {
		writeError(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, schema, http.StatusOK)
}
