package store

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// ScaleStatefulSet adjusts the replica count of a StatefulSet, creating or
// deleting pod nodes (and associated storage for known patterns) to match.
func ScaleStatefulSet(s *ClusterStore, stsID string, target int) error {
	stsNode, ok := s.Get(stsID)
	if !ok {
		return fmt.Errorf("StatefulSet %q not found", stsID)
	}

	// 1. Update spec.replicas
	var stsSpec models.StatefulSetSpec
	if err := json.Unmarshal(stsNode.Spec, &stsSpec); err != nil {
		return fmt.Errorf("parse StatefulSet spec: %w", err)
	}
	stsSpec.Replicas = target
	stsNode.Spec, _ = json.Marshal(stsSpec)
	s.Update(stsNode)

	// 2. Find currently owned pods (sorted for stable ordinal ordering)
	podIDs := ownedOf(s, stsID, models.KindPod)
	sort.Strings(podIDs)
	current := len(podIDs)

	if target < current {
		// Scale DOWN: delete from highest ordinal first (real StatefulSet behaviour).
		// PVCs are intentionally retained — they survive pod deletion in real k8s.
		for _, podID := range podIDs[target:] {
			s.Delete(podID)
		}
	} else if target > current {
		// Scale UP: add pods.
		ns := stsNode.Namespace
		for i := current; i < target; i++ {
			if stsID == "sts-redpanda" {
				scaleUpRedpandaPod(s, stsID, ns, i)
			} else {
				pod := newGenericPod(
					fmt.Sprintf("pod-%s-%d", stsNode.Name, i),
					fmt.Sprintf("%s-%d", stsNode.Name, i),
					ns, stsID, stsNode.Labels,
				)
				s.Add(pod)
				s.AddEdge(edge(stsID, pod.ID, models.EdgeOwns, ""))
			}
		}
	}
	return nil
}

// ScaleDeployment adjusts the replica count of a Deployment, updating the
// child ReplicaSet and adding/removing pod nodes accordingly.
func ScaleDeployment(s *ClusterStore, deployID string, target int) error {
	deployNode, ok := s.Get(deployID)
	if !ok {
		return fmt.Errorf("Deployment %q not found", deployID)
	}

	// 1. Update Deployment spec
	var deploySpec models.DeploymentSpec
	if err := json.Unmarshal(deployNode.Spec, &deploySpec); err != nil {
		return fmt.Errorf("parse Deployment spec: %w", err)
	}
	deploySpec.Replicas = target
	deployNode.Spec, _ = json.Marshal(deploySpec)
	s.Update(deployNode)

	// 2. Update child ReplicaSet
	rsID := firstOwnedOf(s, deployID, models.KindReplicaSet)
	if rsID != "" {
		if rsNode, ok := s.Get(rsID); ok {
			var rsSpec models.ReplicaSetSpec
			if err := json.Unmarshal(rsNode.Spec, &rsSpec); err == nil {
				rsSpec.Replicas = target
				rsNode.Spec, _ = json.Marshal(rsSpec)
				s.Update(rsNode)
			}
		}
	}

	// 3. Find RS's pods, add/remove to match target
	ownerID := rsID
	if ownerID == "" {
		ownerID = deployID // fallback if no RS
	}
	podIDs := ownedOf(s, ownerID, models.KindPod)
	sort.Strings(podIDs)
	current := len(podIDs)

	if target < current {
		for _, podID := range podIDs[target:] {
			s.Delete(podID)
		}
	} else if target > current {
		for i := current; i < target; i++ {
			pod := newGenericPod(
				fmt.Sprintf("pod-%s-%d", deployNode.Name, i),
				fmt.Sprintf("%s-%05d", deployNode.Name, i),
				deployNode.Namespace, ownerID, deployNode.Labels,
			)
			s.Add(pod)
			s.AddEdge(edge(ownerID, pod.ID, models.EdgeOwns, ""))
		}
	}
	return nil
}

