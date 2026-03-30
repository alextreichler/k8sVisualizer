package api

import (
	"encoding/json"
	"net/http"

	"github.com/alextreichler/k8svisualizer/internal/models"
	"github.com/alextreichler/k8svisualizer/internal/store"
)

// HandleSimulateScale handles POST /api/simulate/scale.
// Body: {"resourceID": "...", "replicas": 5}
func (h *Handlers) HandleSimulateScale(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ResourceID string `json:"resourceID"`
		Replicas   int    `json:"replicas"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.Replicas < 0 {
		writeError(w, "replicas must be >= 0", http.StatusBadRequest)
		return
	}

	n, ok := h.store.Get(body.ResourceID)
	if !ok {
		writeError(w, "resource not found", http.StatusNotFound)
		return
	}
	if n.Kind != models.KindDeployment && n.Kind != models.KindStatefulSet {
		writeError(w, "only Deployment and StatefulSet support scaling", http.StatusBadRequest)
		return
	}

	var scaleErr error
	switch n.Kind {
	case models.KindDeployment:
		scaleErr = store.ScaleDeployment(h.store, body.ResourceID, body.Replicas)
	case models.KindStatefulSet:
		scaleErr = store.ScaleStatefulSet(h.store, body.ResourceID, body.Replicas)
	}
	if scaleErr != nil {
		writeError(w, "scale failed: "+scaleErr.Error(), http.StatusInternalServerError)
		return
	}

	n, _ = h.store.Get(body.ResourceID)
	writeJSON(w, n, http.StatusOK)
}

// HandleSimulatePodPhase handles POST /api/simulate/pod-phase.
// Body: {"resourceID": "...", "phase": "Running"}
func (h *Handlers) HandleSimulatePodPhase(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		ResourceID string `json:"resourceID"`
		Phase      string `json:"phase"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	n, ok := h.store.Get(body.ResourceID)
	if !ok {
		writeError(w, "resource not found", http.StatusNotFound)
		return
	}
	if n.Kind != models.KindPod {
		writeError(w, "only Pod supports phase override", http.StatusBadRequest)
		return
	}

	phase := models.PodPhase(body.Phase)
	switch phase {
	case models.PodPending, models.PodRunning, models.PodFailed, models.PodSucceeded, models.PodTerminating:
	default:
		writeError(w, "invalid phase", http.StatusBadRequest)
		return
	}

	n.SimPhase = string(phase)
	n.TickCount = 0
	var ps models.PodSpec
	if err := json.Unmarshal(n.Spec, &ps); err == nil {
		ps.Phase = phase
		n.Spec, _ = json.Marshal(ps)
	}
	n.Status, _ = json.Marshal(map[string]string{"phase": string(phase)})
	h.store.Update(n)
	writeJSON(w, n, http.StatusOK)
}

// HandleSimulateScenario handles POST /api/simulate/scenario.
// Body: {"name": "redpanda-helm"}
// Starts the named scenario in a background goroutine; returns immediately.
func (h *Handlers) HandleSimulateScenario(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Name            string `json:"name"`
		OperatorVersion string `json:"operatorVersion"` // "flux" | "direct" (default: "direct")
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !h.incScenarios() {
		writeError(w, "too many concurrent scenarios, try again later", http.StatusTooManyRequests)
		return
	}

	broker := h.broker
	onStep := func(i, total int, label string) {
		broker.Publish(models.SSEEvent{
			Type:    models.EventScenarioStep,
			Payload: mustMarshal(map[string]any{"step": i, "total": total, "label": label}),
		})
	}

	run := func(fn func()) {
		go func() {
			defer h.decScenarios()
			fn()
		}()
	}

	switch body.Name {
	case "redpanda-helm":
		useFlux := body.OperatorVersion == "flux"
		run(func() { store.RunRedpandaHelmScenario(h.store, "cp-apiserver", useFlux, onStep) })
	case "cert-manager":
		run(func() { store.RunCertManagerScenario(h.store, "cp-apiserver", onStep) })
	case "argocd":
		run(func() { store.RunArgoCDScenario(h.store, "cp-apiserver", onStep) })
	case "rbac":
		run(func() { store.RunRBACScenario(h.store, "cp-apiserver", onStep) })
	case "hpa-demo":
		run(func() { store.RunHPAScenario(h.store, "cp-apiserver", onStep) })
	case "node-drain":
		run(func() { store.RunNodeDrainScenario(h.store, "cp-apiserver", onStep) })
	default:
		h.decScenarios()
		writeError(w, "unknown scenario: "+body.Name, http.StatusBadRequest)
		return
	}

	writeJSON(w, map[string]any{"started": true, "scenario": body.Name}, http.StatusOK)
}

