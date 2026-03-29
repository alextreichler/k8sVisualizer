package store

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// RunRedpandaHelmScenario progressively recreates the full Redpanda deployment,
// mirroring a real `helm install` flow with CRDs, RBAC, and ordered pod startup.
// useFlux=true simulates the legacy v0.x operator path where FluxCD manages the
// HelmRelease; useFlux=false (default) uses the v2.x direct Go-based reconciler.
// onStep is called after each step so the caller can broadcast scenario.step events.
func RunRedpandaHelmScenario(s *ClusterStore, apiServerID string, useFlux bool, onStep func(i, total int, label string)) {
	// Base: 52 steps (includes post-install job for Layer 3 config)
	// flux path adds 3 extra steps (HelmRepository + HelmRelease + sync notice)
	// topic/user/schema CRs add 7 extra steps
	totalBase := 59
	if useFlux {
		totalBase = 62
	}
	total := totalBase

	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// ── Wipe existing redpanda nodes ──────────────────────────────────────
	for _, id := range []string{
		"pod-redpanda-0", "pod-redpanda-1", "pod-redpanda-2",
		"pvc-redpanda-0", "pvc-redpanda-1", "pvc-redpanda-2",
		"pv-redpanda-0", "pv-redpanda-1", "pv-redpanda-2",
		"svc-redpanda-headless", "svc-redpanda-external",
		"cm-redpanda", "secret-redpanda-users",
		"sts-redpanda", "cr-redpanda",
		"pod-redpanda-operator", "rs-redpanda-operator", "deploy-redpanda-operator",
		"ns-redpanda", "ns-redpanda-system",
		// post-install job and cluster config cm (Layer 3)
		"cm-redpanda-cluster-config", "job-post-install",
		// flux resources
		"helmrepo-redpanda", "helmrelease-redpanda",
		// topic/user/schema CRs
		"cr-topic-transactions", "cr-topic-audit-log",
		"cr-user-admin", "cr-schema-avro",
	} {
		s.Delete(id)
	}
	time.Sleep(250 * time.Millisecond)

	// ── Phase 1: helm repo setup ──────────────────────────────────────────
	step(1, 0, "$ helm repo add redpanda https://charts.redpanda.com", nil)
	step(2, 200*time.Millisecond, "Hang tight while we grab the latest from your chart repositories...", nil)
	step(3, 600*time.Millisecond, `Update complete. ⎈Happy Helming!⎈  — "redpanda" repo ready`, nil)

	// ── Phase 2: helm install redpanda-operator ───────────────────────────
	step(4, 300*time.Millisecond, "$ helm install redpanda-operator redpanda/redpanda-operator -n redpanda-system --create-namespace", nil)

	nsSystem := node("ns-redpanda-system", models.KindNamespace, "v1", "redpanda-system", "", nil, spec(models.ConfigMapSpec{}))
	step(5, 400*time.Millisecond, "+ namespace/redpanda-system created", func() {
		s.Add(nsSystem)
	})

	// CRDs — log-only (schema definitions, not instances; shown on step, not as graph nodes)
	step(6, 300*time.Millisecond, "+ customresourcedefinition.apiextensions.k8s.io/redpandas.cluster.redpanda.com created", nil)
	step(7, 200*time.Millisecond, "+ customresourcedefinition.apiextensions.k8s.io/consoles.redpanda.com created", nil)

	// RBAC — log-only (shows what permissions the operator gets)
	step(8, 300*time.Millisecond, "+ serviceaccount/redpanda-operator created  (namespace: redpanda-system)", nil)
	step(9, 200*time.Millisecond, "+ clusterrole.rbac.authorization.k8s.io/redpanda-operator created  (get/list/watch/create/update/delete StatefulSets, Services, PVCs…)", nil)
	step(10, 200*time.Millisecond, "+ clusterrolebinding.rbac.authorization.k8s.io/redpanda-operator created  (binds SA → ClusterRole)", nil)

	operatorDeploy := node("deploy-redpanda-operator", models.KindDeployment, "apps/v1", "redpanda-operator", "redpanda-system",
		labels("app.kubernetes.io/name", "redpanda-operator"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "redpanda-operator"}}))
	step(11, 500*time.Millisecond, "+ deployment.apps/redpanda-operator created", func() {
		operatorDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(operatorDeploy)
		s.AddEdge(edge(operatorDeploy.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	operatorRS := node("rs-redpanda-operator", models.KindReplicaSet, "apps/v1", "redpanda-operator-rs", "redpanda-system",
		labels("app.kubernetes.io/name", "redpanda-operator"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "redpanda-operator"}, OwnerRef: operatorDeploy.ID}))
	step(12, 400*time.Millisecond, "  ↳ replicaset/redpanda-operator-rs spawned", func() {
		s.Add(operatorRS)
		s.AddEdge(edge(operatorDeploy.ID, operatorRS.ID, models.EdgeOwns, ""))
	})

	operatorPod := redpandaOperatorPod("pod-redpanda-operator", "redpanda-operator-abc12", operatorRS.ID)
	operatorPod.SimPhase = string(models.PodPending)
	var opPodSpec models.PodSpec
	if err := json.Unmarshal(operatorPod.Spec, &opPodSpec); err == nil {
		opPodSpec.Phase = models.PodPending
		operatorPod.Spec, _ = json.Marshal(opPodSpec)
	}
	operatorPod.Status = statusJSON(map[string]string{"phase": "Pending"})
	step(13, 500*time.Millisecond, "  ↳ pod/redpanda-operator-abc12: Pending — waiting to be scheduled...", func() {
		s.Add(operatorPod)
		s.AddEdge(edge(operatorRS.ID, operatorPod.ID, models.EdgeOwns, ""))
	})

	operatorPod.SimPhase = "ContainerCreating"
	operatorPod.Status = statusJSON(map[string]string{"phase": "Pending", "reason": "ContainerCreating"})
	step(14, 800*time.Millisecond, "  ↳ pod/redpanda-operator-abc12: ContainerCreating — pulling redpanda-operator:v24.3.0...", func() {
		s.Update(operatorPod)
	})

	operatorPod.SimPhase = string(models.PodRunning)
	if err := json.Unmarshal(operatorPod.Spec, &opPodSpec); err == nil {
		opPodSpec.Phase = models.PodRunning
		operatorPod.Spec, _ = json.Marshal(opPodSpec)
	}
	operatorPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(15, 900*time.Millisecond, "  ↳ pod/redpanda-operator-abc12: Running ✓", func() {
		s.Update(operatorPod)
	})

	step(16, 500*time.Millisecond, "Operator ready — watching for Redpanda CRs via Informer (ListWatch on redpandas.cluster.redpanda.com)", nil)

	// ── Phase 3: helm install redpanda ─────────────────────────────────────
	step(17, 300*time.Millisecond, "$ helm install redpanda redpanda/redpanda -n redpanda --create-namespace", nil)

	nsRedpanda := node("ns-redpanda", models.KindNamespace, "v1", "redpanda", "", nil, spec(models.ConfigMapSpec{}))
	step(18, 300*time.Millisecond, "+ namespace/redpanda created", func() {
		s.Add(nsRedpanda)
	})

	operatorVer := "v2.3.6-24.3.1"
	if useFlux {
		operatorVer = "v0.7.0-23.3.5"
	}
	redpandaCR := node("cr-redpanda", models.KindCustomResource, "cluster.redpanda.com/v1alpha2", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda", "app.kubernetes.io/managed-by", "redpanda-operator"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"apiVersion": "cluster.redpanda.com/v1alpha2",
			"kind":       "Redpanda",
			"chartRef.chartVersion": "v5.10.1",
			"chartRef.useFlux": fmt.Sprintf("%v", useFlux),
			"clusterSpec.statefulset.replicas": "3",
			"clusterSpec.storage.persistentVolume.size": "20Gi",
			"clusterSpec.auth.sasl.enabled": "true",
			"clusterSpec.auth.sasl.mechanism": "SCRAM-SHA-512",
			"clusterSpec.listeners.kafka.port": "9092",
			"clusterSpec.listeners.schemaRegistry.port": "8081",
			"clusterSpec.listeners.pandaproxy.port": "8082",
			"clusterSpec.resources.cpu.cores": "1",
			"clusterSpec.resources.memory.container.max": "2Gi",
			"clusterSpec.image.tag": "v24.3.1",
			"clusterSpec.rackAwareness.enabled": "false",
			"clusterSpec.console.enabled": "true",
		}}))
	step(19, 500*time.Millisecond, "+ redpanda.cluster.redpanda.com/redpanda created  (CR applied — operator Informer will detect this)", func() {
		s.Add(redpandaCR)
		s.AddEdge(edge(operatorDeploy.ID, redpandaCR.ID, models.EdgeWatches, "reconcile"))
	})

	step(20, 600*time.Millisecond, "Operator: CR detected via Informer — reconciliation loop started  [operator "+operatorVer+"]", nil)
	step(21, 200*time.Millisecond, "Operator: validating .spec.clusterSpec → these become Helm values rendered into ConfigMap + StatefulSet...", nil)

	// The ConfigMap shows what the operator actually generates from the CR values.
	// This is the key "values flow": CR .spec.clusterSpec → Helm chart → redpanda.yaml
	redpandaCM := node("cm-redpanda", models.KindConfigMap, "v1", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"bootstrap.yaml": "seed_servers:\n- address: redpanda-0.redpanda.redpanda.svc.cluster.local\n  port: 33145\n- address: redpanda-1.redpanda.redpanda.svc.cluster.local\n  port: 33145\n- address: redpanda-2.redpanda.redpanda.svc.cluster.local\n  port: 33145\nraft_group_recovery_memory_budget_bytes: 1073741824",
			"redpanda.yaml":  "redpanda:\n  data_directory: /var/lib/redpanda/data\n  kafka_api:\n  - address: 0.0.0.0\n    port: 9092\n    name: internal\n  kafka_api_tls: []\n  admin:\n  - address: 0.0.0.0\n    port: 9644\n  rpc_server:\n    address: 0.0.0.0\n    port: 33145\n  advertised_rpc_api:\n    address: ${SERVICE_NAME}.redpanda.redpanda.svc.cluster.local\n    port: 33145\npandaproxy:\n  pandaproxy_api:\n  - address: 0.0.0.0\n    port: 8082\nschema_registry:\n  schema_registry_api:\n  - address: 0.0.0.0\n    port: 8081\n",
		}}))
	step(22, 400*time.Millisecond, "+ configmap/redpanda created  (.spec.clusterSpec rendered by Helm → bootstrap.yaml (seed servers) + redpanda.yaml (broker config))", func() {
		s.Add(redpandaCM)
		s.AddEdge(edge(redpandaCR.ID, redpandaCM.ID, models.EdgeOwns, ""))
	})

	redpandaSecret := node("secret-redpanda-users", models.KindSecret, "v1", "redpanda-users", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"), spec(models.ConfigMapSpec{}))
	step(23, 300*time.Millisecond, "+ secret/redpanda-users created  (SASL users — mounted into pod, never logged)", func() {
		s.Add(redpandaSecret)
		s.AddEdge(edge(redpandaCR.ID, redpandaSecret.ID, models.EdgeOwns, ""))
	})

	headlessSvc := node("svc-redpanda-headless", models.KindService, "v1", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.ServiceSpec{
			Type:     models.ServiceClusterIP,
			ClusterIP: "None",
			Selector: map[string]string{"app.kubernetes.io/name": "redpanda"},
			Ports:    []models.ServicePort{{Name: "kafka", Protocol: "TCP", Port: 9092, TargetPort: 9092}},
		}))
	step(24, 300*time.Millisecond, "+ service/redpanda (headless, ClusterIP=None) — stable DNS: redpanda-N.redpanda.redpanda.svc.cluster.local", func() {
		s.Add(headlessSvc)
		s.AddEdge(edge(redpandaCR.ID, headlessSvc.ID, models.EdgeOwns, ""))
	})

	extSvc := node("svc-redpanda-external", models.KindService, "v1", "redpanda-external", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.ServiceSpec{
			Type:     models.ServiceNodePort,
			Selector: map[string]string{"app.kubernetes.io/name": "redpanda"},
			Ports:    []models.ServicePort{{Name: "kafka", Protocol: "TCP", Port: 9094, TargetPort: 9094, NodePort: 30092}},
		}))
	step(25, 300*time.Millisecond, "+ service/redpanda-external (NodePort:30092) — external clients connect here via any node IP", func() {
		s.Add(extSvc)
		s.AddEdge(edge(redpandaCR.ID, extSvc.ID, models.EdgeOwns, ""))
	})

	redpandaSTS := node("sts-redpanda", models.KindStatefulSet, "apps/v1", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.StatefulSetSpec{Replicas: 3, Selector: map[string]string{"app.kubernetes.io/name": "redpanda"}}))
	step(26, 400*time.Millisecond, "+ statefulset.apps/redpanda created  [0/3 ready]", func() {
		s.Add(redpandaSTS)
		s.AddEdge(edge(redpandaCR.ID, redpandaSTS.ID, models.EdgeOwns, ""))
	})

	step(27, 200*time.Millisecond, "StatefulSet: updateStrategy=RollingUpdate, podManagementPolicy=OrderedReady — pods start strictly in order", nil)

	// ── Phase 4: ordered StatefulSet pod startup (pod 0 → 1 → 2) ──────────
	for i := 0; i < 3; i++ {
		ii := i
		podID   := fmt.Sprintf("pod-redpanda-%d", ii)
		pvcID   := fmt.Sprintf("pvc-redpanda-%d", ii)
		pvID    := fmt.Sprintf("pv-redpanda-%d", ii)
		podName := fmt.Sprintf("redpanda-%d", ii)
		pvcName := fmt.Sprintf("datadir-redpanda-%d", ii)
		pvName  := fmt.Sprintf("pv-redpanda-%d", ii)
		stepBase := 28 + ii*6

		var orderLabel string
		switch ii {
		case 0:
			orderLabel = "StatefulSet: starting pod 0  (OrderedReady — pod 0 must be Running+Ready before pod 1 starts)"
		case 1:
			orderLabel = "StatefulSet: pod 0 Ready — starting pod 1  (cluster running with 1 broker, no quorum yet)"
		case 2:
			orderLabel = "StatefulSet: pod 1 Ready — starting pod 2  (3rd broker gives Raft quorum: majority = 2 of 3)"
		}
		step(stepBase, 600*time.Millisecond, orderLabel, nil)

		pod := redpandaBrokerPod(podID, podName, redpandaSTS.ID, redpandaCM.ID, redpandaSecret.ID, pvcID)
		pod.SimPhase = string(models.PodPending)
		var podSpec models.PodSpec
		if err := json.Unmarshal(pod.Spec, &podSpec); err == nil {
			podSpec.Phase = models.PodPending
			pod.Spec, _ = json.Marshal(podSpec)
		}
		pod.Status = statusJSON(map[string]string{"phase": "Pending"})
		step(stepBase+1, 300*time.Millisecond, fmt.Sprintf("  pod/%s: Pending — StorageProvisioner allocating 20Gi persistent volume...", podName), func() {
			s.Add(pod)
			s.AddEdge(edge(redpandaSTS.ID, podID, models.EdgeOwns, ""))
			s.AddEdge(edge(headlessSvc.ID, podID, models.EdgeSelects, ""))
			s.AddEdge(edge(extSvc.ID, podID, models.EdgeSelects, ""))
		})

		pv := node(pvID, models.KindPV, "v1", pvName, "",
			nil, spec(models.PVSpec{Capacity: "20Gi", AccessModes: []string{"ReadWriteOnce"}}))
		pvc := node(pvcID, models.KindPVC, "v1", pvcName, "redpanda",
			labels("app.kubernetes.io/name", "redpanda"),
			spec(models.PVCSpec{AccessModes: []string{"ReadWriteOnce"}, Requests: "20Gi"}))
		step(stepBase+2, 700*time.Millisecond, fmt.Sprintf("  StorageProvisioner: pvc/%s → pv/%s  [Bound]", pvcName, pvName), func() {
			s.Add(pv)
			s.Add(pvc)
			pvc.Status, _ = json.Marshal(map[string]string{"phase": "Bound"})
			s.Update(pvc)
			s.AddEdge(edge(podID, pvcID, models.EdgeMounts, "datadir"))
			s.AddEdge(edge(pvcID, pvID, models.EdgeBound, ""))
			s.AddEdge(edge(podID, redpandaCM.ID, models.EdgeMounts, "config"))
			s.AddEdge(edge(podID, redpandaSecret.ID, models.EdgeMounts, "sasl"))
		})

		step(stepBase+3, 500*time.Millisecond, fmt.Sprintf("  pod/%s: init[redpanda-configurator] — generating advertised address, seed-server list, SASL config...", podName), nil)

		pod.SimPhase = "ContainerCreating"
		pod.Status = statusJSON(map[string]string{"phase": "Pending", "reason": "ContainerCreating"})
		step(stepBase+4, 600*time.Millisecond, fmt.Sprintf("  pod/%s: ContainerCreating — pulling docker.redpanda.com/redpandadata/redpanda:v24.3.1...", podName), func() {
			s.Update(pod)
		})

		pod.SimPhase = string(models.PodRunning)
		if err := json.Unmarshal(pod.Spec, &podSpec); err == nil {
			podSpec.Phase = models.PodRunning
			pod.Spec, _ = json.Marshal(podSpec)
		}
		pod.Status = statusJSON(map[string]string{"phase": "Running"})
		var runningLabel string
		switch ii {
		case 0:
			runningLabel = fmt.Sprintf("  pod/%s: Running ✓ — broker 0 online, listening on :9092 (no quorum yet, awaiting peers)", podName)
		case 1:
			runningLabel = fmt.Sprintf("  pod/%s: Running ✓ — broker 1 online (2/3 brokers up, still waiting for quorum)", podName)
		case 2:
			runningLabel = fmt.Sprintf("  pod/%s: Running ✓ — Raft quorum established! All 3 brokers online and replicating", podName)
		}
		step(stepBase+5, 900*time.Millisecond, runningLabel, func() {
			s.Update(pod)
		})
	}

	step(46, 400*time.Millisecond, "StatefulSet redpanda: 3/3 ready  (Raft quorum: 3 voters, min-ISR=2)", nil)
	step(47, 200*time.Millisecond, "Redpanda cluster deployment complete ✓", nil)
	step(48, 0, "$ rpk cluster info --brokers redpanda-0.redpanda.redpanda.svc.cluster.local:9092", nil)

	// ── Layer 3: post-install Job applies config.cluster via Admin API ────
	// This is the third config layer — values in values.yaml config.cluster/tunable
	// do NOT go into redpanda.yaml. They are applied live via PUT /v1/cluster_config.
	clusterConfigCM := node("cm-redpanda-cluster-config", models.KindConfigMap, "v1", "redpanda-cluster-config", "redpanda",
		labels("app.kubernetes.io/name", "redpanda", "app.kubernetes.io/component", "post-install"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"// layer":                       "3 — Admin API (no restart needed)",
			"log_segment_size_min":           "16777216",
			"log_segment_size_max":           "268435456",
			"compacted_log_segment_size":     "67108864",
			"max_compacted_log_segment_size": "536870912",
			"kafka_batch_max_bytes":          "1048576",
			"topic_partitions_per_shard":     "1000",
		}}))
	step(49, 400*time.Millisecond, "+ configmap/redpanda-cluster-config created  (Layer 3: config.cluster + config.tunable values from values.yaml — applied via Admin API, no restart needed)", func() {
		s.Add(clusterConfigCM)
		s.AddEdge(edge(redpandaCR.ID, clusterConfigCM.ID, models.EdgeOwns, ""))
	})

	postInstallJob := node("job-post-install", models.KindJob, "batch/v1", "redpanda-post-install", "redpanda",
		labels("app.kubernetes.io/name", "redpanda", "helm.sh/chart", "redpanda-5.10.1"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"hook":    "post-install,post-upgrade",
			"command": "rpk cluster config set …",
			"target":  "PUT /v1/cluster_config on Admin API :9644",
			"note":    "These settings are live-tunable — no pod restart required",
		}}))
	step(50, 500*time.Millisecond, "+ job.batch/redpanda-post-install created  (Helm post-install hook — calls PUT /v1/cluster_config to apply Layer 3 config properties)", func() {
		s.Add(postInstallJob)
		s.AddEdge(edge(redpandaCR.ID, postInstallJob.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(postInstallJob.ID, clusterConfigCM.ID, models.EdgeMounts, "config"))
		// The job calls the Admin API on each broker pod
		for i := 0; i < 3; i++ {
			s.AddEdge(edge(postInstallJob.ID, fmt.Sprintf("pod-redpanda-%d", i), models.EdgeRoutes, "Admin :9644"))
		}
	})
	step(51, 600*time.Millisecond, "post-install: PUT /v1/cluster_config → {log_segment_size_min, log_segment_size_max, kafka_batch_max_bytes, ...} applied ✓", nil)
	step(52, 200*time.Millisecond, "post-install job complete — Job will be garbage-collected after TTL", nil)

	// ── Flux path: show HelmRepository + HelmRelease (v0.x operator) ─────
	if useFlux {
		helmRepo := node("helmrepo-redpanda", models.KindHelmRepository, "source.toolkit.fluxcd.io/v1beta2", "redpanda", "redpanda-system",
			labels("app.kubernetes.io/managed-by", "redpanda-operator"),
			spec(models.ConfigMapSpec{Data: map[string]string{
				"url":      "https://charts.redpanda.com",
				"interval": "30m",
			}}))
		step(53, 400*time.Millisecond, "+ helmrepository.source.toolkit.fluxcd.io/redpanda created  (FluxCD source — points to charts.redpanda.com)", func() {
			s.Add(helmRepo)
			s.AddEdge(edge(operatorDeploy.ID, helmRepo.ID, models.EdgeOwns, ""))
		})

		helmRelease := node("helmrelease-redpanda", models.KindHelmRelease, "helm.toolkit.fluxcd.io/v2beta1", "redpanda", "redpanda",
			labels("app.kubernetes.io/managed-by", "redpanda-operator"),
			spec(models.ConfigMapSpec{Data: map[string]string{
				"chart.spec.chart":   "redpanda",
				"chart.spec.version": "v5.10.1",
				"interval":           "1m",
				"values-from":        "Redpanda CR .spec.clusterSpec",
				"upgrade.remediation.strategy": "rollback",
			}}))
		step(54, 500*time.Millisecond, "+ helmrelease.helm.toolkit.fluxcd.io/redpanda created  (FluxCD will sync chart values from the CR)", func() {
			s.Add(helmRelease)
			s.AddEdge(edge(helmRepo.ID, helmRelease.ID, models.EdgeOwns, "source"))
			s.AddEdge(edge(redpandaCR.ID, helmRelease.ID, models.EdgeOwns, "values"))
		})
		step(55, 300*time.Millisecond, "FluxCD HelmRelease reconciled — Helm upgrade applied  (CR .spec.clusterSpec → chart values → running cluster)", nil)
	}

	// ── Phase 5: Operator-managed CRDs — Topic, User, Schema ─────────────
	// These show how the operator manages Redpanda resources declaratively.
	topicOffset := 53
	if useFlux {
		topicOffset = 56
	}

	topicTx := node("cr-topic-transactions", models.KindRedpandaTopic, "cluster.redpanda.com/v1alpha2", "transactions", "redpanda",
		labels("app.kubernetes.io/managed-by", "redpanda-operator"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"partitions":        "3",
			"replicationFactor": "3",
			"overrides.retention.ms":          "604800000",
			"overrides.cleanup.policy":        "delete",
			"overrides.min.insync.replicas":   "2",
		}}))
	step(topicOffset, 600*time.Millisecond, "+ topic.cluster.redpanda.com/transactions created  (operator creates Kafka topic via rpk — 3 partitions, RF=3, retention=7d)", func() {
		s.Add(topicTx)
		s.AddEdge(edge(operatorDeploy.ID, topicTx.ID, models.EdgeOwns, "manages"))
		s.AddEdge(edge(redpandaCR.ID, topicTx.ID, models.EdgeOwns, ""))
	})

	topicAudit := node("cr-topic-audit-log", models.KindRedpandaTopic, "cluster.redpanda.com/v1alpha2", "audit-log", "redpanda",
		labels("app.kubernetes.io/managed-by", "redpanda-operator"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"partitions":        "12",
			"replicationFactor": "3",
			"overrides.retention.ms":        "2592000000",
			"overrides.cleanup.policy":      "delete",
			"overrides.min.insync.replicas": "2",
		}}))
	step(topicOffset+1, 400*time.Millisecond, "+ topic.cluster.redpanda.com/audit-log created  (12 partitions, RF=3, retention=30d — matches audit logging config)", func() {
		s.Add(topicAudit)
		s.AddEdge(edge(operatorDeploy.ID, topicAudit.ID, models.EdgeOwns, "manages"))
		s.AddEdge(edge(redpandaCR.ID, topicAudit.ID, models.EdgeOwns, ""))
	})

	userAdmin := node("cr-user-admin", models.KindRedpandaUser, "cluster.redpanda.com/v1alpha2", "admin", "redpanda",
		labels("app.kubernetes.io/managed-by", "redpanda-operator"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"authentication.type":                "SCRAM-SHA-512",
			"authentication.password.valueFrom":  "secret: redpanda-admin-password, key: password",
			"authorization.acls[0].type":         "allow",
			"authorization.acls[0].resource":     "topic/*",
			"authorization.acls[0].operations":   "read, write, describe",
		}}))
	step(topicOffset+2, 400*time.Millisecond, "+ user.cluster.redpanda.com/admin created  (SCRAM-SHA-512, password from Secret — operator calls Admin API to sync user + ACLs)", func() {
		s.Add(userAdmin)
		s.AddEdge(edge(operatorDeploy.ID, userAdmin.ID, models.EdgeOwns, "manages"))
		s.AddEdge(edge(redpandaCR.ID, userAdmin.ID, models.EdgeOwns, ""))
	})

	schemaAvro := node("cr-schema-avro", models.KindRedpandaSchema, "cluster.redpanda.com/v1alpha2", "payment-v1", "redpanda",
		labels("app.kubernetes.io/managed-by", "redpanda-operator"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"schemaType": "avro",
			"schema":     `{"type":"record","name":"Payment","fields":[{"name":"id","type":"string"},{"name":"amount","type":"double"},{"name":"currency","type":"string"}]}`,
			"compatibility": "BACKWARD",
			"references[0].name":    "money.proto",
			"references[0].subject": "money-value",
			"references[0].version": "1",
		}}))
	step(topicOffset+3, 400*time.Millisecond, "+ schema.cluster.redpanda.com/payment-v1 created  (Avro schema, BACKWARD compatibility — operator registers via Schema Registry API :8081)", func() {
		s.Add(schemaAvro)
		s.AddEdge(edge(operatorDeploy.ID, schemaAvro.ID, models.EdgeOwns, "manages"))
		s.AddEdge(edge(redpandaCR.ID, schemaAvro.ID, models.EdgeOwns, ""))
	})

	step(topicOffset+4, 300*time.Millisecond, "✓ All Redpanda resources reconciled  (edit any CR to trigger re-reconciliation — operator reacts within seconds)", nil)
	step(topicOffset+5, 0, "Tip: kubectl edit topic transactions -n redpanda  — change partitions or retention, operator syncs immediately", nil)
	step(topicOffset+6, 0, "Tip: kubectl edit redpanda redpanda -n redpanda   — change replicas/resources, operator rolls StatefulSet", nil)
}

