package store

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// SimulateCrashLoop makes a running pod enter CrashLoopBackOff with exponential backoff.
func SimulateCrashLoop(s *ClusterStore, podID string, onStep func(i, total int, label string)) error {
	pod, ok := s.Get(podID)
	if !ok {
		return fmt.Errorf("pod %q not found", podID)
	}
	if pod.Kind != models.KindPod {
		return fmt.Errorf("%q is not a Pod", podID)
	}
	podName := pod.Name

	const total = 11
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, fmt.Sprintf("  Warning  BackOff    pod/%s  container 'redpanda' exited with code 1", podName), func() {
		setPodSimPhase(s, pod, string(models.PodFailed), "Failed", "Error", "container exited with non-zero exit code")
	})
	step(2, 800*time.Millisecond, fmt.Sprintf("  Warning  BackOff    pod/%s  Back-off restarting failed container", podName), func() {
		setPodSimPhase(s, pod, "CrashLoopBackOff", "Failed", "CrashLoopBackOff", "back-off restarting failed container")
	})
	step(3, 1500*time.Millisecond, fmt.Sprintf("  Normal   Pulling    pod/%s  Pulling image (restart #1, backoff: 10s)...", podName), func() {
		setPodSimPhase(s, pod, "ContainerCreating", "Pending", "ContainerCreating", "")
	})
	step(4, 1200*time.Millisecond, fmt.Sprintf("  Warning  BackOff    pod/%s  Back-off 20s restarting failed container (restart #2)", podName), func() {
		setPodSimPhase(s, pod, "CrashLoopBackOff", "Failed", "CrashLoopBackOff", "back-off 20s restarting failed container")
	})
	step(5, 2500*time.Millisecond, fmt.Sprintf("  Warning  BackOff    pod/%s  Back-off 40s restarting (restart #3)", podName), nil)
	step(6, 500*time.Millisecond,  fmt.Sprintf("  Warning  BackOff    pod/%s  Back-off 1m20s restarting (restart #4 — exponential backoff)", podName), nil)
	step(7, 300*time.Millisecond, "──────────────────────────────────────────────────────", nil)
	step(8, 100*time.Millisecond, "Why CrashLoopBackOff? Kubernetes keeps trying but backs off exponentially (10s→20s→40s→80s...) to avoid thrashing.", nil)
	step(9, 0, "Diagnose: check logs from the *previous* container crash:", nil)
	step(10, 0, fmt.Sprintf("  $ kubectl logs %s -n %s --previous", podName, pod.Namespace), nil)
	step(11, 0, "Common causes: bad config, missing env var / secret key, wrong entrypoint, OOMKilled", nil)

	return nil
}

// SimulateImagePullBackOff makes a pod fail with ImagePullBackOff.
func SimulateImagePullBackOff(s *ClusterStore, podID string, onStep func(i, total int, label string)) error {
	pod, ok := s.Get(podID)
	if !ok {
		return fmt.Errorf("pod %q not found", podID)
	}
	if pod.Kind != models.KindPod {
		return fmt.Errorf("%q is not a Pod", podID)
	}
	podName := pod.Name

	const total = 10
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, fmt.Sprintf("  Normal   Pulling    pod/%s  Pulling image 'docker.redpanda.com/redpandadata/redpanda:v99.9.9'", podName), func() {
		setPodSimPhase(s, pod, "ContainerCreating", "Pending", "ContainerCreating", "pulling image")
	})
	step(2, 1200*time.Millisecond, fmt.Sprintf("  Warning  Failed     pod/%s  Failed to pull image: 404 Not Found — tag does not exist in registry", podName), func() {
		setPodSimPhase(s, pod, "ImagePullBackOff", "Pending", "ImagePullBackOff", "Back-off pulling image: 404 Not Found")
	})
	step(3, 1500*time.Millisecond, fmt.Sprintf("  Warning  BackOff    pod/%s  Back-off pulling image (retry in 10s)...", podName), nil)
	step(4, 2000*time.Millisecond, fmt.Sprintf("  Warning  BackOff    pod/%s  Back-off pulling image (retry in 20s)...", podName), nil)
	step(5, 300*time.Millisecond, "──────────────────────────────────────────────────────", nil)
	step(6, 100*time.Millisecond, "Why ImagePullBackOff? The image tag does not exist in the container registry.", nil)
	step(7, 0, "Diagnose:", nil)
	step(8, 0, fmt.Sprintf("  $ kubectl describe pod %s -n %s | grep -A10 Events:", podName, pod.Namespace), nil)
	step(9, 0, "Fix: correct the image tag and upgrade:", nil)
	step(10, 0, "  $ helm upgrade redpanda redpanda/redpanda --set image.tag=v24.3.1 -n redpanda", nil)

	return nil
}