// HandleSimulatePVCUnbind handles POST /api/simulate/pvc-unbind.
// Body: {"pvcID": "..."}
// Removes the bound edge, sets the PVC to Pending and the PV to Released,
// simulating what `kubectl patch pv <pv> --type=json -p '[{"op":"remove","path":"/spec/claimRef"}]'` does.
func (h *Handlers) HandleSimulatePVCUnbind(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PVCID string `json:"pvcID"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	pvc, ok := h.store.Get(body.PVCID)
	if !ok {
		writeError(w, "PVC not found", http.StatusNotFound)
		return
	}
	if pvc.Kind != models.KindPVC {
		writeError(w, "resource is not a PVC", http.StatusBadRequest)
		return
	}

	// Find the bound PV by looking for a 'bound' edge from this PVC
	boundEdgeID := ""
	pvID := ""
	for _, e := range h.store.EdgesForNode(body.PVCID) {
		if e.Type == models.EdgeBound && e.Source == body.PVCID {
			boundEdgeID = e.ID
			pvID = e.Target
			break
		}
	}

	// Remove the bound edge
	if boundEdgeID != "" {
		h.store.RemoveEdge(boundEdgeID)
	}

	// Set PVC → Pending
	pvc.Status, _ = json.Marshal(models.PVCStatus{Phase: models.PVCPending})
	h.store.Update(pvc)

	// Set PV → Released (if found)
	if pvID != "" {
		if pv, ok := h.store.Get(pvID); ok {
			pv.Status, _ = json.Marshal(models.PVStatus{Phase: models.PVReleased})
			h.store.Update(pv)
		}
	}

	writeJSON(w, map[string]any{"unbound": true, "pvcID": body.PVCID, "pvID": pvID}, http.StatusOK)
}

// HandleSimulatePVCBind handles POST /api/simulate/pvc-bind.
// Body: {"pvcID": "...", "pvID": "..."}
func (h *Handlers) HandleSimulatePVCBind(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		PVCID string `json:"pvcID"`
		PVID  string `json:"pvID"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	pvc, ok := h.store.Get(body.PVCID)
	if !ok {
		writeError(w, "PVC not found", http.StatusNotFound)
		return
	}
	pv, ok := h.store.Get(body.PVID)
	if !ok {
		writeError(w, "PV not found", http.StatusNotFound)
		return
	}

	pvc.Status, _ = json.Marshal(models.PVCStatus{Phase: models.PVCBound, BoundPVI: body.PVID})
	pv.Status, _ = json.Marshal(models.PVStatus{Phase: models.PVBound, BoundPVCID: body.PVCID})
	h.store.Update(pvc)
	h.store.Update(pv)

	edgeID := store.EdgeID(body.PVCID, body.PVID, models.EdgeBound)
	h.store.AddEdge(&models.Edge{
		ID:     edgeID,
		Source: body.PVCID,
		Target: body.PVID,
		Type:   models.EdgeBound,
	})

	writeJSON(w, map[string]any{"pvc": pvc, "pv": pv}, http.StatusOK)
}

// HandleBootstrap handles POST /api/simulate/bootstrap.
// Body: {"action": "coredns" | "kube-proxy"}
// Progressively adds the named cluster component in a background goroutine.
func (h *Handlers) HandleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Action   string `json:"action"`
		Plugin   string `json:"plugin"`   // for "cni": flannel / calico / cilium
		Provider string `json:"provider"` // for "managed": eks / gke / aks
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	broker := h.broker
	onStep := func(i, total int, label string) {
		broker.Publish(models.SSEEvent{
			Type:    models.EventScenarioStep,
			Payload: mustMarshal(map[string]any{"step": i, "total": total, "label": label}),
		})
	}

	switch body.Action {
	case "controlplane":
		go store.BootstrapControlPlane(h.store, h.store.ActiveVersion, onStep)
	case "coredns":
		go store.BootstrapCoreDNS(h.store, onStep)
	case "kube-proxy":
		go store.BootstrapKubeProxy(h.store, onStep)
	case "cni":
		plugin := body.Plugin
		if plugin == "" {
			plugin = "flannel"
		}
		go store.BootstrapCNI(h.store, plugin, onStep)
	case "nodelocaldns":
		go store.BootstrapNodeLocalDNS(h.store, onStep)
	case "managed":
		go store.BootstrapManaged(h.store, body.Provider, h.store.ActiveVersion, onStep)
	case "k3s":
		go store.BootstrapK3s(h.store, h.store.ActiveVersion, onStep)
	case "ha":
		go store.BootstrapHA(h.store, h.store.ActiveVersion, onStep)
	case "worker-nodes":
		go store.BootstrapWorkerNodes(h.store, h.store.ActiveVersion, onStep)
	default:
		writeError(w, "unknown action: "+body.Action, http.StatusBadRequest)
		return
	}

	writeJSON(w, map[string]any{"started": true, "action": body.Action}, http.StatusOK)
}

