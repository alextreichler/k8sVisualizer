package store

import (
	"encoding/json"
	"fmt"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// LoadEmptyControlPlane populates the store with only the 4 core control-plane
// static pods — no addons, no workloads. Used with --mode=empty so the user can
// bootstrap the cluster themselves step-by-step via the Bootstrap section.
func LoadEmptyControlPlane(s *ClusterStore, version string) {
	s.ActiveVersion = version

	nsSystem := node("ns-kube-system", models.KindNamespace, "v1", "kube-system", "", nil, spec(models.ConfigMapSpec{}))
	s.Add(nsSystem)

	apiServer := node("cp-apiserver", models.KindControlPlaneComponent, "v1", "kube-apiserver", "kube-system",
		labels("component", "kube-apiserver", "tier", "control-plane"), spec(models.PodSpec{}))
	etcd := node("cp-etcd", models.KindControlPlaneComponent, "v1", "etcd", "kube-system",
		labels("component", "etcd", "tier", "control-plane"), spec(models.PodSpec{}))
	scheduler := node("cp-scheduler", models.KindControlPlaneComponent, "v1", "kube-scheduler", "kube-system",
		labels("component", "kube-scheduler", "tier", "control-plane"), spec(models.PodSpec{}))
	controllerManager := node("cp-controller-manager", models.KindControlPlaneComponent, "v1", "kube-controller-manager", "kube-system",
		labels("component", "kube-controller-manager", "tier", "control-plane"), spec(models.PodSpec{}))
	s.Add(apiServer)
	s.Add(etcd)
	s.Add(scheduler)
	s.Add(controllerManager)

	s.AddEdge(edge(apiServer.ID, etcd.ID, models.EdgeStores, "persist"))
	s.AddEdge(edge(scheduler.ID, apiServer.ID, models.EdgeWatches, "informer"))
	s.AddEdge(edge(controllerManager.ID, apiServer.ID, models.EdgeWatches, "informer"))
}

// LoadSampleState populates the store with a standard Kubernetes control plane.
func LoadSampleState(s *ClusterStore, version string) {
	s.ActiveVersion = version

	// --- Namespaces ---
	nsSystem := node("ns-kube-system", models.KindNamespace, "v1", "kube-system", "", nil, spec(models.ConfigMapSpec{}))
	s.Add(nsSystem)

	// ===== kube-system namespace =====

	// Control Plane Components
	apiServer := node("cp-apiserver", models.KindControlPlaneComponent, "v1", "kube-apiserver", "kube-system",
		labels("component", "kube-apiserver", "tier", "control-plane"), spec(models.PodSpec{}))
	etcd := node("cp-etcd", models.KindControlPlaneComponent, "v1", "etcd", "kube-system",
		labels("component", "etcd", "tier", "control-plane"), spec(models.PodSpec{}))
	scheduler := node("cp-scheduler", models.KindControlPlaneComponent, "v1", "kube-scheduler", "kube-system",
		labels("component", "kube-scheduler", "tier", "control-plane"), spec(models.PodSpec{}))
	controllerManager := node("cp-controller-manager", models.KindControlPlaneComponent, "v1", "kube-controller-manager", "kube-system",
		labels("component", "kube-controller-manager", "tier", "control-plane"), spec(models.PodSpec{}))
	s.Add(apiServer)
	s.Add(etcd)
	s.Add(scheduler)
	s.Add(controllerManager)
	// Note: cloud-controller-manager is intentionally omitted — it is optional and
	// only deployed in cloud environments (AWS, GCP, Azure). Not present in bare-metal
	// or managed clusters where the cloud provider handles it outside the cluster.

	// Core Control Plane Relationships (verified against kubernetes/cmd/ source)
	// kube-apiserver is the ONLY component that talks to etcd directly
	s.AddEdge(edge(apiServer.ID, etcd.ID, models.EdgeStores, "persist"))
	// scheduler and controller-manager watch the apiserver via Informer/ListWatch
	s.AddEdge(edge(scheduler.ID, apiServer.ID, models.EdgeWatches, "informer"))
	s.AddEdge(edge(controllerManager.ID, apiServer.ID, models.EdgeWatches, "informer"))

	// coredns (Standard Addon)
	coreDNSDeploy := node("deploy-coredns", models.KindDeployment, "apps/v1", "coredns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.DeploymentSpec{
			Replicas: 2,
			Selector: map[string]string{"k8s-app": "kube-dns"},
		}))
	coreDNSDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 2, ReadyReplicas: 2, AvailableReplicas: 2})
	s.Add(coreDNSDeploy)

	coreDNSRS := node("rs-coredns", models.KindReplicaSet, "apps/v1", "coredns-rs-xyz99", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.ReplicaSetSpec{Replicas: 2, Selector: map[string]string{"k8s-app": "kube-dns"}, OwnerRef: coreDNSDeploy.ID}))
	s.Add(coreDNSRS)
	s.AddEdge(edge(coreDNSDeploy.ID, coreDNSRS.ID, models.EdgeOwns, ""))
	s.AddEdge(edge(coreDNSDeploy.ID, apiServer.ID, models.EdgeWatches, "informer"))

	for i := 1; i <= 2; i++ {
		p := podNode(fmt.Sprintf("pod-coredns-%d", i), fmt.Sprintf("coredns-xyz99-%05d", i),
			"kube-system", "coredns",
			map[string]string{"k8s-app": "kube-dns"}, coreDNSRS.ID, nil, nil, nil)
		s.Add(p)
		s.AddEdge(edge(coreDNSRS.ID, p.ID, models.EdgeOwns, ""))
	}

	kubeDNSSvc := node("svc-kubedns", models.KindService, "v1", "kube-dns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.ServiceSpec{
			Type:      models.ServiceClusterIP,
			ClusterIP: "10.96.0.10",
			Selector:  map[string]string{"k8s-app": "kube-dns"},
			Ports: []models.ServicePort{
				{Name: "dns", Protocol: "UDP", Port: 53, TargetPort: 53},
				{Name: "dns-tcp", Protocol: "TCP", Port: 53, TargetPort: 53},
			},
		}))
	s.Add(kubeDNSSvc)
	for i := 1; i <= 2; i++ {
		s.AddEdge(edge(kubeDNSSvc.ID, fmt.Sprintf("pod-coredns-%d", i), models.EdgeSelects, ""))
	}

	// kube-proxy (Standard Addon)
	kubeProxyDS := node("ds-kubeproxy", models.KindDaemonSet, "apps/v1", "kube-proxy", "kube-system",
		labels("k8s-app", "kube-proxy"),
		spec(models.DaemonSetSpec{
			Selector: map[string]string{"k8s-app": "kube-proxy"},
		}))
	kubeProxyDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 3, DesiredNumberScheduled: 3})
	s.Add(kubeProxyDS)
	s.AddEdge(edge(kubeProxyDS.ID, apiServer.ID, models.EdgeWatches, "informer"))

	for i := 1; i <= 3; i++ {
		p := podNode(fmt.Sprintf("pod-kubeproxy-%d", i), fmt.Sprintf("kube-proxy-node%d", i),
			"kube-system", "kube-proxy",
			map[string]string{"k8s-app": "kube-proxy"}, kubeProxyDS.ID, nil, nil, nil)
		s.Add(p)
		s.AddEdge(edge(kubeProxyDS.ID, p.ID, models.EdgeOwns, ""))
	}

	// Worker Nodes
	workers := [3]*models.Node{}
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("node-worker-%d", i+1)
		n := node(id, models.KindNode, "v1", fmt.Sprintf("worker-node-%d", i+1), "",
			labels("kubernetes.io/role", "worker", "node-role.kubernetes.io/worker", ""),
			spec(models.NodeSpec{
				Capacity:       "4 CPU, 16Gi RAM",
				Roles:          []string{"worker"},
				OSImage:        "Ubuntu 22.04 LTS",
				KubeletVersion: version,
			}))
		n.Status, _ = json.Marshal(models.NodeStatus{Conditions: []string{"Ready"}})
		s.Add(n)
		workers[i] = n
	}

	// Assign pods to nodes (round-robin)
	// coredns pods → node-1, node-2
	s.AddEdge(edge("pod-coredns-1", workers[0].ID, models.EdgeScheduledOn, ""))
	s.AddEdge(edge("pod-coredns-2", workers[1].ID, models.EdgeScheduledOn, ""))
	// kube-proxy pods → one per node
	for i := 1; i <= 3; i++ {
		s.AddEdge(edge(fmt.Sprintf("pod-kubeproxy-%d", i), workers[i-1].ID, models.EdgeScheduledOn, ""))
	}

	// LimitRange — default container resource limits in kube-system
	lr := node("lr-default", models.KindLimitRange, "v1", "default-container-limits", "kube-system",
		nil, spec(models.LimitRangeSpec{
			Limits: []models.LimitRangeItem{{
				Type:           "Container",
				Default:        map[string]string{"cpu": "500m", "memory": "256Mi"},
				DefaultRequest: map[string]string{"cpu": "100m", "memory": "64Mi"},
				Max:            map[string]string{"cpu": "2", "memory": "2Gi"},
			}},
		}))
	s.Add(lr)

	loadRedpanda(s, apiServer.ID)
}

