package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/alextreichler/k8svisualizer/internal/store"
)

// HandleSimulateHelmApply handles POST /api/simulate/helm-apply
// Body: {"releaseName": "redpanda", "namespace": "redpanda", "chartPath": "redpanda-operator/charts/redpanda", "valuesYaml": "..."}
func (h *Handlers) HandleSimulateHelmApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ReleaseName string `json:"releaseName"`
		Namespace   string `json:"namespace"`
		ChartPath   string `json:"chartPath"`
		RepoURL     string `json:"repoUrl"`
		ValuesYaml  string `json:"valuesYaml"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Write values to a temporary file
	tmpDir, err := os.MkdirTemp("", "helm-apply")
	if err != nil {
		writeError(w, "failed to create temp dir: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(tmpDir)

	valuesFile := filepath.Join(tmpDir, "values.yaml")
	if err := os.WriteFile(valuesFile, []byte(body.ValuesYaml), 0644); err != nil {
		writeError(w, "failed to write values.yaml: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Run helm template
	args := []string{"template", body.ReleaseName, body.ChartPath, "-f", valuesFile, "--namespace", body.Namespace}
	if body.RepoURL != "" {
		args = append(args, "--repo", body.RepoURL)
	}

	cmd := exec.Command("helm", args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		writeError(w, "helm template failed: "+errBuf.String(), http.StatusBadRequest)
		return
	}

	// Clear existing namespace resources
	store.DeleteNamespace(h.store, body.Namespace)

	// Import rendered YAML
	nodes, err := store.ImportYAML(h.store, outBuf.Bytes(), body.Namespace)
	if err != nil {
		writeError(w, "failed to import yaml: "+err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, map[string]interface{}{
		"success": true,
		"nodes":   len(nodes),
	}, http.StatusOK)
}
