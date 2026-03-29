package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/k8sversions"
	"github.com/alextreichler/k8svisualizer/internal/models"
)

// HandleVersions handles GET /api/versions.
func (h *Handlers) HandleVersions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, k8sversions.Summary(), http.StatusOK)
}

// HandleVersionFeatures handles GET /api/versions/{ver}/features.
func (h *Handlers) HandleVersionFeatures(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ver := versionFromPath(r.URL.Path)
	if !k8sversions.IsSupported(ver) {
		writeError(w, "unsupported version: "+ver, http.StatusBadRequest)
		return
	}
	writeJSON(w, k8sversions.AvailableKinds(ver), http.StatusOK)
}

// HandleVersionChangelog handles GET /api/versions/{ver}/changelog.
func (h *Handlers) HandleVersionChangelog(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ver := versionFromPath(r.URL.Path)
	if !k8sversions.IsSupported(ver) {
		writeError(w, "unsupported version: "+ver, http.StatusBadRequest)
		return
	}
	writeJSON(w, k8sversions.ChangelogFor(ver), http.StatusOK)
}

// HandleSetVersion handles POST /api/versions/set.
// Body: {"version": "1.25"}
func (h *Handlers) HandleSetVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !k8sversions.IsSupported(body.Version) {
		writeError(w, "unsupported version: "+body.Version, http.StatusBadRequest)
		return
	}

	// Reload cluster for the new version.
	h.store.Clear()
	h.store.ActiveVersion = body.Version

	// Publish version-changed event + new snapshot.
	snap := h.store.Snapshot("")
	payload, _ := json.Marshal(snap)
	h.broker.Publish(models.SSEEvent{
		Type:      models.EventVersionChanged,
		Timestamp: time.Now().UnixMilli(),
		Payload:   payload,
	})

	writeJSON(w, map[string]string{"version": body.Version}, http.StatusOK)
}

// HandleSimulateReset handles POST /api/simulate/reset.
func (h *Handlers) HandleSimulateReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ver := h.store.ActiveVersion
	if ver == "" {
		ver = k8sversions.DefaultVersion
	}
	h.store.Clear()
	h.store.ActiveVersion = ver

	snap := h.store.Snapshot("")
	payload, _ := json.Marshal(snap)
	h.broker.Publish(models.SSEEvent{
		Type:      models.EventSnapshot,
		Timestamp: time.Now().UnixMilli(),
		Payload:   payload,
	})
	w.WriteHeader(http.StatusNoContent)
}

func versionFromPath(path string) string {
	// /api/versions/{ver}/features  or  /api/versions/{ver}/changelog
	parts := strings.Split(strings.Trim(path, "/"), "/")
	// parts: ["api", "versions", "{ver}", "features|changelog"]
	if len(parts) >= 3 {
		return parts[2]
	}
	return ""
}