// HandleSimulateFailure handles POST /api/simulate/failure.
// Body: {"type": "crash-loop|image-pull-backoff|oom-killed", "resourceID": "pod-..."}
func (h *Handlers) HandleSimulateFailure(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Type       string `json:"type"`
		ResourceID string `json:"resourceID"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	broker := h.broker
	onStep := func(i, total int, label string) {
		broker.Publish(models.SSEEvent{
			Type:    models.EventScenarioStep,
			Payload: mustMarshal(map[string]any{"step": i, "total": total, "label": label}),
		})
	}

	var runFn func() error
	switch body.Type {
	case "crash-loop":
		runFn = func() error { return store.SimulateCrashLoop(h.store, body.ResourceID, onStep) }
	case "image-pull-backoff":
		runFn = func() error { return store.SimulateImagePullBackOff(h.store, body.ResourceID, onStep) }
	case "oom-killed":
		runFn = func() error { return store.SimulateOOMKill(h.store, body.ResourceID, onStep) }
	case "node-not-ready":
		runFn = func() error { return store.SimulateNodeNotReady(h.store, body.ResourceID, onStep) }
	case "liveness-probe":
		runFn = func() error { return store.SimulateLivenessProbeFailure(h.store, body.ResourceID, onStep) }
	default:
		writeError(w, "unknown failure type: "+body.Type, http.StatusBadRequest)
		return
	}

	go func() {
		if err := runFn(); err != nil {
			onStep(1, 1, "Error: "+err.Error())
		}
	}()

	writeJSON(w, map[string]any{"started": true, "type": body.Type}, http.StatusOK)
}

// HandleSimulateRollingUpdate handles POST /api/simulate/rolling-update.
func (h *Handlers) HandleSimulateRollingUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	broker := h.broker
	go func() {
		err := store.SimulateRollingUpdate(h.store, func(i, total int, label string) {
			broker.Publish(models.SSEEvent{
				Type:    models.EventScenarioStep,
				Payload: mustMarshal(map[string]any{"step": i, "total": total, "label": label}),
			})
		})
		if err != nil {
			broker.Publish(models.SSEEvent{
				Type:    models.EventScenarioStep,
				Payload: mustMarshal(map[string]any{"step": 1, "total": 1, "label": "Error: " + err.Error()}),
			})
		}
	}()
	writeJSON(w, map[string]any{"started": true}, http.StatusOK)
}

// HandleSimulateUninstall handles POST /api/simulate/uninstall.
// Body: {"release": "redpanda"} or {"release": "redpanda-operator"}
// Deletes only the resources belonging to that Helm release, simulating `helm uninstall`.
// The shared namespace and other releases are left intact.
func (h *Handlers) HandleSimulateUninstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Release string `json:"release"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	switch body.Release {
	case "redpanda", "redpanda-operator":
		store.UninstallRelease(h.store, body.Release)
	default:
		writeError(w, "unknown release: "+body.Release, http.StatusBadRequest)
		return
	}

	writeJSON(w, map[string]any{"uninstalled": true, "release": body.Release}, http.StatusOK)
}

// HandleSimulateDeleteNamespace handles POST /api/simulate/delete-namespace.
// Body: {"namespace": "redpanda"}
// Deletes all resources in the namespace, simulating `kubectl delete namespace <name>`.
func (h *Handlers) HandleSimulateDeleteNamespace(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Namespace string `json:"namespace"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}
	if body.Namespace == "" {
		writeError(w, "namespace is required", http.StatusBadRequest)
		return
	}
	store.DeleteNamespace(h.store, body.Namespace)
	writeJSON(w, map[string]any{"deleted": true, "namespace": body.Namespace}, http.StatusOK)
}