// SimulateOOMKill makes a pod appear OOMKilled, then restart and recover.
func SimulateOOMKill(s *ClusterStore, podID string, onStep func(i, total int, label string)) error {
	pod, ok := s.Get(podID)
	if !ok {
		return fmt.Errorf("pod %q not found", podID)
	}
	if pod.Kind != models.KindPod {
		return fmt.Errorf("%q is not a Pod", podID)
	}
	podName := pod.Name

	const total = 10
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, fmt.Sprintf("  Warning  OOMKilling pod/%s  container 'redpanda' — memory limit 1Gi exceeded (tried to allocate 1.3Gi)", podName), func() {
		setPodSimPhase(s, pod, "OOMKilled", "Failed", "OOMKilled", "Container was OOM killed. Limit: 1Gi")
	})
	step(2, 800*time.Millisecond, fmt.Sprintf("  Normal   BackOff    pod/%s  Kubelet restarting container (OOMKill restart count: 1)", podName), func() {
		setPodSimPhase(s, pod, "ContainerCreating", "Pending", "ContainerCreating", "")
	})
	step(3, 1200*time.Millisecond, fmt.Sprintf("  Normal   Started    pod/%s  Container started successfully — for now (root cause not fixed!)", podName), func() {
		setPodSimPhase(s, pod, string(models.PodRunning), "Running", "", "")
		var ps models.PodSpec
		if err := json.Unmarshal(pod.Spec, &ps); err == nil {
			ps.Phase = models.PodRunning
			pod.Spec, _ = json.Marshal(ps)
		}
		s.Update(pod)
	})
	step(4, 400*time.Millisecond, "⚠ Warning: container will OOMKill again once memory usage climbs — root cause not fixed!", nil)
	step(5, 200*time.Millisecond, "──────────────────────────────────────────────────────", nil)
	step(6, 100*time.Millisecond, "Why OOMKilled? Container used more RAM than resources.limits.memory allows.", nil)
	step(7, 0, "Diagnose — check actual memory usage:", nil)
	step(8, 0, fmt.Sprintf("  $ kubectl top pod %s -n %s", podName, pod.Namespace), nil)
	step(9, 0, "Fix: increase limit in Helm values and upgrade:", nil)
	step(10, 0, "  $ helm upgrade redpanda redpanda/redpanda --set resources.limits.memory=4Gi -n redpanda", nil)

	return nil
}

// SimulateRollingUpdate upgrades the Redpanda cluster from v24.3.1 → v24.3.2.
// Pods restart in reverse ordinal order (2→1→0), matching real StatefulSet rolling-update behavior.
func SimulateRollingUpdate(s *ClusterStore, onStep func(i, total int, label string)) error {
	if _, ok := s.Get("sts-redpanda"); !ok {
		return fmt.Errorf("sts-redpanda not found — deploy Redpanda first")
	}

	const total = 20
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, "$ helm upgrade redpanda redpanda/redpanda --set image.tag=v24.3.2 -n redpanda", nil)
	step(2, 500*time.Millisecond, "Release 'redpanda' has been upgraded. Happy Helming!", nil)
	step(3, 300*time.Millisecond, "StatefulSet: updateStrategy=RollingUpdate  (default partition=0)", nil)
	step(4, 200*time.Millisecond, "Rolling update order: HIGHEST ordinal first (2→1→0) — safe for Raft leader migration", nil)

	// Pods restart in reverse order: 2 → 1 → 0
	for i := 2; i >= 0; i-- {
		ii := i
		podID   := fmt.Sprintf("pod-redpanda-%d", ii)
		podName := fmt.Sprintf("redpanda-%d", ii)
		pvcID   := fmt.Sprintf("pvc-redpanda-%d", ii)
		stepBase := 5 + (2-ii)*4

		step(stepBase, 300*time.Millisecond, fmt.Sprintf("  pod/%s: Terminating (graceful shutdown, SIGTERM → drain connections)...", podName), func() {
			if pod, ok := s.Get(podID); ok {
				setPodSimPhase(s, pod, string(models.PodTerminating), "Terminating", "", "")
			}
		})

		step(stepBase+1, 1000*time.Millisecond, fmt.Sprintf("  pod/%s: deleted — StatefulSet controller creating replacement with v24.3.2", podName), func() {
			s.Delete(podID)
			pod := redpandaBrokerPod(podID, podName, "sts-redpanda", "cm-redpanda", "secret-redpanda-users", pvcID)
			// Patch image to new version
			var ps models.PodSpec
			if err := json.Unmarshal(pod.Spec, &ps); err == nil {
				for idx := range ps.Containers {
					ps.Containers[idx].Image = "docker.redpanda.com/redpandadata/redpanda:v24.3.2"
				}
				pod.Spec, _ = json.Marshal(ps)
			}
			pod.SimPhase = "ContainerCreating"
			pod.Status, _ = json.Marshal(map[string]string{"phase": "Pending", "reason": "ContainerCreating"})
			s.Add(pod)
			s.AddEdge(edge("sts-redpanda", podID, models.EdgeOwns, ""))
			s.AddEdge(edge(podID, pvcID, models.EdgeMounts, "datadir"))
			s.AddEdge(edge(podID, "cm-redpanda", models.EdgeMounts, "config"))
			s.AddEdge(edge(podID, "secret-redpanda-users", models.EdgeMounts, "sasl"))
			if _, ok := s.Get("svc-redpanda-headless"); ok {
				s.AddEdge(edge("svc-redpanda-headless", podID, models.EdgeSelects, ""))
			}
			if _, ok := s.Get("svc-redpanda-external"); ok {
				s.AddEdge(edge("svc-redpanda-external", podID, models.EdgeSelects, ""))
			}
		})

		step(stepBase+2, 1500*time.Millisecond, fmt.Sprintf("  pod/%s: Running ✓  (redpanda:v24.3.2)", podName), func() {
			if pod, ok := s.Get(podID); ok {
				setPodSimPhase(s, pod, string(models.PodRunning), "Running", "", "")
				var ps models.PodSpec
				if err := json.Unmarshal(pod.Spec, &ps); err == nil {
					ps.Phase = models.PodRunning
					pod.Spec, _ = json.Marshal(ps)
				}
				s.Update(pod)
			}
		})

		if ii > 0 {
			step(stepBase+3, 200*time.Millisecond, fmt.Sprintf("  pod/%s Ready — Raft leadership stable, proceeding to pod %d", podName, ii-1), nil)
		}
	}

	step(17, 300*time.Millisecond, "StatefulSet redpanda: 3/3 ready  (all brokers running v24.3.2)", nil)
	step(18, 200*time.Millisecond, "Rolling update complete ✓", nil)
	step(19, 200*time.Millisecond, "Tip: to verify → $ kubectl rollout status sts/redpanda -n redpanda", nil)
	step(20, 0, "Rollback if needed → $ helm rollback redpanda 1 -n redpanda", nil)

	return nil
}