// loadRedpanda adds a Redpanda cluster deployed via Helm + Operator.
// Layout mirrors the real resource graph from redpanda-operator source:
//
//	redpanda: operator Deployment → ReplicaSet → Pod (same namespace as cluster)
//	          Redpanda CR → StatefulSet → Pods (3 brokers)
//	          each Pod → PVC → PV (persistent storage)
//	          headless Service + external NodePort Service → Pods
//	          ConfigMap + Secret (SASL users) mounted by Pods
func loadRedpanda(s *ClusterStore, apiServerID string) {
	// ===== redpanda namespace — operator and cluster share one namespace =====
	nsRedpanda := node("ns-redpanda", models.KindNamespace, "v1", "redpanda", "", nil, spec(models.ConfigMapSpec{}))
	s.Add(nsRedpanda)

	operatorDeploy := node("deploy-redpanda-operator", models.KindDeployment, "apps/v1", "redpanda-operator", "redpanda",
		labels("app.kubernetes.io/name", "redpanda-operator", "app.kubernetes.io/component", "operator"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "redpanda-operator"}}))
	operatorDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1, ReadyReplicas: 1, AvailableReplicas: 1})
	s.Add(operatorDeploy)

	operatorRS := node("rs-redpanda-operator", models.KindReplicaSet, "apps/v1", "redpanda-operator-rs", "redpanda",
		labels("app.kubernetes.io/name", "redpanda-operator"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "redpanda-operator"}, OwnerRef: operatorDeploy.ID}))
	s.Add(operatorRS)
	s.AddEdge(edge(operatorDeploy.ID, operatorRS.ID, models.EdgeOwns, ""))

	operatorPod := podNode("pod-redpanda-operator", "redpanda-operator-abc12", "redpanda", "redpanda-operator",
		map[string]string{"app.kubernetes.io/name": "redpanda-operator"}, operatorRS.ID, nil, nil, nil)
	s.Add(operatorPod)
	s.AddEdge(edge(operatorRS.ID, operatorPod.ID, models.EdgeOwns, ""))

	// Operator watches kube-apiserver for Redpanda CR changes (Informer/ListWatch)
	s.AddEdge(edge(operatorDeploy.ID, apiServerID, models.EdgeWatches, "informer"))

	// The Redpanda CR — user creates this, operator reconciles it into a StatefulSet
	redpandaCR := node("cr-redpanda", models.KindCustomResource, "cluster.redpanda.com/v1alpha2", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda", "app.kubernetes.io/managed-by", "redpanda-operator"),
		spec(models.RedpandaClusterSpec{Replicas: 3, Version: "v25.1.1"}))
	s.Add(redpandaCR)
	// Operator watches the CR to reconcile it
	s.AddEdge(edge(operatorDeploy.ID, redpandaCR.ID, models.EdgeWatches, "reconcile"))

	// StatefulSet — created by the operator when it sees the Redpanda CR
	redpandaSTS := node("sts-redpanda", models.KindStatefulSet, "apps/v1", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda", "app.kubernetes.io/component", "redpanda"),
		spec(models.StatefulSetSpec{Replicas: 3, Selector: map[string]string{"app.kubernetes.io/name": "redpanda"}}))
	redpandaSTS.Status = statusJSON(map[string]interface{}{"replicas": 3, "readyReplicas": 3})
	s.Add(redpandaSTS)
	// CR owns the StatefulSet — operator creates it on the CR's behalf
	s.AddEdge(edge(redpandaCR.ID, redpandaSTS.ID, models.EdgeOwns, ""))

	// ConfigMap — bootstrap.yaml + redpanda.yaml cluster config
	redpandaCM := node("cm-redpanda", models.KindConfigMap, "v1", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.ConfigMapSpec{Data: map[string]string{"bootstrap.yaml": "...", "redpanda.yaml": "..."}}))
	s.Add(redpandaCM)
	s.AddEdge(edge(redpandaCR.ID, redpandaCM.ID, models.EdgeOwns, ""))

	// Secret — SASL user credentials
	redpandaSecret := node("secret-redpanda-users", models.KindSecret, "v1", "redpanda-users", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.ConfigMapSpec{}))
	s.Add(redpandaSecret)
	s.AddEdge(edge(redpandaCR.ID, redpandaSecret.ID, models.EdgeOwns, ""))

	// Headless Service — for stable Pod DNS (redpanda-0.redpanda.redpanda.svc.cluster.local)
	redpandaHeadlessSvc := node("svc-redpanda-headless", models.KindService, "v1", "redpanda", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.ServiceSpec{
			Type:      models.ServiceClusterIP,
			ClusterIP: "None",
			Selector:  map[string]string{"app.kubernetes.io/name": "redpanda"},
			Ports: []models.ServicePort{
				{Name: "kafka", Protocol: "TCP", Port: 9092, TargetPort: 9092},
				{Name: "admin", Protocol: "TCP", Port: 9644, TargetPort: 9644},
				{Name: "rpc",   Protocol: "TCP", Port: 33145, TargetPort: 33145},
			},
		}))
	s.Add(redpandaHeadlessSvc)
	s.AddEdge(edge(redpandaCR.ID, redpandaHeadlessSvc.ID, models.EdgeOwns, ""))

	// External NodePort Service — for clients outside the cluster
	redpandaExtSvc := node("svc-redpanda-external", models.KindService, "v1", "redpanda-external", "redpanda",
		labels("app.kubernetes.io/name", "redpanda"),
		spec(models.ServiceSpec{
			Type:     models.ServiceNodePort,
			Selector: map[string]string{"app.kubernetes.io/name": "redpanda"},
			Ports: []models.ServicePort{
				{Name: "kafka", Protocol: "TCP", Port: 9094, TargetPort: 9094},
			},
		}))
	s.Add(redpandaExtSvc)
	s.AddEdge(edge(redpandaCR.ID, redpandaExtSvc.ID, models.EdgeOwns, ""))

	// 3 Redpanda broker Pods, each with its own PVC → PV (one disk per broker)
	for i := 0; i < 3; i++ {
		podID   := fmt.Sprintf("pod-redpanda-%d", i)
		pvcID   := fmt.Sprintf("pvc-redpanda-%d", i)
		pvID    := fmt.Sprintf("pv-redpanda-%d", i)
		podName := fmt.Sprintf("redpanda-%d", i)
		pvcName := fmt.Sprintf("datadir-redpanda-%d", i)
		pvName  := fmt.Sprintf("pv-redpanda-%d", i)

		pv := node(pvID, models.KindPV, "v1", pvName, "",
			nil, spec(models.PVSpec{Capacity: "20Gi", AccessModes: []string{"ReadWriteOnce"}}))
		s.Add(pv)

		pvc := node(pvcID, models.KindPVC, "v1", pvcName, "redpanda",
			labels("app.kubernetes.io/name", "redpanda"),
			spec(models.PVCSpec{AccessModes: []string{"ReadWriteOnce"}, Requests: "20Gi"}))
		pvc.Status = statusJSON(map[string]string{"phase": "Bound"})
		s.Add(pvc)
		s.AddEdge(edge(pvcID, pvID, models.EdgeBound, ""))

		// Redpanda pods have a real container structure:
		//   init: redpanda-configurator — renders bootstrap.yaml + TLS setup
		//   main: redpanda              — the broker process
		ps := models.PodSpec{
			Phase:    models.PodRunning,
			OwnerRef: redpandaSTS.ID,
			Labels:   map[string]string{"app.kubernetes.io/name": "redpanda"},
			ConfigMapRefs: []string{redpandaCM.ID},
			SecretRefs:    []string{redpandaSecret.ID},
			PVCRefs:       []string{pvcID},
			InitContainers: []models.ContainerInfo{
				{Name: "redpanda-configurator", Image: "docker.redpanda.com/redpandadata/redpanda-operator:v25.1.0", Role: "init"},
			},
			Containers: []models.ContainerInfo{
				{Name: "redpanda", Image: "docker.redpanda.com/redpandadata/redpanda:v25.1.1", Role: "main", Ports: []int{9092, 9644, 33145}},
			},
		}
		p := node(podID, models.KindPod, "v1", podName, "redpanda",
			map[string]string{"app.kubernetes.io/name": "redpanda"}, spec(ps))
		p.Status = statusJSON(map[string]string{"phase": string(models.PodRunning)})
		p.SimPhase = string(models.PodRunning)
		s.Add(p)
		s.AddEdge(edge(redpandaSTS.ID, podID, models.EdgeOwns, ""))
		s.AddEdge(edge(podID, pvcID, models.EdgeMounts, "datadir"))
		s.AddEdge(edge(redpandaHeadlessSvc.ID, podID, models.EdgeSelects, ""))
		s.AddEdge(edge(redpandaExtSvc.ID, podID, models.EdgeSelects, ""))
		s.AddEdge(edge(podID, redpandaCM.ID, models.EdgeMounts, "config"))
		s.AddEdge(edge(podID, redpandaSecret.ID, models.EdgeMounts, "sasl"))
	}
}

