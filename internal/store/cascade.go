package store

import (
	"encoding/json"
	"strings"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// CascadeOnDelete inspects the deleted node and triggers realistic downstream
// effects on other nodes in the cluster.
//
// Real-world semantics modelled:
//   - etcd deleted        → all workload pods fail (API server loses its datastore)
//   - kube-apiserver del  → all workload pods fail (control plane unavailable)
//   - CNI DaemonSet del   → all non-system pods get NetworkNotReady / Failed
//   - CNI pod deleted     → pods on the same implicit node become NetworkNotReady
//   - kube-proxy DS del   → pods stay running but get a warning annotation
func CascadeOnDelete(s *ClusterStore, deleted *models.Node) {
	name := deleted.Name
	kind := deleted.Kind

	switch {
	// ── PVC deleted: enforce PV reclaim policy ───────────────────────────────
	case kind == models.KindPVC:
		applyPVReclaimPolicy(s, deleted)

	// ── etcd or API server: entire cluster goes down ─────────────────────────
	case kind == string(models.KindControlPlaneComponent) &&
		(name == "etcd" || name == "kube-apiserver"):
		failWorkloadPods(s, nil, "NodeLost",
			"Control plane unavailable: "+name+" removed. "+
				"The API server has lost its backing store — no scheduling, no reconciliation.")

	// ── CNI DaemonSet removed: network plugin gone ───────────────────────────
	case kind == string(models.KindDaemonSet) && isCNIDaemonSet(name):
		failWorkloadPods(s, nil, "NetworkNotReady",
			"CNI plugin ("+name+") removed. All Pod network interfaces are now broken — "+
				"traffic between Pods and Services will fail.")

	// ── Individual CNI pod deleted: that node loses networking ───────────────
	case kind == string(models.KindPod) && isCNIPod(name):
		suffix := nodeIndexSuffix(name)
		failWorkloadPods(s, &suffix, "NetworkNotReady",
			"CNI pod on this node was removed. Pods sharing the same node "+
				"have lost their network plugin and cannot route traffic.")

	// ── kube-proxy DaemonSet: Services stop routing ──────────────────────────
	case kind == string(models.KindDaemonSet) && name == "kube-proxy":
		annotateWorkloadPods(s,
			"kube-proxy removed: iptables rules are stale — Service VIPs will stop routing traffic to Pods.")
	}
}

// ── helpers ──────────────────────────────────────────────────────────────────

func isCNIDaemonSet(name string) bool {
	return name == "kube-flannel-ds" || name == "kube-flannel" ||
		name == "calico-node" || name == "cilium"
}

func isCNIPod(name string) bool {
	for _, p := range []string{"kube-flannel-", "calico-node-", "cilium-"} {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// nodeIndexSuffix extracts the trailing node identifier from a CNI pod name.
// e.g. "kube-flannel-node2" → "node2"
func nodeIndexSuffix(name string) string {
	for _, p := range []string{"kube-flannel-", "calico-node-", "cilium-"} {
		if strings.HasPrefix(name, p) {
			return name[len(p):]
		}
	}
	return ""
}

// collectWorkloadPods returns non-kube-system pods, optionally filtered by a
// node-index suffix in their name. Caller must NOT hold the write lock.
func collectWorkloadPods(s *ClusterStore, nodeSuffix *string) []*models.Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*models.Node
	for _, n := range s.nodes {
		if n.Kind != string(models.KindPod) || n.Namespace == "kube-system" {
			continue
		}
		if nodeSuffix != nil && *nodeSuffix != "" {
			if !strings.HasSuffix(n.Name, *nodeSuffix) {
				continue
			}
		}
		out = append(out, n)
	}
	return out
}

// failWorkloadPods sets matching pods to Failed with the given reason/message.
// nodeSuffix may be nil to match all workload pods.
func failWorkloadPods(s *ClusterStore, nodeSuffix *string, reason, message string) {
	pods := collectWorkloadPods(s, nodeSuffix)
	for _, pod := range pods {
		pod.SimPhase = "Failed"
		pod.Status, _ = json.Marshal(map[string]string{
			"phase":   "Failed",
			"reason":  reason,
			"message": message,
		})
		s.Update(pod)
	}
}

// applyPVReclaimPolicy finds the PV bound to the deleted PVC and applies the
// reclaim policy: "Delete" removes the PV; "Retain" sets the PV to Released.
func applyPVReclaimPolicy(s *ClusterStore, pvc *models.Node) {
	// Find the bound PV via PVC status
	var pvcStatus models.PVCStatus
	if pvc.Status != nil {
		json.Unmarshal(pvc.Status, &pvcStatus)
	}
	pvID := pvcStatus.BoundPVI
	if pvID == "" {
		// Fall back to scanning edges (already held by caller outside lock)
		for _, e := range s.EdgesForNode(pvc.ID) {
			if e.Type == models.EdgeBound && e.Source == pvc.ID {
				pvID = e.Target
				break
			}
		}
	}
	if pvID == "" {
		return
	}

	pv, ok := s.Get(pvID)
	if !ok {
		return
	}

	var pvSpec models.PVSpec
	if pv.Spec != nil {
		json.Unmarshal(pv.Spec, &pvSpec)
	}

	switch pvSpec.ReclaimPolicy {
	case "Delete", "":
		// Default behaviour: delete the PV along with the PVC
		s.Delete(pvID)
	case "Retain":
		// Keep the PV but mark it Released (admin must manually reclaim)
		pv.Status, _ = json.Marshal(models.PVStatus{Phase: models.PVReleased})
		s.Update(pv)
	case "Recycle":
		// Scrub and make available again (deprecated in k8s but still modelled)
		pv.Status, _ = json.Marshal(models.PVStatus{Phase: models.PVAvailable})
		s.Update(pv)
	}
}

// annotateWorkloadPods adds a warning annotation to all workload pods without
// changing their phase (used for kube-proxy removal).
func annotateWorkloadPods(s *ClusterStore, message string) {
	pods := collectWorkloadPods(s, nil)
	for _, pod := range pods {
		if pod.Annotations == nil {
			pod.Annotations = map[string]string{}
		}
		pod.Annotations["k8svisualizer/warning"] = message
		s.Update(pod)
	}
}
