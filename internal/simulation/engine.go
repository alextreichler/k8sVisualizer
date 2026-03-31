// Package simulation runs a background goroutine that simulates K8s controller
// behaviour: pod lifecycle transitions, deployment reconciliation, HPA scaling,
// and service selector synchronisation.
package simulation

import (
	"context"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/store"
)

const tickInterval = 5 * time.Second

// Engine drives the simulation loop.
type Engine struct {
	store      *store.ClusterStore
	lifecycle  *Lifecycle
	reconciler *Reconciler
}

// New creates an Engine backed by the given store.
func New(s *store.ClusterStore) *Engine {
	return &Engine{
		store:      s,
		lifecycle:  NewLifecycle(s),
		reconciler: NewReconciler(s),
	}
}

// Start launches the simulation loop; it returns when ctx is cancelled.
func (e *Engine) Start(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			e.tick()
		}
	}
}

func (e *Engine) tick() {
	// Order matters: lifecycle first (pods may be deleted), then reconciler (creates new pods).
	e.lifecycle.Tick()
	e.reconciler.ReconcileDeployments()
	e.reconciler.ReconcileStatefulSets()
	e.reconciler.ReconcileDaemonSets()
	e.reconciler.ReconcilePVCs()
	e.reconciler.ReconcileHPAs()
	e.reconciler.ReconcileServiceSelectors()
	e.reconciler.ReconcileCronJobs()
	e.reconciler.ReconcileCustomResources()
	e.reconciler.ReconcileExternalAccess()
}