// RunCertManagerScenario progressively recreates a cert-manager installation,
// mirroring a real `helm install cert-manager jetstack/cert-manager` flow.
// onStep is called after each step so the caller can broadcast scenario.step events.
func RunCertManagerScenario(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 32

	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// ── Wipe existing cert-manager nodes ─────────────────────────────────
	for _, id := range []string{
		"ns-cert-manager",
		"deploy-cert-manager-cainjector", "rs-cert-manager-cainjector", "pod-cert-manager-cainjector",
		"deploy-cert-manager", "rs-cert-manager", "pod-cert-manager",
		"deploy-cert-manager-webhook", "rs-cert-manager-webhook", "pod-cert-manager-webhook",
		"svc-cert-manager", "svc-cert-manager-webhook",
	} {
		s.Delete(id)
	}
	time.Sleep(150 * time.Millisecond)

	// ── Phase 1: helm repo setup ──────────────────────────────────────────
	step(1, 0, "$ helm repo add jetstack https://charts.jetstack.io", nil)
	step(2, 200*time.Millisecond, "Hang tight while we grab the latest from your chart repositories...", nil)
	step(3, 600*time.Millisecond, `Update complete. ⎈Happy Helming!⎈  — "jetstack" repo ready`, nil)
	step(4, 300*time.Millisecond, "$ helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true", nil)

	// ── Phase 2: namespace + CRDs ─────────────────────────────────────────
	nsCertMgr := node("ns-cert-manager", models.KindNamespace, "v1", "cert-manager", "", nil, spec(models.ConfigMapSpec{}))
	step(5, 400*time.Millisecond, "+ namespace/cert-manager created", func() {
		s.Add(nsCertMgr)
	})

	step(6, 300*time.Millisecond, "+ CRD certificates.cert-manager.io installed  (v1.14.4 — Certificate lifecycle management)", nil)
	step(7, 200*time.Millisecond, "+ CRD issuers.cert-manager.io installed  (namespace-scoped certificate authority)", nil)
	step(8, 200*time.Millisecond, "+ CRD clusterissuers.cert-manager.io installed  (cluster-scoped certificate authority)", nil)
	step(9, 200*time.Millisecond, "+ CRDs certificaterequests, orders, challenges installed  (ACME protocol resources)", nil)

	// ── Phase 3: RBAC ─────────────────────────────────────────────────────
	step(10, 300*time.Millisecond, "+ serviceaccount/cert-manager-cainjector, cert-manager, cert-manager-webhook created", nil)
	step(11, 200*time.Millisecond, "+ ClusterRole.rbac/cert-manager-controller-* created  (get/list/watch/update Certificates, Issuers, Secrets…)", nil)
	step(12, 200*time.Millisecond, "+ ClusterRoleBinding.rbac/cert-manager-controller-* created  (binds service accounts → ClusterRoles)", nil)
	step(13, 200*time.Millisecond, "+ ValidatingWebhookConfiguration/cert-manager-webhook registered  (validates Certificate and Issuer specs on create/update)", nil)

	// ── Phase 4: cert-manager-cainjector ─────────────────────────────────
	cainjectorDeploy := node("deploy-cert-manager-cainjector", models.KindDeployment, "apps/v1", "cert-manager-cainjector", "cert-manager",
		labels("app.kubernetes.io/name", "cainjector", "app.kubernetes.io/instance", "cert-manager"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "cainjector"}}))
	step(14, 500*time.Millisecond, "+ deployment.apps/cert-manager-cainjector created  (injects CA data into webhook configurations)", func() {
		cainjectorDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(cainjectorDeploy)
		s.AddEdge(edge(cainjectorDeploy.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	cainjectorRS := node("rs-cert-manager-cainjector", models.KindReplicaSet, "apps/v1", "cert-manager-cainjector-rs", "cert-manager",
		labels("app.kubernetes.io/name", "cainjector"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "cainjector"}, OwnerRef: cainjectorDeploy.ID}))
	step(15, 350*time.Millisecond, "  ↳ replicaset/cert-manager-cainjector-rs spawned", func() {
		s.Add(cainjectorRS)
		s.AddEdge(edge(cainjectorDeploy.ID, cainjectorRS.ID, models.EdgeOwns, ""))
	})

	cainjectorPod := certMgrPod("pod-cert-manager-cainjector", "cert-manager-cainjector-abc12", cainjectorRS.ID,
		"cainjector", "quay.io/jetstack/cert-manager-cainjector:v1.14.4")
	cainjectorPod.SimPhase = string(models.PodPending)
	step(16, 400*time.Millisecond, "  ↳ pod/cert-manager-cainjector-abc12: Pending — waiting to be scheduled...", func() {
		s.Add(cainjectorPod)
		s.AddEdge(edge(cainjectorRS.ID, cainjectorPod.ID, models.EdgeOwns, ""))
	})

	cainjectorPod.SimPhase = "ContainerCreating"
	cainjectorPod.Status = statusJSON(map[string]string{"phase": "Pending", "reason": "ContainerCreating"})
	step(17, 800*time.Millisecond, "  ↳ pod/cert-manager-cainjector-abc12: ContainerCreating — pulling quay.io/jetstack/cert-manager-cainjector:v1.14.4...", func() {
		s.Update(cainjectorPod)
	})

	cainjectorPod.SimPhase = string(models.PodRunning)
	cainjectorPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(18, 900*time.Millisecond, "  ↳ pod/cert-manager-cainjector-abc12: Running ✓ — watching CRDs for ca-inject annotations", func() {
		s.Update(cainjectorPod)
	})

	// ── Phase 5: cert-manager controller ─────────────────────────────────
	cmDeploy := node("deploy-cert-manager", models.KindDeployment, "apps/v1", "cert-manager", "cert-manager",
		labels("app.kubernetes.io/name", "cert-manager", "app.kubernetes.io/instance", "cert-manager"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "cert-manager"}}))
	step(19, 500*time.Millisecond, "+ deployment.apps/cert-manager created  (main controller: reconciles Certificate, Issuer, ClusterIssuer resources)", func() {
		cmDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(cmDeploy)
		s.AddEdge(edge(cmDeploy.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	cmRS := node("rs-cert-manager", models.KindReplicaSet, "apps/v1", "cert-manager-rs", "cert-manager",
		labels("app.kubernetes.io/name", "cert-manager"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "cert-manager"}, OwnerRef: cmDeploy.ID}))
	step(20, 350*time.Millisecond, "  ↳ replicaset/cert-manager-rs spawned", func() {
		s.Add(cmRS)
		s.AddEdge(edge(cmDeploy.ID, cmRS.ID, models.EdgeOwns, ""))
	})

	cmPod := certMgrPod("pod-cert-manager", "cert-manager-def34", cmRS.ID,
		"controller", "quay.io/jetstack/cert-manager-controller:v1.14.4")
	cmPod.SimPhase = string(models.PodPending)
	step(21, 400*time.Millisecond, "  ↳ pod/cert-manager-def34: Pending — waiting to be scheduled...", func() {
		s.Add(cmPod)
		s.AddEdge(edge(cmRS.ID, cmPod.ID, models.EdgeOwns, ""))
	})

	cmPod.SimPhase = "ContainerCreating"
	cmPod.Status = statusJSON(map[string]string{"phase": "Pending", "reason": "ContainerCreating"})
	step(22, 800*time.Millisecond, "  ↳ pod/cert-manager-def34: ContainerCreating — pulling quay.io/jetstack/cert-manager-controller:v1.14.4...", func() {
		s.Update(cmPod)
	})

	cmPod.SimPhase = string(models.PodRunning)
	cmPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(23, 900*time.Millisecond, "  ↳ pod/cert-manager-def34: Running ✓ — reconciling Certificates, Issuers, ClusterIssuers", func() {
		s.Update(cmPod)
	})

	// ── Phase 6: cert-manager-webhook ─────────────────────────────────────
	webhookDeploy := node("deploy-cert-manager-webhook", models.KindDeployment, "apps/v1", "cert-manager-webhook", "cert-manager",
		labels("app.kubernetes.io/name", "webhook", "app.kubernetes.io/instance", "cert-manager"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "webhook"}}))
	step(24, 500*time.Millisecond, "+ deployment.apps/cert-manager-webhook created  (admission webhook: validates Certificate and Issuer specs)", func() {
		webhookDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(webhookDeploy)
		s.AddEdge(edge(webhookDeploy.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	webhookRS := node("rs-cert-manager-webhook", models.KindReplicaSet, "apps/v1", "cert-manager-webhook-rs", "cert-manager",
		labels("app.kubernetes.io/name", "webhook"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "webhook"}, OwnerRef: webhookDeploy.ID}))
	step(25, 350*time.Millisecond, "  ↳ replicaset/cert-manager-webhook-rs spawned", func() {
		s.Add(webhookRS)
		s.AddEdge(edge(webhookDeploy.ID, webhookRS.ID, models.EdgeOwns, ""))
	})

	webhookPod := certMgrPod("pod-cert-manager-webhook", "cert-manager-webhook-ghi56", webhookRS.ID,
		"webhook", "quay.io/jetstack/cert-manager-webhook:v1.14.4")
	webhookPod.SimPhase = string(models.PodPending)
	step(26, 400*time.Millisecond, "  ↳ pod/cert-manager-webhook-ghi56: Pending — waiting to be scheduled...", func() {
		s.Add(webhookPod)
		s.AddEdge(edge(webhookRS.ID, webhookPod.ID, models.EdgeOwns, ""))
	})

	webhookPod.SimPhase = "ContainerCreating"
	webhookPod.Status = statusJSON(map[string]string{"phase": "Pending", "reason": "ContainerCreating"})
	step(27, 800*time.Millisecond, "  ↳ pod/cert-manager-webhook-ghi56: ContainerCreating — pulling quay.io/jetstack/cert-manager-webhook:v1.14.4...", func() {
		s.Update(webhookPod)
	})

	webhookPod.SimPhase = string(models.PodRunning)
	webhookPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(28, 900*time.Millisecond, "  ↳ pod/cert-manager-webhook-ghi56: Running ✓ — serving TLS admission webhook on :10250", func() {
		s.Update(webhookPod)
	})

	// ── Phase 7: Services ─────────────────────────────────────────────────
	cmSvc := node("svc-cert-manager", models.KindService, "v1", "cert-manager", "cert-manager",
		labels("app.kubernetes.io/name", "cert-manager"),
		spec(models.ServiceSpec{
			Type:     models.ServiceClusterIP,
			Selector: map[string]string{"app.kubernetes.io/name": "cert-manager"},
			Ports:    []models.ServicePort{{Name: "tcp-prometheus-servicemonitor", Protocol: "TCP", Port: 9402, TargetPort: 9402}},
		}))
	step(29, 300*time.Millisecond, "+ service/cert-manager created  (ClusterIP :9402 — Prometheus metrics endpoint)", func() {
		s.Add(cmSvc)
		s.AddEdge(edge(cmSvc.ID, cmPod.ID, models.EdgeSelects, ""))
	})

	webhookSvc := node("svc-cert-manager-webhook", models.KindService, "v1", "cert-manager-webhook", "cert-manager",
		labels("app.kubernetes.io/name", "webhook"),
		spec(models.ServiceSpec{
			Type:     models.ServiceClusterIP,
			Selector: map[string]string{"app.kubernetes.io/name": "webhook"},
			Ports:    []models.ServicePort{{Name: "https", Protocol: "TCP", Port: 443, TargetPort: 10250}},
		}))
	step(30, 300*time.Millisecond, "+ service/cert-manager-webhook created  (ClusterIP :443 — kube-apiserver calls this for admission validation)", func() {
		s.Add(webhookSvc)
		s.AddEdge(edge(webhookSvc.ID, webhookPod.ID, models.EdgeSelects, ""))
	})

	step(31, 400*time.Millisecond, "cert-manager v1.14.4 ready ✓  (3/3 deployments available)", nil)
	step(32, 0, "Certificate and Issuer CRDs now available — create a ClusterIssuer to start issuing TLS certificates", nil)
}

// RunArgoCDScenario progressively deploys ArgoCD and demonstrates the GitOps
// reconciliation loop: install → Application CR → sync → resources appear.
func RunArgoCDScenario(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 44

	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// Wipe existing ArgoCD nodes
	for _, id := range []string{
		"ns-argocd",
		"deploy-argocd-redis", "rs-argocd-redis", "pod-argocd-redis",
		"deploy-argocd-dex", "rs-argocd-dex", "pod-argocd-dex",
		"deploy-argocd-repo", "rs-argocd-repo", "pod-argocd-repo",
		"sts-argocd-controller", "pod-argocd-controller",
		"deploy-argocd-server", "rs-argocd-server", "pod-argocd-server",
		"svc-argocd-redis", "svc-argocd-dex", "svc-argocd-repo", "svc-argocd-server",
		"cr-argocd-app-guestbook",
		"ns-guestbook", "deploy-guestbook-ui", "rs-guestbook-ui", "pod-guestbook-ui", "svc-guestbook-ui",
	} {
		s.Delete(id)
	}
	time.Sleep(200 * time.Millisecond)

	// ── Phase 1: helm install ──────────────────────────────────────────────
	step(1, 0, "$ helm repo add argo https://argoproj.github.io/argo-helm", nil)
	step(2, 300*time.Millisecond, "Hang tight while we grab the latest from your chart repositories…", nil)
	step(3, 600*time.Millisecond, "$ helm install argocd argo/argo-cd -n argocd --create-namespace", nil)

	// ── Phase 2: namespace + CRDs ─────────────────────────────────────────
	nsArgo := node("ns-argocd", models.KindNamespace, "v1", "argocd", "", nil, spec(models.ConfigMapSpec{}))
	step(4, 400*time.Millisecond, "+ namespace/argocd created", func() { s.Add(nsArgo) })
	step(5, 200*time.Millisecond, "+ CRD applications.argoproj.io installed  (declarative GitOps app descriptor)", nil)
	step(6, 200*time.Millisecond, "+ CRDs appprojects.argoproj.io, applicationsets.argoproj.io installed", nil)
	step(7, 200*time.Millisecond, "+ serviceaccount/argocd-* + ClusterRoles created  (view/manage Applications, Secrets, all namespaces)", nil)

	// ── Phase 3: argocd-redis ─────────────────────────────────────────────
	redisDeploy := node("deploy-argocd-redis", models.KindDeployment, "apps/v1", "argocd-redis", "argocd",
		labels("app.kubernetes.io/name", "argocd-redis"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-redis"}}))
	step(8, 500*time.Millisecond, "+ deployment.apps/argocd-redis created  (in-memory session store + app state cache)", func() {
		redisDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(redisDeploy)
	})
	redisRS := node("rs-argocd-redis", models.KindReplicaSet, "apps/v1", "argocd-redis-rs", "argocd",
		labels("app.kubernetes.io/name", "argocd-redis"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-redis"}, OwnerRef: redisDeploy.ID}))
	step(9, 300*time.Millisecond, "  ↳ replicaset/argocd-redis-rs spawned", func() {
		s.Add(redisRS); s.AddEdge(edge(redisDeploy.ID, redisRS.ID, models.EdgeOwns, ""))
	})
	redisPod := argoCDPod("pod-argocd-redis", "argocd-redis-abc12", redisRS.ID, "argocd-redis", "redis:7-alpine")
	step(10, 300*time.Millisecond, "  ↳ pod/argocd-redis-abc12: Pending", func() {
		s.Add(redisPod); s.AddEdge(edge(redisRS.ID, redisPod.ID, models.EdgeOwns, ""))
	})
	redisPod.SimPhase = "ContainerCreating"
	step(11, 600*time.Millisecond, "  ↳ pod/argocd-redis-abc12: ContainerCreating", func() { s.Update(redisPod) })
	redisPod.SimPhase = string(models.PodRunning)
	redisPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(12, 700*time.Millisecond, "  ↳ pod/argocd-redis-abc12: Running ✓", func() { s.Update(redisPod) })

	// ── Phase 4: argocd-dex-server ────────────────────────────────────────
	dexDeploy := node("deploy-argocd-dex", models.KindDeployment, "apps/v1", "argocd-dex-server", "argocd",
		labels("app.kubernetes.io/name", "argocd-dex-server"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-dex-server"}}))
	step(13, 400*time.Millisecond, "+ deployment.apps/argocd-dex-server created  (OIDC connector — integrates GitHub/Google/LDAP SSO)", func() {
		dexDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(dexDeploy)
	})
	dexRS := node("rs-argocd-dex", models.KindReplicaSet, "apps/v1", "argocd-dex-rs", "argocd",
		labels("app.kubernetes.io/name", "argocd-dex-server"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-dex-server"}, OwnerRef: dexDeploy.ID}))
	dexPod := argoCDPod("pod-argocd-dex", "argocd-dex-def34", dexRS.ID, "argocd-dex-server", "ghcr.io/dex-idp/dex:v2.38.0")
	dexPod.SimPhase = string(models.PodRunning)
	dexPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(14, 700*time.Millisecond, "  ↳ argocd-dex-server: Running ✓  (OIDC provider on :5556)", func() {
		s.Add(dexRS); s.AddEdge(edge(dexDeploy.ID, dexRS.ID, models.EdgeOwns, ""))
		s.Add(dexPod); s.AddEdge(edge(dexRS.ID, dexPod.ID, models.EdgeOwns, ""))
	})

	// ── Phase 5: argocd-repo-server ───────────────────────────────────────
	repoDeploy := node("deploy-argocd-repo", models.KindDeployment, "apps/v1", "argocd-repo-server", "argocd",
		labels("app.kubernetes.io/name", "argocd-repo-server"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-repo-server"}}))
	step(15, 400*time.Millisecond, "+ deployment.apps/argocd-repo-server created  (clones Git repos, renders Helm/Kustomize/plain YAML)", func() {
		repoDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(repoDeploy)
	})
	repoRS := node("rs-argocd-repo", models.KindReplicaSet, "apps/v1", "argocd-repo-rs", "argocd",
		labels("app.kubernetes.io/name", "argocd-repo-server"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-repo-server"}, OwnerRef: repoDeploy.ID}))
	repoPod := argoCDPod("pod-argocd-repo", "argocd-repo-ghi56", repoRS.ID, "argocd-repo-server", "quay.io/argoproj/argocd:v2.10.0")
	repoPod.SimPhase = string(models.PodRunning)
	repoPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(16, 700*time.Millisecond, "  ↳ argocd-repo-server: Running ✓  (manifest generation on :8081)", func() {
		s.Add(repoRS); s.AddEdge(edge(repoDeploy.ID, repoRS.ID, models.EdgeOwns, ""))
		s.Add(repoPod); s.AddEdge(edge(repoRS.ID, repoPod.ID, models.EdgeOwns, ""))
	})

	// ── Phase 6: argocd-application-controller (StatefulSet) ─────────────
	ctrlSTS := node("sts-argocd-controller", models.KindStatefulSet, "apps/v1", "argocd-application-controller", "argocd",
		labels("app.kubernetes.io/name", "argocd-application-controller"),
		spec(models.StatefulSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-application-controller"}}))
	step(17, 500*time.Millisecond, "+ statefulset.apps/argocd-application-controller created  (THE reconciliation loop: desired Git state → actual cluster state)", func() {
		ctrlSTS.Status = statusJSON(map[string]interface{}{"replicas": 1, "readyReplicas": 0})
		s.Add(ctrlSTS)
	})
	ctrlPod := argoCDPod("pod-argocd-controller", "argocd-application-controller-0", ctrlSTS.ID, "argocd-application-controller", "quay.io/argoproj/argocd:v2.10.0")
	step(18, 300*time.Millisecond, "  ↳ pod/argocd-application-controller-0: Pending", func() {
		s.Add(ctrlPod); s.AddEdge(edge(ctrlSTS.ID, ctrlPod.ID, models.EdgeOwns, ""))
	})
	ctrlPod.SimPhase = "ContainerCreating"
	step(19, 700*time.Millisecond, "  ↳ pod/argocd-application-controller-0: ContainerCreating", func() { s.Update(ctrlPod) })
	ctrlPod.SimPhase = string(models.PodRunning)
	ctrlPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(20, 800*time.Millisecond, "  ↳ pod/argocd-application-controller-0: Running ✓  — controller connected to kube-apiserver via informer", func() {
		s.Update(ctrlPod)
		ctrlSTS.Status = statusJSON(map[string]interface{}{"replicas": 1, "readyReplicas": 1})
		s.Update(ctrlSTS)
		s.AddEdge(edge(ctrlSTS.ID, apiServerID, models.EdgeWatches, "informer"))
		s.AddEdge(edge(ctrlSTS.ID, repoDeploy.ID, models.EdgeWatches, "manifest-gen"))
		s.AddEdge(edge(ctrlSTS.ID, redisDeploy.ID, models.EdgeMounts, "cache"))
	})

	// ── Phase 7: argocd-server ────────────────────────────────────────────
	serverDeploy := node("deploy-argocd-server", models.KindDeployment, "apps/v1", "argocd-server", "argocd",
		labels("app.kubernetes.io/name", "argocd-server"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-server"}}))
	step(21, 400*time.Millisecond, "+ deployment.apps/argocd-server created  (REST/gRPC API + Web UI on :443/:80)", func() {
		serverDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
		s.Add(serverDeploy)
	})
	serverRS := node("rs-argocd-server", models.KindReplicaSet, "apps/v1", "argocd-server-rs", "argocd",
		labels("app.kubernetes.io/name", "argocd-server"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "argocd-server"}, OwnerRef: serverDeploy.ID}))
	serverPod := argoCDPod("pod-argocd-server", "argocd-server-jkl78", serverRS.ID, "argocd-server", "quay.io/argoproj/argocd:v2.10.0")
	step(22, 300*time.Millisecond, "  ↳ pod/argocd-server-jkl78: Pending", func() {
		s.Add(serverRS); s.AddEdge(edge(serverDeploy.ID, serverRS.ID, models.EdgeOwns, ""))
		s.Add(serverPod); s.AddEdge(edge(serverRS.ID, serverPod.ID, models.EdgeOwns, ""))
	})
	serverPod.SimPhase = "ContainerCreating"
	step(23, 700*time.Millisecond, "  ↳ pod/argocd-server-jkl78: ContainerCreating", func() { s.Update(serverPod) })
	serverPod.SimPhase = string(models.PodRunning)
	serverPod.Status = statusJSON(map[string]string{"phase": "Running"})
	step(24, 800*time.Millisecond, "  ↳ pod/argocd-server-jkl78: Running ✓  — UI + API ready", func() {
		s.Update(serverPod)
		serverDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1, ReadyReplicas: 1, AvailableReplicas: 1})
		s.Update(serverDeploy)
		s.AddEdge(edge(serverDeploy.ID, dexDeploy.ID, models.EdgeWatches, "sso"))
		s.AddEdge(edge(serverDeploy.ID, repoDeploy.ID, models.EdgeWatches, "manifests"))
		s.AddEdge(edge(serverDeploy.ID, redisDeploy.ID, models.EdgeMounts, "sessions"))
	})

	// ── Phase 8: Services ─────────────────────────────────────────────────
	svcRedis := node("svc-argocd-redis", models.KindService, "v1", "argocd-redis", "argocd",
		labels("app.kubernetes.io/name", "argocd-redis"),
		spec(models.ServiceSpec{Type: models.ServiceClusterIP, Selector: map[string]string{"app.kubernetes.io/name": "argocd-redis"},
			Ports: []models.ServicePort{{Name: "tcp-redis", Protocol: "TCP", Port: 6379, TargetPort: 6379}}}))
	step(25, 300*time.Millisecond, "+ service/argocd-redis created  (ClusterIP :6379)", func() {
		s.Add(svcRedis); s.AddEdge(edge(svcRedis.ID, redisPod.ID, models.EdgeSelects, ""))
	})
	svcRepo := node("svc-argocd-repo", models.KindService, "v1", "argocd-repo-server", "argocd",
		labels("app.kubernetes.io/name", "argocd-repo-server"),
		spec(models.ServiceSpec{Type: models.ServiceClusterIP, Selector: map[string]string{"app.kubernetes.io/name": "argocd-repo-server"},
			Ports: []models.ServicePort{{Name: "server", Protocol: "TCP", Port: 8081, TargetPort: 8081}}}))
	step(26, 200*time.Millisecond, "+ service/argocd-repo-server created  (ClusterIP :8081)", func() {
		s.Add(svcRepo); s.AddEdge(edge(svcRepo.ID, repoPod.ID, models.EdgeSelects, ""))
	})
	svcDex := node("svc-argocd-dex", models.KindService, "v1", "argocd-dex-server", "argocd",
		labels("app.kubernetes.io/name", "argocd-dex-server"),
		spec(models.ServiceSpec{Type: models.ServiceClusterIP, Selector: map[string]string{"app.kubernetes.io/name": "argocd-dex-server"},
			Ports: []models.ServicePort{{Name: "http", Protocol: "TCP", Port: 5556, TargetPort: 5556}}}))
	step(27, 200*time.Millisecond, "+ service/argocd-dex-server created  (ClusterIP :5556 :5557)", func() {
		s.Add(svcDex); s.AddEdge(edge(svcDex.ID, dexPod.ID, models.EdgeSelects, ""))
	})
	svcServer := node("svc-argocd-server", models.KindService, "v1", "argocd-server", "argocd",
		labels("app.kubernetes.io/name", "argocd-server"),
		spec(models.ServiceSpec{Type: models.ServiceNodePort, Selector: map[string]string{"app.kubernetes.io/name": "argocd-server"},
			Ports: []models.ServicePort{
				{Name: "http", Protocol: "TCP", Port: 80, TargetPort: 8080, NodePort: 30080},
				{Name: "https", Protocol: "TCP", Port: 443, TargetPort: 8080, NodePort: 30443},
			}}))
	step(28, 200*time.Millisecond, "+ service/argocd-server created  (NodePort :30080/:30443) — UI: https://<node-ip>:30443", func() {
		s.Add(svcServer); s.AddEdge(edge(svcServer.ID, serverPod.ID, models.EdgeSelects, ""))
	})

	// ── Phase 9: ArgoCD ready ─────────────────────────────────────────────
	step(29, 400*time.Millisecond, "ArgoCD v2.10 ready ✓  — initial admin password: kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d", nil)

	// ── Phase 10: Create Application CR (GitOps demo) ─────────────────────
	step(30, 500*time.Millisecond, "--- GitOps Demo: deploy guestbook app from Git ---", nil)
	step(31, 300*time.Millisecond, "$ argocd app create guestbook \\", nil)
	step(32, 200*time.Millisecond, "    --repo https://github.com/argoproj/argocd-example-apps \\", nil)
	step(33, 200*time.Millisecond, "    --path guestbook --dest-namespace guestbook --dest-server https://kubernetes.default.svc", nil)

	guestbookApp := node("cr-argocd-app-guestbook", models.KindApplication, "argoproj.io/v1alpha1", "guestbook", "argocd",
		labels("app.kubernetes.io/name", "guestbook", "app.kubernetes.io/managed-by", "argocd"),
		spec(models.ConfigMapSpec{}))
	step(34, 400*time.Millisecond, "application.argoproj.io/guestbook created  — status: OutOfSync  (cluster state does not match Git)", func() {
		s.Add(guestbookApp)
		s.AddEdge(edge(ctrlSTS.ID, guestbookApp.ID, models.EdgeWatches, "reconcile"))
	})

	step(35, 500*time.Millisecond, "argocd-application-controller: guestbook detected — cloning https://github.com/argoproj/argocd-example-apps…", nil)
	step(36, 600*time.Millisecond, "argocd-repo-server: rendering manifests from path 'guestbook' — found 2 resources (Deployment + Service)", nil)
	step(37, 400*time.Millisecond, "argocd-application-controller: diff computed — 2 resources to create (namespace + deployment + service)", nil)
	step(38, 300*time.Millisecond, "argocd-application-controller: syncing guestbook to cluster…", nil)

	// ── Phase 11: Resources appear in cluster (the GitOps payoff) ─────────
	nsGuestbook := node("ns-guestbook", models.KindNamespace, "v1", "guestbook", "", nil, spec(models.ConfigMapSpec{}))
	step(39, 300*time.Millisecond, "+ namespace/guestbook created  (target namespace for synced resources)", func() {
		s.Add(nsGuestbook)
	})

	gbDeploy := node("deploy-guestbook-ui", models.KindDeployment, "apps/v1", "guestbook-ui", "guestbook",
		labels("app", "guestbook-ui", "app.kubernetes.io/managed-by", "argocd"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app": "guestbook-ui"}}))
	gbRS := node("rs-guestbook-ui", models.KindReplicaSet, "apps/v1", "guestbook-ui-rs", "guestbook",
		labels("app", "guestbook-ui"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app": "guestbook-ui"}, OwnerRef: gbDeploy.ID}))
	gbPod := podNode("pod-guestbook-ui", "guestbook-ui-xyz99", "guestbook", "guestbook-ui",
		map[string]string{"app": "guestbook-ui"}, gbRS.ID, nil, nil, nil)
	gbPod.SimPhase = string(models.PodRunning)
	gbDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1, ReadyReplicas: 1, AvailableReplicas: 1})
	step(40, 400*time.Millisecond, "+ deployment.apps/guestbook-ui created in namespace guestbook  (synced from Git)", func() {
		s.Add(gbDeploy)
		s.Add(gbRS)
		s.Add(gbPod)
		s.AddEdge(edge(gbDeploy.ID, gbRS.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(gbRS.ID, gbPod.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(guestbookApp.ID, gbDeploy.ID, models.EdgeOwns, "synced"))
	})

	gbSvc := node("svc-guestbook-ui", models.KindService, "v1", "guestbook-ui", "guestbook",
		labels("app", "guestbook-ui", "app.kubernetes.io/managed-by", "argocd"),
		spec(models.ServiceSpec{Type: models.ServiceNodePort,
			Selector: map[string]string{"app": "guestbook-ui"},
			Ports:    []models.ServicePort{{Name: "http", Protocol: "TCP", Port: 80, TargetPort: 80, NodePort: 30900}}}))
	step(41, 300*time.Millisecond, "+ service/guestbook-ui created  (NodePort :30900) — guestbook accessible at http://<node-ip>:30900", func() {
		s.Add(gbSvc)
		s.AddEdge(edge(gbSvc.ID, gbPod.ID, models.EdgeSelects, ""))
		s.AddEdge(edge(guestbookApp.ID, gbSvc.ID, models.EdgeOwns, "synced"))
	})

	step(42, 400*time.Millisecond, "argocd-application-controller: guestbook — Synced ✓  Health: Healthy", nil)
	step(43, 200*time.Millisecond, "GitOps loop active: any Git commit to 'guestbook/' path will trigger automatic re-sync", nil)
	step(44, 0, "Try: delete pod/guestbook-ui-xyz99 — ArgoCD will detect OutOfSync and re-create it within 3 minutes (default sync interval)", nil)
}

// argoCDPod builds an ArgoCD component Pod.
func argoCDPod(id, name, ownerRef, component, image string) *models.Node {
	ps := models.PodSpec{
		Phase:    models.PodPending,
		OwnerRef: ownerRef,
		Labels:   map[string]string{"app.kubernetes.io/name": component},
		Containers: []models.ContainerInfo{
			{Name: component, Image: image, Role: "main"},
		},
	}
	n := node(id, models.KindPod, "v1", name, "argocd",
		map[string]string{"app.kubernetes.io/name": component}, spec(ps))
	n.Status = statusJSON(map[string]string{"phase": string(models.PodPending)})
	n.SimPhase = string(models.PodPending)
	return n
}

// certMgrPod builds a cert-manager component Pod.
func certMgrPod(id, name, ownerRef, component, image string) *models.Node {
	ps := models.PodSpec{
		Phase:    models.PodPending,
		OwnerRef: ownerRef,
		Labels:   map[string]string{"app.kubernetes.io/name": component, "app.kubernetes.io/instance": "cert-manager"},
		Containers: []models.ContainerInfo{
			{Name: component, Image: image, Role: "main"},
		},
	}
	n := node(id, models.KindPod, "v1", name, "cert-manager",
		map[string]string{"app.kubernetes.io/name": component}, spec(ps))
	n.Status = statusJSON(map[string]string{"phase": string(models.PodPending)})
	n.SimPhase = string(models.PodPending)
	return n
}

// redpandaBrokerPod builds a Redpanda broker Pod with its real container structure.
func redpandaBrokerPod(id, name, ownerRef, cmID, secretID, pvcID string) *models.Node {
	ps := models.PodSpec{
		Phase:         models.PodRunning,
		OwnerRef:      ownerRef,
		Labels:        map[string]string{"app.kubernetes.io/name": "redpanda"},
		ConfigMapRefs: []string{cmID},
		SecretRefs:    []string{secretID},
		PVCRefs:       []string{pvcID},
		InitContainers: []models.ContainerInfo{
			{Name: "redpanda-configurator", Image: "docker.redpanda.com/redpandadata/redpanda-operator:v24.3.0", Role: "init"},
		},
		Containers: []models.ContainerInfo{
			{Name: "redpanda", Image: "docker.redpanda.com/redpandadata/redpanda:v24.3.1", Role: "main", Ports: []int{9092, 9644, 33145}},
		},
	}
	n := node(id, models.KindPod, "v1", name, "redpanda",
		map[string]string{"app.kubernetes.io/name": "redpanda"}, spec(ps))
	n.Status = statusJSON(map[string]string{"phase": string(models.PodRunning)})
	n.SimPhase = string(models.PodRunning)
	return n
}

// RunHPAScenario creates a web-app Deployment + Service + HPA, then simulates a
// CPU spike causing the HPA to scale the deployment up.
func RunHPAScenario(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 24
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil { action() }
		onStep(i, total, label)
	}

	// Clean up existing HPA demo resources
	for _, id := range []string{
		"ns-webapp", "deploy-webapp", "rs-webapp",
		"pod-webapp-0", "pod-webapp-1", "pod-webapp-2", "pod-webapp-3", "pod-webapp-4",
		"svc-webapp", "hpa-webapp",
	} {
		s.Delete(id)
	}
	time.Sleep(100 * time.Millisecond)

	step(1, 0, "$ # HPA Demo: HorizontalPodAutoscaler scales pods on CPU pressure", nil)
	step(2, 300*time.Millisecond, "$ kubectl create namespace webapp", nil)
	nsWebapp := node("ns-webapp", models.KindNamespace, "v1", "webapp", "", nil, spec(models.ConfigMapSpec{}))
	step(3, 400*time.Millisecond, "+ namespace/webapp created", func() { s.Add(nsWebapp) })

	step(4, 300*time.Millisecond, "$ kubectl apply -f webapp-deployment.yaml", nil)
	webDeploy := node("deploy-webapp", models.KindDeployment, "apps/v1", "webapp", "webapp",
		labels("app", "webapp"),
		spec(models.DeploymentSpec{Replicas: 2, Selector: map[string]string{"app": "webapp"}}))
	step(5, 400*time.Millisecond, "+ deployment.apps/webapp created  (replicas: 2)", func() {
		webDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 2})
		s.Add(webDeploy)
		s.AddEdge(edge(webDeploy.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	webRS := node("rs-webapp", models.KindReplicaSet, "apps/v1", "webapp-rs-abc", "webapp",
		labels("app", "webapp"),
		spec(models.ReplicaSetSpec{Replicas: 2, Selector: map[string]string{"app": "webapp"}, OwnerRef: webDeploy.ID}))
	step(6, 300*time.Millisecond, "  ↳ replicaset/webapp-rs-abc created", func() {
		s.Add(webRS)
		s.AddEdge(edge(webDeploy.ID, webRS.ID, models.EdgeOwns, ""))
	})

	for i := 0; i < 2; i++ {
		podID := fmt.Sprintf("pod-webapp-%d", i)
		podName := fmt.Sprintf("webapp-abc%05d", i)
		ps := models.PodSpec{
			Phase:    models.PodRunning,
			OwnerRef: webRS.ID,
			Labels:   map[string]string{"app": "webapp"},
			Containers: []models.ContainerInfo{
				{Name: "webapp", Image: "nginx:1.25", Role: "main", Ports: []int{8080}},
			},
		}
		p := node(podID, models.KindPod, "v1", podName, "webapp",
			map[string]string{"app": "webapp"}, spec(ps))
		p.Status = statusJSON(map[string]string{"phase": string(models.PodRunning)})
		p.SimPhase = string(models.PodRunning)
		step(7+i, 500*time.Millisecond, fmt.Sprintf("  ↳ pod/%s: Running", podName), func() {
			s.Add(p)
			s.AddEdge(edge(webRS.ID, p.ID, models.EdgeOwns, ""))
		})
	}

	webSvc := node("svc-webapp", models.KindService, "v1", "webapp", "webapp",
		labels("app", "webapp"),
		spec(models.ServiceSpec{Type: models.ServiceClusterIP, Selector: map[string]string{"app": "webapp"},
			Ports: []models.ServicePort{{Protocol: "TCP", Port: 80, TargetPort: 8080}}}))
	step(9, 400*time.Millisecond, "+ service/webapp created  (ClusterIP, port 80)", func() {
		s.Add(webSvc)
		for i := 0; i < 2; i++ {
			s.AddEdge(edge(webSvc.ID, fmt.Sprintf("pod-webapp-%d", i), models.EdgeSelects, ""))
		}
	})

	step(10, 300*time.Millisecond, "$ kubectl apply -f webapp-hpa.yaml", nil)
	hpa := node("hpa-webapp", models.KindHPA, "autoscaling/v2", "webapp", "webapp",
		labels("app", "webapp"),
		spec(models.HPASpec{ScaleTargetRef: webDeploy.ID, MinReplicas: 2, MaxReplicas: 5, TargetCPUPercent: 50}))
	hpa.Status, _ = json.Marshal(models.HPAStatus{CurrentReplicas: 2, CurrentCPUUtilization: 12})
	step(11, 500*time.Millisecond, "+ horizontalpodautoscaler.autoscaling/webapp created  (min:2 max:5 cpu:50%)", func() {
		s.Add(hpa)
		s.AddEdge(edge(hpa.ID, webDeploy.ID, models.EdgeScales, ""))
	})

	step(12, 600*time.Millisecond, "  ↳ HPA watching metrics-server for webapp pod CPU usage", nil)
	step(13, 400*time.Millisecond, "  ↳ Current: 2 replicas  CPU: 12%  — below threshold", nil)

	// Simulate load spike
	step(14, 800*time.Millisecond, "$ # Simulating traffic spike — sending load to service/webapp", nil)
	step(15, 600*time.Millisecond, "  ↳ CPU utilization rising: 12% → 45% → 78% → 92%!", nil)
	hpa.Status, _ = json.Marshal(models.HPAStatus{CurrentReplicas: 2, CurrentCPUUtilization: 92})
	step(16, 400*time.Millisecond, "  ↳ HPA condition: AbleToScale=True, ScalingActive=True", func() {
		s.Update(hpa)
	})

	step(17, 500*time.Millisecond, "  ↳ HPA decision: need ceil(2 * 92/50) = 4 replicas  (scaling UP)", nil)

	// Scale up: add 2 more pods
	for i := 2; i < 4; i++ {
		podID := fmt.Sprintf("pod-webapp-%d", i)
		podName := fmt.Sprintf("webapp-abc%05d", i)
		ps := models.PodSpec{
			Phase:    models.PodRunning,
			OwnerRef: webRS.ID,
			Labels:   map[string]string{"app": "webapp"},
			Containers: []models.ContainerInfo{
				{Name: "webapp", Image: "nginx:1.25", Role: "main", Ports: []int{8080}},
			},
		}
		p := node(podID, models.KindPod, "v1", podName, "webapp",
			map[string]string{"app": "webapp"}, spec(ps))
		p.Status = statusJSON(map[string]string{"phase": string(models.PodRunning)})
		p.SimPhase = string(models.PodRunning)
		step(17+i-1, 600*time.Millisecond, fmt.Sprintf("  ↳ pod/%s: Pending → ContainerCreating → Running", podName), func() {
			s.Add(p)
			s.AddEdge(edge(webRS.ID, p.ID, models.EdgeOwns, ""))
			s.AddEdge(edge(webSvc.ID, p.ID, models.EdgeSelects, ""))
		})
	}

	webDeploy.Spec, _ = json.Marshal(models.DeploymentSpec{Replicas: 4, Selector: map[string]string{"app": "webapp"}})
	webDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 4, ReadyReplicas: 4, AvailableReplicas: 4})
	step(20, 400*time.Millisecond, "  ↳ deployment/webapp scaled: 2 → 4 replicas", func() {
		s.Update(webDeploy)
	})

	hpa.Status, _ = json.Marshal(models.HPAStatus{CurrentReplicas: 4, CurrentCPUUtilization: 48})
	step(21, 600*time.Millisecond, "  ↳ CPU stabilizing: 92% → 48%  (below 50% threshold)", func() {
		s.Update(hpa)
	})

	step(22, 400*time.Millisecond, "  ↳ HPA condition: DesiredReplicas=4, AbleToScale=True", nil)
	step(23, 400*time.Millisecond, "  ↳ Scale-down will trigger after 5min cooldown (stabilization window)", nil)
	step(24, 300*time.Millisecond, "✓ HPA demo complete — load-based autoscaling demonstrated", nil)
}

// redpandaOperatorPod builds the operator Pod node.
func redpandaOperatorPod(id, name, ownerRef string) *models.Node {
	ps := models.PodSpec{
		Phase:    models.PodRunning,
		OwnerRef: ownerRef,
		Labels:   map[string]string{"app.kubernetes.io/name": "redpanda-operator"},
		Containers: []models.ContainerInfo{
			{Name: "manager", Image: "docker.redpanda.com/redpandadata/redpanda-operator:v24.3.0", Role: "main"},
		},
	}
	n := node(id, models.KindPod, "v1", name, "redpanda-system",
		map[string]string{"app.kubernetes.io/name": "redpanda-operator"}, spec(ps))
	n.Status = statusJSON(map[string]string{"phase": string(models.PodRunning)})
	n.SimPhase = string(models.PodRunning)
	return n
}

// RunNodeDrainScenario simulates cordoning and draining a node for maintenance.
func RunNodeDrainScenario(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 10
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, "$ kubectl cordon node-1", nil)
	step(2, 600*time.Millisecond, "node/node-1 cordoned", func() {
		if node, ok := s.Get("node-1"); ok {
			var status models.NodeStatus
			if err := json.Unmarshal(node.Status, &status); err == nil {
				status.Conditions = append(status.Conditions, "SchedulingDisabled")
				node.Status, _ = json.Marshal(status)
				s.Update(node)
			}
		}
	})

	step(3, 800*time.Millisecond, "$ kubectl drain node-1 --ignore-daemonsets", nil)
	
	step(4, 500*time.Millisecond, "evicting pods from node-1...", func() {
		var podsToEvict []string
		for _, e := range s.ListEdges() {
			if e.Type == models.EdgeScheduledOn && e.Target == "node-1" {
				if pod, ok := s.Get(e.Source); ok && pod.Kind == models.KindPod {
					// skip daemonsets
					isDaemonSet := false
					for _, ownerEdge := range s.EdgesForNode(pod.ID) {
						if ownerEdge.Type == models.EdgeOwns && ownerEdge.Target == pod.ID {
							if owner, ok := s.Get(ownerEdge.Source); ok && owner.Kind == models.KindDaemonSet {
								isDaemonSet = true
							}
						}
					}
					if !isDaemonSet {
						podsToEvict = append(podsToEvict, pod.ID)
					}
				}
			}
		}
		for _, podID := range podsToEvict {
			if pod, ok := s.Get(podID); ok {
				pod.SimPhase = string(models.PodTerminating)
				var ps models.PodSpec
				if err := json.Unmarshal(pod.Spec, &ps); err == nil {
					ps.Phase = models.PodTerminating
					pod.Spec, _ = json.Marshal(ps)
				}
				s.Update(pod)
			}
		}
	})

	step(5, 2*time.Second, "Pods terminating and rescheduling...", nil)
	step(6, 1*time.Second, "node/node-1 drained", nil)
	
	step(7, 500*time.Millisecond, "Upgrading kubelet on node-1...", func() {
		if node, ok := s.Get("node-1"); ok {
			var spec models.NodeSpec
			if err := json.Unmarshal(node.Spec, &spec); err == nil {
				spec.KubeletVersion = "v1.29.2" // or a newer version
				node.Spec, _ = json.Marshal(spec)
				s.Update(node)
			}
		}
	})
	
	step(8, 1*time.Second, "Kubelet upgrade complete.", nil)
	step(9, 600*time.Millisecond, "$ kubectl uncordon node-1", nil)
	step(10, 500*time.Millisecond, "node/node-1 uncordoned", func() {
		if node, ok := s.Get("node-1"); ok {
			var status models.NodeStatus
			if err := json.Unmarshal(node.Status, &status); err == nil {
				var newConds []string
				for _, c := range status.Conditions {
					if c != "SchedulingDisabled" {
						newConds = append(newConds, c)
					}
				}
				status.Conditions = newConds
				node.Status, _ = json.Marshal(status)
				s.Update(node)
			}
		}
	})
}
