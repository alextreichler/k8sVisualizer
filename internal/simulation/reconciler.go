package simulation

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
	"github.com/alextreichler/k8svisualizer/internal/store"
)

// Reconciler runs K8s-style controller reconciliation loops.
type Reconciler struct {
	store   *store.ClusterStore
	rng     *rand.Rand
	podSeq  int // monotonic counter for unique pod name suffixes
}

// NewReconciler creates a Reconciler for the given store.
func NewReconciler(s *store.ClusterStore) *Reconciler {
	return &Reconciler{
		store: s,
		rng:   rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

// ReconcileDeployments ensures each Deployment's pod count matches spec.replicas.
func (r *Reconciler) ReconcileDeployments() {
	deployments := r.store.FilterByKind(models.KindDeployment)
	for _, d := range deployments {
		var spec models.DeploymentSpec
		if err := json.Unmarshal(d.Spec, &spec); err != nil {
			continue
		}

		// Find the ReplicaSet owned by this Deployment
		rsEdges := r.store.EdgesOfType(d.ID, models.EdgeOwns)
		var rs *models.Node
		for _, e := range rsEdges {
			if n, ok := r.store.Get(e.Target); ok && n.Kind == models.KindReplicaSet {
				rs = n
				break
			}
		}

		if rs == nil {
			// Create the missing ReplicaSet
			rsID := fmt.Sprintf("rs-sim-%s", d.ID)
			rs = &models.Node{
				ID: rsID,
				TypeMeta: models.TypeMeta{
					APIVersion: "apps/v1",
					Kind:       models.KindReplicaSet,
				},
				ObjectMeta: models.ObjectMeta{
					Name:      fmt.Sprintf("%s-rs", d.Name),
					Namespace: d.Namespace,
					Labels:    spec.Selector,
				},
			}
			rsSpec := models.ReplicaSetSpec{
				Replicas: spec.Replicas,
				Selector: spec.Selector,
				OwnerRef: d.ID,
			}
			rs.Spec, _ = json.Marshal(rsSpec)
			r.store.Add(rs)
			r.store.AddEdge(&models.Edge{
				ID:     store.EdgeID(d.ID, rsID, models.EdgeOwns),
				Source: d.ID,
				Target: rsID,
				Type:   models.EdgeOwns,
			})
		}

		r.reconcileRS(rs, spec.Replicas, d)
	}
}

// ReconcileStatefulSets ensures each StatefulSet's pod count matches spec.replicas.
func (r *Reconciler) ReconcileStatefulSets() {
	sets := r.store.FilterByKind(models.KindStatefulSet)
	for _, ss := range sets {
		var spec models.StatefulSetSpec
		if err := json.Unmarshal(ss.Spec, &spec); err != nil {
			continue
		}
		r.reconcileOwner(ss, spec.Replicas, ss.Namespace,
			map[string]string{"app": ss.Name})
	}
}

// ReconcileDaemonSets ensures each DaemonSet's pod count matches a simulated node count.
func (r *Reconciler) ReconcileDaemonSets() {
	daemonsets := r.store.FilterByKind(models.KindDaemonSet)
	// We'll simulate a fixed cluster of 3 nodes for DaemonSets.
	const simulatedNodes = 3

	for _, ds := range daemonsets {
		var spec models.DaemonSetSpec
		if err := json.Unmarshal(ds.Spec, &spec); err != nil {
			continue
		}
		
		r.reconcileOwner(ds, simulatedNodes, ds.Namespace, spec.Selector)
		
		activePods := r.activePodsOwnedBy(ds.ID)
		actual := len(activePods)

		// Update DaemonSet status
		ds.Status, _ = json.Marshal(models.DaemonSetStatus{
			NumberReady:            min(actual, simulatedNodes),
			DesiredNumberScheduled: simulatedNodes,
		})
		r.store.Update(ds)
	}
}

// ReconcilePVCs simulates a dynamic storage provisioner.
// If a PVC is Pending and not bound, it creates a corresponding PV and binds them.
func (r *Reconciler) ReconcilePVCs() {
	pvcs := r.store.FilterByKind(models.KindPVC)
	for _, pvc := range pvcs {
		var status models.PVCStatus
		if pvc.Status != nil {
			json.Unmarshal(pvc.Status, &status)
		}

		if status.Phase != models.PVCBound {
			var spec models.PVCSpec
			if err := json.Unmarshal(pvc.Spec, &spec); err != nil {
				continue
			}

			// Simulate Provisioner: Create a PV
			pvName := fmt.Sprintf("pv-%s", pvc.Name)
			pvID := fmt.Sprintf("pv-sim-%s", pvc.ID)
			
			// Only create if we haven't already
			if _, exists := r.store.Get(pvID); !exists {
				// Ensure a StorageClass node exists to show the dynamic provisioner
				scName := spec.StorageClassName
				if scName == "" {
					scName = "standard" // default storage class
				}
				scID := "sc-" + scName
				if _, scExists := r.store.Get(scID); !scExists {
					sc := &models.Node{
						ID: scID,
						TypeMeta: models.TypeMeta{
							APIVersion: "storage.k8s.io/v1",
							Kind:       models.KindStorageClass,
						},
						ObjectMeta: models.ObjectMeta{
							Name: scName,
						},
					}
					r.store.Add(sc)
				}

				pv := &models.Node{
					ID: pvID,
					TypeMeta: models.TypeMeta{
						APIVersion: "v1",
						Kind:       models.KindPV,
					},
					ObjectMeta: models.ObjectMeta{
						Name: pvName,
					},
				}
				
				pvSpec := models.PVSpec{
					Capacity:      spec.Requests,
					AccessModes:   spec.AccessModes,
					ReclaimPolicy: "Delete",
				}
				pv.Spec, _ = json.Marshal(pvSpec)
				
				// Bind the PV to the PVC
				pvStatus := models.PVStatus{
					Phase:      models.PVBound,
					BoundPVCID: pvc.ID,
				}
				pv.Status, _ = json.Marshal(pvStatus)
				r.store.Add(pv)

				// The StorageClass provisioned the PV
				r.store.AddEdge(&models.Edge{
					ID:     store.EdgeID(scID, pvID, models.EdgeOwns),
					Source: scID,
					Target: pvID,
					Type:   models.EdgeOwns,
				})

				// Bind the PVC to the PV
				pvcStatus := models.PVCStatus{
					Phase:    models.PVCBound,
					BoundPVI: pvID,
				}
				pvc.Status, _ = json.Marshal(pvcStatus)
				r.store.Update(pvc)

				// Create the bound edge
				r.store.AddEdge(&models.Edge{
					ID:     store.EdgeID(pvc.ID, pvID, models.EdgeBound),
					Source: pvc.ID,
					Target: pvID,
					Type:   models.EdgeBound,
				})
			}
		}
	}
}

// reconcileRS reconciles pods owned by a ReplicaSet to match desired count.
func (r *Reconciler) reconcileRS(rs *models.Node, desired int, deploy *models.Node) {
	activePods := r.activePodsOwnedBy(rs.ID)
	actual := len(activePods)

	if actual < desired {
		// Scale up: create Pending pods
		for i := 0; i < desired-actual; i++ {
			r.createPod(rs, deploy)
		}
	} else if actual > desired {
		// Scale down: terminate excess (oldest first — already ordered by creation via map iteration, good enough)
		excess := actual - desired
		for i := 0; i < excess && i < len(activePods); i++ {
			TerminatePod(r.store, activePods[i])
		}
	}

	// Update RS status
	var rsSpec models.ReplicaSetSpec
	if err := json.Unmarshal(rs.Spec, &rsSpec); err == nil {
		rsSpec.Replicas = desired
		rs.Spec, _ = json.Marshal(rsSpec)
	}
	rs.Status, _ = json.Marshal(models.ReplicaSetStatus{
		Replicas:      desired,
		ReadyReplicas: min(desired, actual),
	})
	r.store.Update(rs)

	if deploy != nil {
		var dSpec models.DeploymentSpec
		if err := json.Unmarshal(deploy.Spec, &dSpec); err == nil {
			ready := min(desired, actual)
			deploy.Status, _ = json.Marshal(models.DeploymentStatus{
				Replicas:          desired,
				ReadyReplicas:     ready,
				AvailableReplicas: ready,
				UpdatedReplicas:   desired,
			})
			r.store.Update(deploy)
		}
	}
}

// reconcileOwner reconciles pods directly owned by a resource (StatefulSet, DaemonSet).
func (r *Reconciler) reconcileOwner(owner *models.Node, desired int, namespace string, podLabels map[string]string) {
	activePods := r.activePodsOwnedBy(owner.ID)
	actual := len(activePods)

	if actual < desired {
		for i := 0; i < desired-actual; i++ {
			r.createPodForOwner(owner, namespace, podLabels)
		}
	} else if actual > desired {
		excess := actual - desired
		for i := 0; i < excess && i < len(activePods); i++ {
			TerminatePod(r.store, activePods[i])
		}
	}
}

// ReconcileCustomResources simulates Operator loops reacting to CR changes.
func (r *Reconciler) ReconcileCustomResources() {
	crs := r.store.FilterByKind(models.KindCustomResource)
	for _, cr := range crs {
		if cr.APIVersion == "cluster.redpanda.com/v1alpha2" {
			var spec models.RedpandaClusterSpec
			if err := json.Unmarshal(cr.Spec, &spec); err != nil {
				continue
			}

			// Find the owned StatefulSet
			for _, edge := range r.store.EdgesOfType(cr.ID, models.EdgeOwns) {
				if sts, ok := r.store.Get(edge.Target); ok && sts.Kind == models.KindStatefulSet {
					var stsSpec models.StatefulSetSpec
					if err := json.Unmarshal(sts.Spec, &stsSpec); err == nil {
						if stsSpec.Replicas != spec.Replicas {
							stsSpec.Replicas = spec.Replicas
							sts.Spec, _ = json.Marshal(stsSpec)
							r.store.Update(sts)
						}
					}
				}
			}
		}
	}
}

// ReconcileHPAs simulates CPU metric random-walk and adjusts Deployment replicas.
func (r *Reconciler) ReconcileHPAs() {
	hpas := r.store.FilterByKind(models.KindHPA)
	for _, hpa := range hpas {
		var spec models.HPASpec
		if err := json.Unmarshal(hpa.Spec, &spec); err != nil {
			continue
		}
		var status models.HPAStatus
		if hpa.Status != nil {
			json.Unmarshal(hpa.Status, &status)
		}

		// Random-walk CPU: ±5% per tick, clamped 0-100
		delta := r.rng.Intn(11) - 5
		cpu := status.CurrentCPUUtilization + delta
		if cpu < 0 {
			cpu = 0
		}
		if cpu > 100 {
			cpu = 100
		}
		status.CurrentCPUUtilization = cpu

		// Find target deployment
		deploy, ok := r.store.Get(spec.ScaleTargetRef)
		if !ok {
			continue
		}
		var dSpec models.DeploymentSpec
		if err := json.Unmarshal(deploy.Spec, &dSpec); err != nil {
			continue
		}

		current := dSpec.Replicas
		newReplicas := current
		if cpu > spec.TargetCPUPercent*120/100 && current < spec.MaxReplicas {
			newReplicas = current + 1
		} else if cpu < spec.TargetCPUPercent*80/100 && current > spec.MinReplicas {
			newReplicas = current - 1
		}

		if newReplicas != current {
			dSpec.Replicas = newReplicas
			deploy.Spec, _ = json.Marshal(dSpec)
			r.store.Update(deploy)
		}

		status.CurrentReplicas = newReplicas
		hpa.Status, _ = json.Marshal(status)
		r.store.Update(hpa)
	}
}

// ReconcileServiceSelectors keeps EdgeSelects edges in sync with live pod labels.
func (r *Reconciler) ReconcileServiceSelectors() {
	services := r.store.FilterByKind(models.KindService)
	for _, svc := range services {
		var spec models.ServiceSpec
		if err := json.Unmarshal(svc.Spec, &spec); err != nil || len(spec.Selector) == 0 {
			continue
		}

		// Current EdgeSelects edges from this service
		existing := r.store.EdgesOfType(svc.ID, models.EdgeSelects)
		existingSet := make(map[string]struct{}, len(existing))
		for _, e := range existing {
			existingSet[e.Target] = struct{}{}
		}

		// Pods in the same namespace whose labels match
		matchingPods := r.store.LookupByLabels(spec.Selector)
		wantSet := make(map[string]struct{}, len(matchingPods))
		for _, p := range matchingPods {
			if p.Kind == models.KindPod && p.Namespace == svc.Namespace &&
				p.SimPhase != string(models.PodTerminating) {
				wantSet[p.ID] = struct{}{}
			}
		}

		// Add missing edges
		for podID := range wantSet {
			if _, exists := existingSet[podID]; !exists {
				r.store.AddEdge(&models.Edge{
					ID:     store.EdgeID(svc.ID, podID, models.EdgeSelects),
					Source: svc.ID,
					Target: podID,
					Type:   models.EdgeSelects,
				})
			}
		}

		// Remove stale edges
		for _, e := range existing {
			if _, wanted := wantSet[e.Target]; !wanted {
				r.store.RemoveEdge(e.ID)
			}
		}
	}
}

// --- helpers ---

// assignNodeToPod assigns a pod to the worker node with the fewest pods.
// If no Node resources exist in the store, the pod runs without node assignment
// (preserving existing behaviour before worker nodes are bootstrapped).
func (r *Reconciler) assignNodeToPod(pod *models.Node) {
	nodes := r.store.FilterByKind(models.KindNode)
	if len(nodes) == 0 {
		return
	}

	// Count active pods per node
	podCounts := make(map[string]int, len(nodes))
	for _, wn := range nodes {
		podCounts[wn.Name] = 0
	}
	for _, p := range r.store.FilterByKind(models.KindPod) {
		if p.SimPhase == string(models.PodTerminating) {
			continue
		}
		var ps models.PodSpec
		if err := json.Unmarshal(p.Spec, &ps); err == nil && ps.NodeName != "" {
			podCounts[ps.NodeName]++
		}
	}

	// Pick the node with fewest pods (bin-packing / least-loaded)
	var bestName string
	bestCount := math.MaxInt
	for _, wn := range nodes {
		cnt := podCounts[wn.Name]
		if cnt < bestCount {
			bestCount = cnt
			bestName = wn.Name
		}
	}

	if bestName == "" {
		return
	}

	var ps models.PodSpec
	if err := json.Unmarshal(pod.Spec, &ps); err == nil {
		ps.NodeName = bestName
		pod.Spec, _ = json.Marshal(ps)
	}
}

// activePodsOwnedBy returns non-Terminating pods owned by ownerID.
func (r *Reconciler) activePodsOwnedBy(ownerID string) []*models.Node {
	edges := r.store.EdgesOfType(ownerID, models.EdgeOwns)
	out := make([]*models.Node, 0, len(edges))
	for _, e := range edges {
		if n, ok := r.store.Get(e.Target); ok && n.Kind == models.KindPod &&
			n.SimPhase != string(models.PodTerminating) {
			out = append(out, n)
		}
	}
	return out
}

func (r *Reconciler) createPod(rs *models.Node, deploy *models.Node) {
	r.podSeq++
	suffix := fmt.Sprintf("%05d", r.podSeq)
	rsName := rs.Name
	if len(rsName) > 12 {
		rsName = rsName[:12]
	}

	var rsSpec models.ReplicaSetSpec
	json.Unmarshal(rs.Spec, &rsSpec)

	var tmpl models.PodTemplateSpec
	if deploy != nil {
		var dSpec models.DeploymentSpec
		json.Unmarshal(deploy.Spec, &dSpec)
		tmpl = dSpec.Template
	}

	podLabels := make(map[string]string)
	for k, v := range rsSpec.Selector {
		podLabels[k] = v
	}
	for k, v := range tmpl.Labels {
		podLabels[k] = v
	}

	ps := models.PodSpec{
		Phase:         models.PodPending,
		OwnerRef:      rs.ID,
		Labels:        podLabels,
		ConfigMapRefs: tmpl.ConfigMapRefs,
		SecretRefs:    tmpl.SecretRefs,
		PVCRefs:       tmpl.PVCRefs,
	}

	id := fmt.Sprintf("pod-sim-%s-%s", rs.ID, suffix)
	pod := &models.Node{
		ID:         id,
		TypeMeta:   models.TypeMeta{APIVersion: "v1", Kind: models.KindPod},
		ObjectMeta: models.ObjectMeta{Name: fmt.Sprintf("%s-%s", rsName, suffix), Namespace: rs.Namespace, Labels: podLabels},
		SimPhase:   string(models.PodPending),
	}
	pod.Spec, _ = json.Marshal(ps)
	pod.Status, _ = json.Marshal(map[string]any{"phase": string(models.PodPending), "startTime": time.Now().Format(time.RFC3339)})

	r.assignNodeToPod(pod)
	r.store.Add(pod)
	r.store.AddEdge(&models.Edge{
		ID:     store.EdgeID(rs.ID, pod.ID, models.EdgeOwns),
		Source: rs.ID,
		Target: pod.ID,
		Type:   models.EdgeOwns,
	})

	// Mount refs
	for _, cmID := range tmpl.ConfigMapRefs {
		r.store.AddEdge(&models.Edge{
			ID:     store.EdgeID(pod.ID, cmID, models.EdgeMounts),
			Source: pod.ID,
			Target: cmID,
			Type:   models.EdgeMounts,
		})
	}
	for _, secID := range tmpl.SecretRefs {
		r.store.AddEdge(&models.Edge{
			ID:     store.EdgeID(pod.ID, secID, models.EdgeMounts),
			Source: pod.ID,
			Target: secID,
			Type:   models.EdgeMounts,
		})
	}
}

func (r *Reconciler) createPodForOwner(owner *models.Node, namespace string, podLabels map[string]string) {
	r.podSeq++
	suffix := fmt.Sprintf("%05d", r.podSeq)
	ownerName := owner.Name
	if len(ownerName) > 12 {
		ownerName = ownerName[:12]
	}

	ps := models.PodSpec{
		Phase:    models.PodPending,
		OwnerRef: owner.ID,
		Labels:   podLabels,
	}

	id := fmt.Sprintf("pod-sim-%s-%s", owner.ID, suffix)
	pod := &models.Node{
		ID:         id,
		TypeMeta:   models.TypeMeta{APIVersion: "v1", Kind: models.KindPod},
		ObjectMeta: models.ObjectMeta{Name: fmt.Sprintf("%s-%s", ownerName, suffix), Namespace: namespace, Labels: podLabels},
		SimPhase:   string(models.PodPending),
	}
	pod.Spec, _ = json.Marshal(ps)
	pod.Status, _ = json.Marshal(map[string]any{"phase": string(models.PodPending), "startTime": time.Now().Format(time.RFC3339)})

	r.assignNodeToPod(pod)
	r.store.Add(pod)
	r.store.AddEdge(&models.Edge{
		ID:     store.EdgeID(owner.ID, pod.ID, models.EdgeOwns),
		Source: owner.ID,
		Target: pod.ID,
		Type:   models.EdgeOwns,
	})
}

// ReconcileCronJobs fires a new Job (and Pod) for each CronJob approximately
// once per simulated minute (every 12 ticks at 5s/tick = 60 seconds).
func (r *Reconciler) ReconcileCronJobs() {
	const ticksPerMinute = 12

	cronjobs := r.store.FilterByKind(models.KindCronJob)
	for _, cj := range cronjobs {
		cj.TickCount++
		if cj.TickCount%ticksPerMinute != 0 {
			r.store.Update(cj)
			continue
		}

		// Spawn a Job owned by this CronJob
		suffix := fmt.Sprintf("%x", r.rng.Uint32()&0xffffff)
		jobName := fmt.Sprintf("%s-%s", cj.Name, suffix)
		jobID := fmt.Sprintf("job-cron-%s-%s", cj.ID, suffix)

		job := &models.Node{
			ID:       jobID,
			TypeMeta: models.TypeMeta{APIVersion: "batch/v1", Kind: models.KindJob},
			ObjectMeta: models.ObjectMeta{
				Name:      jobName,
				Namespace: cj.Namespace,
				Labels:    map[string]string{"app": cj.Name, "job-name": jobName},
			},
			SimPhase: "Active",
		}
		job.Status, _ = json.Marshal(map[string]any{
			"active":    1,
			"startTime": time.Now().Format(time.RFC3339),
		})
		r.store.Add(job)
		r.store.AddEdge(&models.Edge{
			ID:     store.EdgeID(cj.ID, jobID, models.EdgeOwns),
			Source: cj.ID,
			Target: jobID,
			Type:   models.EdgeOwns,
		})

		// Spawn a Pod for the Job
		r.createPodForOwner(job, cj.Namespace, map[string]string{"app": cj.Name, "job-name": jobName})

		// Schedule Job completion after ~20 seconds
		go r.completeCronJob(jobID)

		// Update CronJob last-schedule annotation
		if cj.Annotations == nil {
			cj.Annotations = make(map[string]string)
		}
		cj.Annotations["k8svisualizer/last-schedule"] = time.Now().Format(time.RFC3339)
		r.store.Update(cj)
	}
}

// completeCronJob marks a Job as Succeeded and terminates its pods after a delay.
func (r *Reconciler) completeCronJob(jobID string) {
	time.Sleep(20 * time.Second)

	job, ok := r.store.Get(jobID)
	if !ok {
		return
	}
	job.SimPhase = "Complete"
	job.Status, _ = json.Marshal(map[string]any{
		"active":         0,
		"succeeded":      1,
		"completionTime": time.Now().Format(time.RFC3339),
	})
	r.store.Update(job)

	// Terminate owned pods
	for _, e := range r.store.EdgesOfType(jobID, models.EdgeOwns) {
		if pod, ok := r.store.Get(e.Target); ok && pod.Kind == models.KindPod {
			TerminatePod(r.store, pod)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