// --- helpers ---

func node(id, kind, apiVersion, name, namespace string, lbls map[string]string, specData json.RawMessage) *models.Node {
	return &models.Node{
		ID:         id,
		TypeMeta:   models.TypeMeta{APIVersion: apiVersion, Kind: kind},
		ObjectMeta: models.ObjectMeta{Name: name, Namespace: namespace, Labels: lbls},
		Spec:       specData,
	}
}

func podNode(id, name, namespace, _ string, lbls map[string]string, ownerRef string,
	cmRefs, secretRefs, pvcRefs []string) *models.Node {
	ps := models.PodSpec{
		Phase:         models.PodRunning,
		OwnerRef:      ownerRef,
		Labels:        lbls,
		ConfigMapRefs: cmRefs,
		SecretRefs:    secretRefs,
		PVCRefs:       pvcRefs,
	}
	n := node(id, models.KindPod, "v1", name, namespace, lbls, spec(ps))
	n.Status = statusJSON(map[string]string{"phase": string(models.PodRunning)})
	n.SimPhase = string(models.PodRunning)
	return n
}

func spec(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func statusJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func labels(kv ...string) map[string]string {
	m := make(map[string]string, len(kv)/2)
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

func edge(sourceID, targetID string, etype models.EdgeType, label string) *models.Edge {
	return &models.Edge{
		ID:     EdgeID(sourceID, targetID, etype),
		Source: sourceID,
		Target: targetID,
		Type:   etype,
		Label:  label,
	}
}
