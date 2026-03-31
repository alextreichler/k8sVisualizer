// Package simulation runs a background goroutine that simulates K8s controller
// behaviour: pod lifecycle transitions, deployment reconciliation, HPA scaling,
// and service selector synchronisation.
package simulation

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/store"
)

const tickInterval = 5 * time.Second

// Engine drives the simulation loop.
type Engine struct {
	store      *store.ClusterStore
	lifecycle  *Lifecycle
	reconciler *Reconciler
	tickNanos  atomic.Int64 // current tick duration in nanoseconds; 0 = use default
}

// New creates an Engine backed by the given store.
func New(s *store.ClusterStore) *Engine {
	e := &Engine{
		store:      s,
		lifecycle:  NewLifecycle(s),
		reconciler: NewReconciler(s),
	}
	e.tickNanos.Store(int64(tickInterval))
	return e
}

// SetSpeed adjusts the simulation tick rate. multiplier=1.0 is real-time (5s/tick),
// 2.0 doubles speed (2.5s/tick), 0.5 halves it (10s/tick). Clamped to [0.1, 10].
func (e *Engine) SetSpeed(multiplier float64) {
	if multiplier < 0.1 {
		multiplier = 0.1
	}
	if multiplier > 10 {
		multiplier = 10
	}
	e.tickNanos.Store(int64(float64(tickInterval) / multiplier))
}

// SpeedMultiplier returns the current speed multiplier (1.0 = normal).
func (e *Engine) SpeedMultiplier() float64 {
	ns := e.tickNanos.Load()
	if ns <= 0 {
		return 1.0
	}
	return float64(tickInterval) / float64(ns)
}

// Start launches the simulation loop; it returns when ctx is cancelled.
// Uses a per-iteration timer so SetSpeed takes effect on the next tick.
func (e *Engine) Start(ctx context.Context) {
	for {
		interval := time.Duration(e.tickNanos.Load())
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
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