// ---- internal helpers ----

// setPodSimPhase updates SimPhase + Status JSON without touching Spec (for transient states).
func setPodSimPhase(s *ClusterStore, pod *models.Node, simPhase, k8sPhase, reason, message string) {
	pod.SimPhase = simPhase
	statusMap := map[string]string{"phase": k8sPhase}
	if reason != "" {
		statusMap["reason"] = reason
	}
	if message != "" {
		statusMap["message"] = message
	}
	pod.Status, _ = json.Marshal(statusMap)
	s.Update(pod)
}

// SimulateNodeNotReady simulates a worker Node losing connectivity (kubelet stops heartbeating).
// Shows the Kubernetes node-controller eviction timeline with educational output.
func SimulateNodeNotReady(s *ClusterStore, nodeID string, onStep func(i, total int, label string)) error {
	n, ok := s.Get(nodeID)
	if !ok {
		return fmt.Errorf("node %q not found", nodeID)
	}
	if n.Kind != models.KindNode {
		return fmt.Errorf("%q is not a Node (kind=%s)", nodeID, n.Kind)
	}
	nodeName := n.Name

	const total = 13
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, fmt.Sprintf("  Warning  NodeNotReady  node/%s  kubelet stopped posting node status", nodeName), func() {
		n.Status, _ = json.Marshal(models.NodeStatus{Conditions: []string{"NotReady"}})
		if n.Annotations == nil {
			n.Annotations = make(map[string]string)
		}
		n.Annotations["k8svisualizer/warning"] = "Node is NotReady — kubelet heartbeat lost"
		s.Update(n)
	})
	step(2, 800*time.Millisecond, fmt.Sprintf("  Warning  NodeNotReady  node/%s  node-controller: node unreachable for >40s", nodeName), nil)
	step(3, 1200*time.Millisecond, fmt.Sprintf("  [node-controller] Tainting node/%s: node.kubernetes.io/not-ready:NoExecute", nodeName), nil)
	step(4, 500*time.Millisecond, "  [node-controller] Grace period: tolerationSeconds=300 (pods can declare toleration to delay eviction)", nil)
	step(5, 800*time.Millisecond, fmt.Sprintf("  [node-controller] Evicting all pods from node/%s (grace period elapsed)", nodeName), func() {
		// Evict all pods assigned to this node
		pods := collectPodsOnNode(s, nodeName)
		for _, pod := range pods {
			setPodSimPhase(s, pod, "Failed", "Failed", "NodeLost",
				fmt.Sprintf("The node %q is not Ready — pod evicted by node-controller", nodeName))
		}
	})
	step(6, 400*time.Millisecond, "──────────────────────────────────────────────────────", nil)
	step(7, 100*time.Millisecond, "Why? The kubelet heartbeats to kube-apiserver every 10s (nodeStatusUpdateFrequency).", nil)
	step(8, 0, "After 40s of silence (nodeMonitorGracePeriod), the node-controller marks it Unknown.", nil)
	step(9, 0, "After 5 min (podEvictionTimeout), pods are evicted and rescheduled on healthy nodes.", nil)
	step(10, 0, fmt.Sprintf("Diagnose: $ kubectl describe node %s | grep -A5 Conditions:", nodeName), nil)
	step(11, 0, fmt.Sprintf("          $ kubectl get events --field-selector=involvedObject.name=%s", nodeName), nil)
	step(12, 0, "Fix: SSH to node → check kubelet logs: $ journalctl -u kubelet -f --since='5m ago'", nil)
	step(13, 0, "     Restart kubelet: $ systemctl restart kubelet", nil)

	return nil
}

