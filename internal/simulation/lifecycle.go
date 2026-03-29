package simulation

import (
	"encoding/json"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
	"github.com/alextreichler/k8svisualizer/internal/store"
)

// ticksToRunning is the number of simulation ticks a Pod stays Pending before Running.
const ticksToRunning = 2

// ticksToDeleted is the number of ticks a Pod stays Terminating before being removed.
const ticksToDeleted = 1

// Lifecycle manages Pod phase transitions.
type Lifecycle struct {
	store *store.ClusterStore
}

// NewLifecycle creates a Lifecycle for the given store.
func NewLifecycle(s *store.ClusterStore) *Lifecycle {
	return &Lifecycle{store: s}
}

// Tick advances all pod lifecycle states by one tick.
func (l *Lifecycle) Tick() {
	pods := l.store.FilterByKind(models.KindPod)
	for _, pod := range pods {
		switch pod.SimPhase {
		case string(models.PodPending):
			pod.TickCount++
			if pod.TickCount >= ticksToRunning {
				l.transitionPod(pod, models.PodRunning)
			} else {
				l.store.Update(pod)
			}
		case string(models.PodTerminating):
			pod.TickCount++
			if pod.TickCount >= ticksToDeleted {
				l.store.Delete(pod.ID)
			} else {
				l.store.Update(pod)
			}
		case "CrashLoopBackOff":
			// Simulate growing restart count (every 3 ticks ≈ every 15 seconds)
			pod.TickCount++
			if pod.TickCount%3 == 0 {
				var status map[string]interface{}
				if pod.Status != nil {
					json.Unmarshal(pod.Status, &status)
				}
				if status == nil {
					status = make(map[string]interface{})
				}
				restarts, _ := status["restartCount"].(float64)
				status["restartCount"] = int(restarts) + 1
				pod.Status, _ = json.Marshal(status)
				l.store.Update(pod)
			}
		}
	}
}

// transitionPod moves a pod to a new phase and saves it.
func (l *Lifecycle) transitionPod(pod *models.Node, phase models.PodPhase) {
	pod.SimPhase = string(phase)
	pod.TickCount = 0

	// Update the embedded PodSpec.Phase too so the JSON matches.
	var ps models.PodSpec
	if err := json.Unmarshal(pod.Spec, &ps); err == nil {
		ps.Phase = phase
		pod.Spec, _ = json.Marshal(ps)
	}
	pod.Status, _ = json.Marshal(map[string]any{
		"phase":     string(phase),
		"startTime": time.Now().Format(time.RFC3339),
	})

	l.store.Update(pod)
}

// TerminatePod marks a pod as Terminating (called by the reconciler when scaling down).
func TerminatePod(s *store.ClusterStore, pod *models.Node) {
	pod.SimPhase = string(models.PodTerminating)
	pod.TickCount = 0

	var ps models.PodSpec
	if err := json.Unmarshal(pod.Spec, &ps); err == nil {
		ps.Phase = models.PodTerminating
		pod.Spec, _ = json.Marshal(ps)
	}
	pod.Status, _ = json.Marshal(map[string]any{"phase": string(models.PodTerminating)})
	s.Update(pod)
}