// DeleteNamespace deletes every node whose namespace matches ns.
// Cascades to edges automatically via s.Delete.
func DeleteNamespace(s *ClusterStore, ns string) {
	// Collect IDs first (can't modify the map while ranging it under the lock)
	s.mu.RLock()
	nsKey := ns
	if nsKey == "" {
		nsKey = "__cluster__"
	}
	ids := make([]string, 0, len(s.byNamespace[nsKey]))
	for id := range s.byNamespace[nsKey] {
		ids = append(ids, id)
	}
	s.mu.RUnlock()

	for _, id := range ids {
		s.Delete(id)
	}
}

// ---- internal helpers ----

// ownedOf returns the IDs of all nodes of a given kind with an `owns` edge
// originating from ownerID.
func ownedOf(s *ClusterStore, ownerID, kind string) []string {
	var ids []string
	for _, e := range s.EdgesForNode(ownerID) {
		if e.Type == models.EdgeOwns && e.Source == ownerID {
			if child, ok := s.Get(e.Target); ok && child.Kind == kind {
				ids = append(ids, e.Target)
			}
		}
	}
	return ids
}

// firstOwnedOf returns the first node ID of a given kind owned by ownerID.
func firstOwnedOf(s *ClusterStore, ownerID, kind string) string {
	ids := ownedOf(s, ownerID, kind)
	if len(ids) > 0 {
		return ids[0]
	}
	return ""
}

// scaleUpRedpandaPod creates a new Redpanda broker pod with matching PVC and PV.
func scaleUpRedpandaPod(s *ClusterStore, stsID, ns string, ordinal int) {
	podID := fmt.Sprintf("pod-redpanda-%d", ordinal)
	pvcID := fmt.Sprintf("pvc-redpanda-%d", ordinal)
	pvID  := fmt.Sprintf("pv-redpanda-%d", ordinal)

	// PV (cluster-scoped)
	pv := node(pvID, models.KindPV, "v1", fmt.Sprintf("pv-redpanda-%d", ordinal), "",
		nil, spec(models.PVSpec{Capacity: "20Gi", AccessModes: []string{"ReadWriteOnce"}}))
	s.Add(pv)

	// PVC
	pvc := node(pvcID, models.KindPVC, "v1", fmt.Sprintf("datadir-redpanda-%d", ordinal), ns,
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.PVCSpec{AccessModes: []string{"ReadWriteOnce"}, Requests: "20Gi"}))
	pvc.Status = statusJSON(map[string]string{"phase": "Bound"})
	s.Add(pvc)
	s.AddEdge(edge(pvcID, pvID, models.EdgeBound, ""))

	// Pod
	pod := redpandaBrokerPod(podID, fmt.Sprintf("redpanda-%d", ordinal),
		stsID, "cm-redpanda", "secret-redpanda-users", pvcID)
	s.Add(pod)
	s.AddEdge(edge(stsID, podID, models.EdgeOwns, ""))
	s.AddEdge(edge(podID, pvcID, models.EdgeMounts, "datadir"))
	s.AddEdge(edge(podID, "cm-redpanda", models.EdgeMounts, "config"))
	s.AddEdge(edge(podID, "secret-redpanda-users", models.EdgeMounts, "sasl"))
	if _, ok := s.Get("svc-redpanda-headless"); ok {
		s.AddEdge(edge("svc-redpanda-headless", podID, models.EdgeSelects, ""))
	}
	if _, ok := s.Get("svc-redpanda-external"); ok {
		s.AddEdge(edge("svc-redpanda-external", podID, models.EdgeSelects, ""))
	}
}

// newGenericPod creates a simple Pending pod for scale-up of unknown workloads.
func newGenericPod(id, name, ns, ownerID string, lbl map[string]string) *models.Node {
	ps := models.PodSpec{Phase: models.PodPending, OwnerRef: ownerID, Labels: lbl}
	n := node(id, models.KindPod, "v1", name, ns, lbl, spec(ps))
	n.SimPhase = string(models.PodPending)
	n.Status = statusJSON(map[string]string{"phase": "Pending"})
	return n
}