// SimulateLivenessProbeFailure simulates a pod's liveness probe failing 3 consecutive
// times (failureThreshold=3), causing the container to be restarted by the kubelet.
func SimulateLivenessProbeFailure(s *ClusterStore, podID string, onStep func(i, total int, label string)) error {
	pod, ok := s.Get(podID)
	if !ok {
		return fmt.Errorf("pod %q not found", podID)
	}
	if pod.Kind != models.KindPod {
		return fmt.Errorf("%q is not a Pod", podID)
	}
	podName := pod.Name

	const total = 13
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, fmt.Sprintf("  Warning  Unhealthy   pod/%s  Liveness probe failed: HTTP probe failed with statuscode: 500", podName), nil)
	step(2, 1200*time.Millisecond, fmt.Sprintf("  Warning  Unhealthy   pod/%s  Liveness probe failed (2/3): connection refused — app may be deadlocked", podName), nil)
	step(3, 1200*time.Millisecond, fmt.Sprintf("  Warning  Unhealthy   pod/%s  Liveness probe failed (3/3): failureThreshold reached", podName), nil)
	step(4, 500*time.Millisecond, fmt.Sprintf("  Warning  Killing     pod/%s  Stopping container — liveness probe threshold exceeded", podName), func() {
		setPodSimPhase(s, pod, "ContainerCreating", "Pending", "ContainerCreating", "liveness probe failed — container restarting")
	})
	step(5, 1500*time.Millisecond, fmt.Sprintf("  Normal   Pulled      pod/%s  Container image already present on node", podName), nil)
	step(6, 600*time.Millisecond, fmt.Sprintf("  Normal   Started     pod/%s  Container restarted (restartCount: 1) — liveness probe re-enabled", podName), func() {
		setPodSimPhase(s, pod, string(models.PodRunning), "Running", "", "")
		var ps models.PodSpec
		if err := json.Unmarshal(pod.Spec, &ps); err == nil {
			ps.Phase = models.PodRunning
			pod.Spec, _ = json.Marshal(ps)
		}
		var status map[string]interface{}
		if pod.Status != nil {
			json.Unmarshal(pod.Status, &status)
		}
		if status == nil {
			status = make(map[string]interface{})
		}
		restarts, _ := status["restartCount"].(float64)
		status["restartCount"] = int(restarts) + 1
		status["phase"] = "Running"
		pod.Status, _ = json.Marshal(status)
		s.Update(pod)
	})
	step(7, 200*time.Millisecond, "──────────────────────────────────────────────────────", nil)
	step(8, 100*time.Millisecond, "Why? Liveness probe failed failureThreshold (3) consecutive times.", nil)
	step(9, 0, "livenessProbe controls *container restart*. If it fails → kubelet kills + restarts the container.", nil)
	step(10, 0, "Contrast: readinessProbe controls *traffic routing* — a failing readinessProbe removes the pod from Service endpoints.", nil)
	step(11, 0, fmt.Sprintf("Diagnose: $ kubectl describe pod %s -n %s | grep -A10 'Liveness:'", podName, pod.Namespace), nil)
	step(12, 0, fmt.Sprintf("          $ kubectl logs %s -n %s --previous", podName, pod.Namespace), nil)
	step(13, 0, "Fix: Ensure app returns 2xx on the probe path, or tune initialDelaySeconds/failureThreshold.", nil)

	return nil
}

// collectPodsOnNode returns all pods whose PodSpec.NodeName matches nodeName.
func collectPodsOnNode(s *ClusterStore, nodeName string) []*models.Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []*models.Node
	for _, n := range s.nodes {
		if n.Kind != string(models.KindPod) {
			continue
		}
		var ps models.PodSpec
		if err := json.Unmarshal(n.Spec, &ps); err == nil && ps.NodeName == nodeName {
			out = append(out, n)
		}
	}
	return out
}
