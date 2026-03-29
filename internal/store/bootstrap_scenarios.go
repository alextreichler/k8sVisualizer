package store

import (
	"fmt"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// BootstrapControlPlane progressively adds the core control plane components,
// mimicking `kubeadm init` starting up the static pods.
func BootstrapControlPlane(s *ClusterStore, version string, onStep func(i, total int, label string)) {
	const total = 7

	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// Remove existing Control Plane nodes
	for _, id := range []string{
		"ns-kube-system", "cp-apiserver", "cp-etcd", "cp-scheduler", "cp-controller-manager",
	} {
		s.Delete(id)
	}
	s.ActiveVersion = version
	time.Sleep(100 * time.Millisecond)

	step(1, 0, "$ kubeadm init", nil)

	nsSystem := node("ns-kube-system", models.KindNamespace, "v1", "kube-system", "", nil, spec(models.ConfigMapSpec{}))
	step(2, 300*time.Millisecond, `namespace/kube-system created`, func() {
		s.Add(nsSystem)
	})

	apiServer := node("cp-apiserver", models.KindControlPlaneComponent, "v1", "kube-apiserver", "kube-system",
		labels("component", "kube-apiserver", "tier", "control-plane"), spec(models.PodSpec{}))
	etcd := node("cp-etcd", models.KindControlPlaneComponent, "v1", "etcd", "kube-system",
		labels("component", "etcd", "tier", "control-plane"), spec(models.PodSpec{}))
	scheduler := node("cp-scheduler", models.KindControlPlaneComponent, "v1", "kube-scheduler", "kube-system",
		labels("component", "kube-scheduler", "tier", "control-plane"), spec(models.PodSpec{}))
	controllerManager := node("cp-controller-manager", models.KindControlPlaneComponent, "v1", "kube-controller-manager", "kube-system",
		labels("component", "kube-controller-manager", "tier", "control-plane"), spec(models.PodSpec{}))

	step(3, 500*time.Millisecond, `[control-plane] starting etcd static pod`, func() {
		s.Add(etcd)
	})

	step(4, 500*time.Millisecond, `[control-plane] starting kube-apiserver static pod`, func() {
		s.Add(apiServer)
		s.AddEdge(edge(apiServer.ID, etcd.ID, models.EdgeStores, "persist"))
	})

	step(5, 400*time.Millisecond, `[control-plane] starting kube-controller-manager static pod`, func() {
		s.Add(controllerManager)
		s.AddEdge(edge(controllerManager.ID, apiServer.ID, models.EdgeWatches, "informer"))
	})

	step(6, 400*time.Millisecond, `[control-plane] starting kube-scheduler static pod`, func() {
		s.Add(scheduler)
		s.AddEdge(edge(scheduler.ID, apiServer.ID, models.EdgeWatches, "informer"))
	})

	step(7, 200*time.Millisecond, `✓ Your Kubernetes control-plane has initialized successfully!`, nil)
}

// BootstrapCoreDNS progressively adds the CoreDNS addon to the cluster,
// mimicking `kubectl apply -f coredns.yaml` output from kubeadm.
// Idempotent: removes existing CoreDNS nodes before re-adding them.
func BootstrapCoreDNS(s *ClusterStore, onStep func(i, total int, label string)) {
	const total = 10

	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// Remove existing CoreDNS nodes
	for _, id := range []string{
		"svc-kubedns", "pod-coredns-1", "pod-coredns-2", "rs-coredns", "deploy-coredns",
	} {
		s.Delete(id)
	}
	time.Sleep(100 * time.Millisecond)

	apiServerID := "cp-apiserver"

	step(1, 0, "$ kubectl apply -f https://github.com/coredns/deployment/blob/master/kubernetes/coredns.yaml.sed", nil)
	step(2, 300*time.Millisecond, `serviceaccount/coredns created`, nil)
	step(3, 200*time.Millisecond, `clusterrole.rbac.authorization.k8s.io/system:coredns created`, nil)
	step(4, 200*time.Millisecond, `clusterrolebinding.rbac.authorization.k8s.io/system:coredns created`, nil)

	coreDNSDeploy := node("deploy-coredns", models.KindDeployment, "apps/v1", "coredns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.DeploymentSpec{
			Replicas: 2,
			Selector: map[string]string{"k8s-app": "kube-dns"},
		}))
	coreDNSDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 2, ReadyReplicas: 0, AvailableReplicas: 0})
	step(5, 400*time.Millisecond, `deployment.apps/coredns created`, func() {
		s.Add(coreDNSDeploy)
		s.AddEdge(edge(coreDNSDeploy.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	coreDNSRS := node("rs-coredns", models.KindReplicaSet, "apps/v1", "coredns-rs-xyz99", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.ReplicaSetSpec{Replicas: 2, Selector: map[string]string{"k8s-app": "kube-dns"}, OwnerRef: coreDNSDeploy.ID}))
	step(6, 400*time.Millisecond, `  ReplicaSet coredns-rs-xyz99 created (desired: 2)`, func() {
		s.Add(coreDNSRS)
		s.AddEdge(edge(coreDNSDeploy.ID, coreDNSRS.ID, models.EdgeOwns, ""))
	})

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
	step(7, 300*time.Millisecond, `service/kube-dns created  (ClusterIP: 10.96.0.10, port 53/UDP+TCP)`, func() {
		s.Add(kubeDNSSvc)
	})

	for i := 1; i <= 2; i++ {
		idx := i
		p := podNode(fmt.Sprintf("pod-coredns-%d", idx), fmt.Sprintf("coredns-xyz99-%05d", idx),
			"kube-system", "coredns",
			map[string]string{"k8s-app": "kube-dns"}, coreDNSRS.ID, nil, nil, nil)
		p.SimPhase = "ContainerCreating"
		p.Status = statusJSON(map[string]string{"phase": "Pending"})
		label := fmt.Sprintf("  pod/coredns-xyz99-%05d  Pending → ContainerCreating → Running", idx)
		stepNum := 7 + idx
		delay := 600 * time.Millisecond
		s2 := s
		rs := coreDNSRS
		svc := kubeDNSSvc
		func(pod *models.Node, n, stepN int, dl time.Duration, lbl string) {
			step(stepN, dl, lbl, func() {
				s2.Add(pod)
				s2.AddEdge(edge(rs.ID, pod.ID, models.EdgeOwns, ""))
				s2.AddEdge(edge(svc.ID, pod.ID, models.EdgeSelects, ""))
			})
			time.Sleep(800 * time.Millisecond)
			pod.SimPhase = "Running"
			pod.Status = statusJSON(map[string]string{"phase": "Running"})
			s2.Update(pod)
		}(p, idx, stepNum, delay, label)
	}

	// Update Deployment status to ready
	coreDNSDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 2, ReadyReplicas: 2, AvailableReplicas: 2})
	s.Update(coreDNSDeploy)

	step(10, 200*time.Millisecond, `✓ CoreDNS is running — cluster DNS ready (kube-dns.kube-system.svc.cluster.local)`, nil)
}

// clearBootstrapNodes removes all well-known bootstrap node IDs so bootstrap
// functions can be called repeatedly (idempotent). Covers all CNI flavors,
// control-plane components, CoreDNS, kube-proxy, and extras (Traefik, k3s).
func clearBootstrapNodes(s *ClusterStore) {
	ids := []string{
		// control plane
		"ns-kube-system", "cp-apiserver", "cp-etcd", "cp-scheduler", "cp-controller-manager",
		"cp-managed",
		// coredns
		"deploy-coredns", "rs-coredns", "pod-coredns-1", "pod-coredns-2", "svc-kubedns",
		// kube-proxy
		"ds-kubeproxy", "pod-kubeproxy-1", "pod-kubeproxy-2", "pod-kubeproxy-3",
		// flannel
		"ns-kube-flannel", "cm-kube-flannel-cfg", "ds-kube-flannel",
		"pod-flannel-node1", "pod-flannel-node2", "pod-flannel-node3",
		// calico
		"ns-tigera-operator", "deploy-tigera-operator", "rs-tigera-operator", "pod-tigera-operator",
		"cr-calico-installation", "ns-calico-system",
		"ds-calico-node", "pod-calico-node-1", "pod-calico-node-2", "pod-calico-node-3",
		"deploy-calico-controllers", "rs-calico-controllers", "pod-calico-controllers",
		// cilium
		"cm-cilium-config", "ds-cilium",
		"pod-cilium-node1", "pod-cilium-node2", "pod-cilium-node3",
		"deploy-cilium-operator", "rs-cilium-operator", "pod-cilium-operator",
		// node-local-dns
		"cm-node-local-dns", "ds-node-local-dns",
		"pod-nodelocaldns-1", "pod-nodelocaldns-2", "pod-nodelocaldns-3",
		// k3s extras
		"ns-traefik", "deploy-traefik", "rs-traefik", "pod-traefik",
	}
	for _, id := range ids {
		s.Delete(id)
	}
}

// BootstrapCNI installs a CNI plugin. plugin must be "flannel", "calico", or "cilium".
func BootstrapCNI(s *ClusterStore, plugin string, onStep func(i, total int, label string)) {
	apiServerID := "cp-apiserver"

	// Remove existing CNI nodes for any plugin so this is idempotent
	for _, id := range []string{
		"ns-kube-flannel", "cm-kube-flannel-cfg", "ds-kube-flannel",
		"pod-flannel-node1", "pod-flannel-node2", "pod-flannel-node3",
		"ns-tigera-operator", "deploy-tigera-operator", "rs-tigera-operator", "pod-tigera-operator",
		"cr-calico-installation", "ns-calico-system",
		"ds-calico-node", "pod-calico-node-1", "pod-calico-node-2", "pod-calico-node-3",
		"deploy-calico-controllers", "rs-calico-controllers", "pod-calico-controllers",
		"cm-cilium-config", "ds-cilium",
		"pod-cilium-node1", "pod-cilium-node2", "pod-cilium-node3",
		"deploy-cilium-operator", "rs-cilium-operator", "pod-cilium-operator",
	} {
		s.Delete(id)
	}
	time.Sleep(100 * time.Millisecond)

	switch plugin {
	case "calico":
		bootstrapCalico(s, apiServerID, onStep)
	case "cilium":
		bootstrapCilium(s, apiServerID, onStep)
	default: // flannel
		bootstrapFlannel(s, apiServerID, onStep)
	}
}

func bootstrapFlannel(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 10
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, "$ kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml", nil)

	nsFlannel := node("ns-kube-flannel", models.KindNamespace, "v1", "kube-flannel", "", nil, spec(models.ConfigMapSpec{}))
	step(2, 300*time.Millisecond, "namespace/kube-flannel created", func() { s.Add(nsFlannel) })

	step(3, 200*time.Millisecond, "clusterrole.rbac/flannel + clusterrolebinding/flannel created  (get/list/watch Nodes, Pods; manage network resources)", nil)

	flannelCM := node("cm-kube-flannel-cfg", models.KindConfigMap, "v1", "kube-flannel-cfg", "kube-flannel",
		labels("app", "flannel"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"net-conf.json": `{"Network":"10.244.0.0/16","Backend":{"Type":"vxlan"}}`,
			"cni-conf.json": `{"name":"cbr0","cniVersion":"0.3.1","plugins":[{"type":"flannel"},{"type":"portmap"}]}`,
		}}))
	step(4, 300*time.Millisecond, "configmap/kube-flannel-cfg created  (Network: 10.244.0.0/16, Backend: vxlan)", func() { s.Add(flannelCM) })

	flannelDS := node("ds-kube-flannel", models.KindDaemonSet, "apps/v1", "kube-flannel-ds", "kube-flannel",
		labels("app", "flannel"),
		spec(models.DaemonSetSpec{Selector: map[string]string{"app": "flannel"}}))
	flannelDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 0, DesiredNumberScheduled: 3})
	step(5, 400*time.Millisecond, "daemonset.apps/kube-flannel-ds created  (scheduled on 3 nodes — one VXLAN tunnel per node)", func() {
		s.Add(flannelDS)
		s.AddEdge(edge(flannelDS.ID, apiServerID, models.EdgeWatches, "informer"))
		s.AddEdge(edge(flannelDS.ID, "cm-kube-flannel-cfg", models.EdgeMounts, "config"))
	})

	for i := 1; i <= 3; i++ {
		idx := i
		podID := fmt.Sprintf("pod-flannel-node%d", idx)
		ps := models.PodSpec{
			Phase:    models.PodPending,
			OwnerRef: flannelDS.ID,
			Labels:   map[string]string{"app": "flannel"},
			InitContainers: []models.ContainerInfo{
				{Name: "install-cni", Image: "docker.io/flannel/flannel-cni-plugin:v1.4.0", Role: "init"},
			},
			Containers: []models.ContainerInfo{
				{Name: "kube-flannel", Image: "docker.io/flannel/flannel:v0.24.0", Role: "main"},
			},
		}
		p := node(podID, models.KindPod, "v1", fmt.Sprintf("kube-flannel-node%d", idx), "kube-flannel",
			map[string]string{"app": "flannel"}, spec(ps))
		p.SimPhase = string(models.PodPending)
		p.Status = statusJSON(map[string]string{"phase": "Pending"})

		var runLabel string
		switch idx {
		case 1:
			runLabel = fmt.Sprintf("  pod/kube-flannel-node%d: Running ✓  — VXLAN tunnel interface flannel.1 created", idx)
		case 2:
			runLabel = fmt.Sprintf("  pod/kube-flannel-node%d: Running ✓  — route to 10.244.1.0/24 via node2 added", idx)
		case 3:
			runLabel = fmt.Sprintf("  pod/kube-flannel-node%d: Running ✓  — all nodes in pod network 10.244.0.0/16", idx)
		}

		step(5+idx, 500*time.Millisecond, fmt.Sprintf("  pod/kube-flannel-node%d: Pending → ContainerCreating  (init: copying CNI binaries to /opt/cni/bin)", idx), func() {
			s.Add(p)
			s.AddEdge(edge(flannelDS.ID, podID, models.EdgeOwns, ""))
		})
		time.Sleep(700 * time.Millisecond)
		p.SimPhase = string(models.PodRunning)
		p.Status = statusJSON(map[string]string{"phase": "Running"})
		s.Update(p)
		onStep(5+idx, total, runLabel)
	}

	flannelDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 3, DesiredNumberScheduled: 3})
	s.Update(flannelDS)
	onStep(total, total, "✓ Flannel CNI ready — pod CIDR: 10.244.0.0/16, backend: vxlan.  Cross-node pod communication enabled.")
}

func bootstrapCalico(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 16
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, "$ kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/tigera-operator.yaml", nil)

	nsTigera := node("ns-tigera-operator", models.KindNamespace, "v1", "tigera-operator", "", nil, spec(models.ConfigMapSpec{}))
	step(2, 300*time.Millisecond, "namespace/tigera-operator created", func() { s.Add(nsTigera) })

	step(3, 200*time.Millisecond, "CRDs installed: installations.operator.tigera.io, ipamblocks.crd.projectcalico.org, networkpolicies.crd.projectcalico.org …  (6 CRDs)", nil)
	step(4, 200*time.Millisecond, "serviceaccount/tigera-operator + clusterrole/tigera-operator created", nil)

	tigeraDeploy := node("deploy-tigera-operator", models.KindDeployment, "apps/v1", "tigera-operator", "tigera-operator",
		labels("app.kubernetes.io/name", "tigera-operator"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "tigera-operator"}}))
	tigeraDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1})
	step(5, 400*time.Millisecond, "deployment.apps/tigera-operator created  (watches Installation CR, reconciles Calico components)", func() {
		s.Add(tigeraDeploy)
		s.AddEdge(edge(tigeraDeploy.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	tigeraRS := node("rs-tigera-operator", models.KindReplicaSet, "apps/v1", "tigera-operator-rs", "tigera-operator",
		labels("app.kubernetes.io/name", "tigera-operator"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "tigera-operator"}, OwnerRef: tigeraDeploy.ID}))
	step(6, 300*time.Millisecond, "  ↳ replicaset/tigera-operator-rs spawned", func() {
		s.Add(tigeraRS)
		s.AddEdge(edge(tigeraDeploy.ID, tigeraRS.ID, models.EdgeOwns, ""))
	})

	tigeraPod := podNode("pod-tigera-operator", "tigera-operator-abc12", "tigera-operator", "tigera-operator",
		map[string]string{"app.kubernetes.io/name": "tigera-operator"}, tigeraRS.ID, nil, nil, nil)
	tigeraPod.SimPhase = "ContainerCreating"
	step(7, 600*time.Millisecond, "  ↳ pod/tigera-operator-abc12: Running ✓  — operator watching for Installation CRs", func() {
		s.Add(tigeraPod)
		s.AddEdge(edge(tigeraRS.ID, tigeraPod.ID, models.EdgeOwns, ""))
		tigeraPod.SimPhase = string(models.PodRunning)
		tigeraPod.Status = statusJSON(map[string]string{"phase": "Running"})
		s.Update(tigeraPod)
	})

	step(8, 300*time.Millisecond, "$ kubectl create -f custom-resources.yaml  (Installation CR — triggers Calico deployment)", nil)

	calicoInstall := node("cr-calico-installation", models.KindCustomResource, "operator.tigera.io/v1", "default", "default",
		labels("app.kubernetes.io/name", "calico"),
		spec(models.ConfigMapSpec{}))
	step(9, 400*time.Millisecond, "Installation/default created  — tigera-operator detected CR, reconciliation started", func() {
		s.Add(calicoInstall)
		s.AddEdge(edge(tigeraDeploy.ID, calicoInstall.ID, models.EdgeWatches, "reconcile"))
	})

	step(10, 400*time.Millisecond, "tigera-operator: IPPool 10.244.0.0/16 configured  (CIDR for pod IPs, IPIP mode: Never, VXLAN: Always)", nil)

	nsCalico := node("ns-calico-system", models.KindNamespace, "v1", "calico-system", "", nil, spec(models.ConfigMapSpec{}))
	step(11, 300*time.Millisecond, "namespace/calico-system created  (tigera-operator manages all resources here)", func() { s.Add(nsCalico) })

	calicoNodeDS := node("ds-calico-node", models.KindDaemonSet, "apps/v1", "calico-node", "calico-system",
		labels("app.kubernetes.io/name", "calico-node"),
		spec(models.DaemonSetSpec{Selector: map[string]string{"app.kubernetes.io/name": "calico-node"}}))
	calicoNodeDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 0, DesiredNumberScheduled: 3})
	step(12, 400*time.Millisecond, "daemonset.apps/calico-node created  (Felix policy agent + BIRD BGP daemon on each node)", func() {
		s.Add(calicoNodeDS)
		s.AddEdge(edge(calicoInstall.ID, calicoNodeDS.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(calicoNodeDS.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	for i := 1; i <= 3; i++ {
		idx := i
		podID := fmt.Sprintf("pod-calico-node-%d", idx)
		p := podNode(podID, fmt.Sprintf("calico-node-node%d", idx), "calico-system", "calico-node",
			map[string]string{"app.kubernetes.io/name": "calico-node"}, calicoNodeDS.ID, nil, nil, nil)
		p.SimPhase = string(models.PodRunning)
		s.Add(p)
		s.AddEdge(edge(calicoNodeDS.ID, podID, models.EdgeOwns, ""))
	}
	calicoNodeDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 3, DesiredNumberScheduled: 3})
	s.Update(calicoNodeDS)
	step(13, 700*time.Millisecond, "calico-node: 3/3 Running ✓  — Felix started, BGP peering established between nodes", nil)

	calicoCtrlDeploy := node("deploy-calico-controllers", models.KindDeployment, "apps/v1", "calico-kube-controllers", "calico-system",
		labels("app.kubernetes.io/name", "calico-kube-controllers"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "calico-kube-controllers"}}))
	calicoCtrlDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1, ReadyReplicas: 1})
	step(14, 400*time.Millisecond, "deployment.apps/calico-kube-controllers created  (syncs K8s NetworkPolicy → Calico policy)", func() {
		s.Add(calicoCtrlDeploy)
		s.AddEdge(edge(calicoInstall.ID, calicoCtrlDeploy.ID, models.EdgeOwns, ""))
	})

	calicoCtrlRS := node("rs-calico-controllers", models.KindReplicaSet, "apps/v1", "calico-kube-controllers-rs", "calico-system",
		labels("app.kubernetes.io/name", "calico-kube-controllers"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "calico-kube-controllers"}, OwnerRef: calicoCtrlDeploy.ID}))
	calicoCtrlPod := podNode("pod-calico-controllers", "calico-kube-controllers-xyz12", "calico-system", "calico-kube-controllers",
		map[string]string{"app.kubernetes.io/name": "calico-kube-controllers"}, calicoCtrlRS.ID, nil, nil, nil)
	calicoCtrlPod.SimPhase = string(models.PodRunning)
	step(15, 400*time.Millisecond, "  ↳ pod/calico-kube-controllers: Running ✓", func() {
		s.Add(calicoCtrlRS)
		s.AddEdge(edge(calicoCtrlDeploy.ID, calicoCtrlRS.ID, models.EdgeOwns, ""))
		s.Add(calicoCtrlPod)
		s.AddEdge(edge(calicoCtrlRS.ID, calicoCtrlPod.ID, models.EdgeOwns, ""))
	})

	step(16, 200*time.Millisecond, "✓ Calico CNI ready — NetworkPolicy enforcement active, BGP peering configured.  Use `calicoctl get nodes` to inspect.", nil)
}

func bootstrapCilium(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 12
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	step(1, 0, "$ helm repo add cilium https://helm.cilium.io/", nil)
	step(2, 400*time.Millisecond, "$ helm install cilium cilium/cilium -n kube-system --set kubeProxyReplacement=true --set k8sServiceHost=auto", nil)

	ciliumCM := node("cm-cilium-config", models.KindConfigMap, "v1", "cilium-config", "kube-system",
		labels("app.kubernetes.io/name", "cilium"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"kube-proxy-replacement": "true",
			"tunnel":                 "vxlan",
			"enable-bpf-masquerade": "true",
			"bpf-lb-algorithm":      "random",
		}}))
	step(3, 400*time.Millisecond, "configmap/cilium-config created  (kube-proxy-replacement=true, tunnel=vxlan, bpf-masquerade=true)", func() {
		s.Add(ciliumCM)
	})

	step(4, 200*time.Millisecond, "serviceaccount/cilium + clusterrole/cilium-operator created  (get/list/watch Nodes, Endpoints, Services…)", nil)

	ciliumDS := node("ds-cilium", models.KindDaemonSet, "apps/v1", "cilium", "kube-system",
		labels("k8s-app", "cilium"),
		spec(models.DaemonSetSpec{Selector: map[string]string{"k8s-app": "cilium"}}))
	ciliumDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 0, DesiredNumberScheduled: 3})
	step(5, 400*time.Millisecond, "daemonset.apps/cilium created  — loading eBPF programs, replacing iptables rules", func() {
		s.Add(ciliumDS)
		s.AddEdge(edge(ciliumDS.ID, apiServerID, models.EdgeWatches, "informer"))
		s.AddEdge(edge(ciliumDS.ID, ciliumCM.ID, models.EdgeMounts, "config"))
	})

	for i := 1; i <= 3; i++ {
		idx := i
		podID := fmt.Sprintf("pod-cilium-node%d", idx)
		ps := models.PodSpec{
			Phase:    models.PodRunning,
			OwnerRef: ciliumDS.ID,
			Labels:   map[string]string{"k8s-app": "cilium"},
			InitContainers: []models.ContainerInfo{
				{Name: "mount-cgroup", Image: "quay.io/cilium/cilium:v1.15.0", Role: "init"},
				{Name: "apply-sysctl-overwrites", Image: "quay.io/cilium/cilium:v1.15.0", Role: "init"},
			},
			Containers: []models.ContainerInfo{
				{Name: "cilium-agent", Image: "quay.io/cilium/cilium:v1.15.0", Role: "main"},
			},
		}
		p := node(podID, models.KindPod, "v1", fmt.Sprintf("cilium-node%d", idx), "kube-system",
			map[string]string{"k8s-app": "cilium"}, spec(ps))
		var runLabel string
		switch idx {
		case 1:
			runLabel = fmt.Sprintf("  pod/cilium-node%d: Running ✓  — eBPF datapath loaded, kube-proxy rules replaced", idx)
		case 2:
			runLabel = fmt.Sprintf("  pod/cilium-node%d: Running ✓  — BPF NodePort enabled, service load-balancing via BPF maps", idx)
		case 3:
			runLabel = fmt.Sprintf("  pod/cilium-node%d: Running ✓  — all nodes meshed, identity-based policy enforcement active", idx)
		}
		p.SimPhase = string(models.PodRunning)
		p.Status = statusJSON(map[string]string{"phase": "Running"})
		step(5+idx, 600*time.Millisecond, runLabel, func() {
			s.Add(p)
			s.AddEdge(edge(ciliumDS.ID, podID, models.EdgeOwns, ""))
		})
	}
	ciliumDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 3, DesiredNumberScheduled: 3})
	s.Update(ciliumDS)

	ciliumOpDeploy := node("deploy-cilium-operator", models.KindDeployment, "apps/v1", "cilium-operator", "kube-system",
		labels("io.cilium/app", "operator"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"io.cilium/app": "operator"}}))
	ciliumOpRS := node("rs-cilium-operator", models.KindReplicaSet, "apps/v1", "cilium-operator-rs", "kube-system",
		labels("io.cilium/app", "operator"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"io.cilium/app": "operator"}, OwnerRef: ciliumOpDeploy.ID}))
	ciliumOpPod := podNode("pod-cilium-operator", "cilium-operator-xyz99", "kube-system", "cilium-operator",
		map[string]string{"io.cilium/app": "operator"}, ciliumOpRS.ID, nil, nil, nil)
	ciliumOpPod.SimPhase = string(models.PodRunning)
	step(9, 500*time.Millisecond, "deployment.apps/cilium-operator created → Running ✓  — managing IPAM, CNP enforcement", func() {
		ciliumOpDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1, ReadyReplicas: 1})
		s.Add(ciliumOpDeploy)
		s.Add(ciliumOpRS)
		s.AddEdge(edge(ciliumOpDeploy.ID, ciliumOpRS.ID, models.EdgeOwns, ""))
		s.Add(ciliumOpPod)
		s.AddEdge(edge(ciliumOpRS.ID, ciliumOpPod.ID, models.EdgeOwns, ""))
	})

	// Note: kube-proxy is replaced by Cilium — no need to install it
	step(10, 200*time.Millisecond, "NOTE: Cilium replaced kube-proxy — iptables-based service routing removed, BPF maps used instead", nil)
	step(11, 200*time.Millisecond, "cilium status: OK  (1 local node(s) running Cilium, 3/3 nodes reachable)", nil)
	step(12, 0, "✓ Cilium CNI ready — eBPF datapath, kube-proxy replacement, identity-based NetworkPolicy.  Enable Hubble: cilium hubble enable", nil)
}

// BootstrapNodeLocalDNS adds the NodeLocal DNSCache DaemonSet as an optional
// performance addon that caches DNS queries on each node before they reach CoreDNS.
func BootstrapNodeLocalDNS(s *ClusterStore, onStep func(i, total int, label string)) {
	const total = 8
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	for _, id := range []string{"cm-node-local-dns", "ds-node-local-dns", "pod-nodelocaldns-1", "pod-nodelocaldns-2", "pod-nodelocaldns-3"} {
		s.Delete(id)
	}
	time.Sleep(100 * time.Millisecond)

	apiServerID := "cp-apiserver"

	step(1, 0, "$ kubectl apply -f https://raw.githubusercontent.com/kubernetes/kubernetes/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml", nil)
	step(2, 200*time.Millisecond, "serviceaccount/node-local-dns + ClusterRole created  (get/list/watch Endpoints, Services)", nil)

	nlDNSCM := node("cm-node-local-dns", models.KindConfigMap, "v1", "node-local-dns", "kube-system",
		labels("k8s-app", "node-local-dns"),
		spec(models.ConfigMapSpec{Data: map[string]string{
			"Corefile": "cluster.local:53 { cache 30; forward . 169.254.20.10; }\nin-addr.arpa:53 { cache 30; forward . 169.254.20.10; }",
		}}))
	step(3, 300*time.Millisecond, "configmap/node-local-dns created  (local cache: 30s for cluster.local, upstream: 169.254.20.10 → CoreDNS)", func() {
		s.Add(nlDNSCM)
	})

	nlDNSDS := node("ds-node-local-dns", models.KindDaemonSet, "apps/v1", "node-local-dns", "kube-system",
		labels("k8s-app", "node-local-dns"),
		spec(models.DaemonSetSpec{Selector: map[string]string{"k8s-app": "node-local-dns"}}))
	nlDNSDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 0, DesiredNumberScheduled: 3})
	step(4, 400*time.Millisecond, "daemonset.apps/node-local-dns created  (binds 169.254.20.10:53 on each node)", func() {
		s.Add(nlDNSDS)
		s.AddEdge(edge(nlDNSDS.ID, apiServerID, models.EdgeWatches, "informer"))
		s.AddEdge(edge(nlDNSDS.ID, nlDNSCM.ID, models.EdgeMounts, "config"))
		s.AddEdge(edge(nlDNSDS.ID, "svc-kubedns", models.EdgeWatches, "upstream"))
	})

	for i := 1; i <= 3; i++ {
		idx := i
		podID := fmt.Sprintf("pod-nodelocaldns-%d", idx)
		p := podNode(podID, fmt.Sprintf("node-local-dns-node%d", idx), "kube-system", "node-local-dns",
			map[string]string{"k8s-app": "node-local-dns"}, nlDNSDS.ID, nil, nil, nil)
		p.SimPhase = string(models.PodRunning)
		step(4+idx, 400*time.Millisecond, fmt.Sprintf("  pod/node-local-dns-node%d: Running ✓", idx), func() {
			s.Add(p)
			s.AddEdge(edge(nlDNSDS.ID, podID, models.EdgeOwns, ""))
		})
	}

	nlDNSDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 3, DesiredNumberScheduled: 3})
	s.Update(nlDNSDS)
	step(8, 200*time.Millisecond, "✓ NodeLocal DNSCache ready — DNS queries served from 169.254.20.10:53 (local cache) before reaching CoreDNS.  Reduces latency & CoreDNS load.", nil)
}

// BootstrapManaged simulates provisioning a managed Kubernetes cluster
// (EKS, GKE, or AKS) where the control plane is fully managed by the cloud provider.
func BootstrapManaged(s *ClusterStore, provider, version string, onStep func(i, total int, label string)) {
	const total = 10
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	clearBootstrapNodes(s)
	s.ActiveVersion = version
	time.Sleep(200 * time.Millisecond)

	var createCmd, providerLabel, cniName string
	switch provider {
	case "gke":
		createCmd = "$ gcloud container clusters create my-cluster --num-nodes=3 --region=us-central1"
		providerLabel = "Google GKE"
		cniName = "kubenet"
	case "aks":
		createCmd = "$ az aks create -g myResourceGroup -n myCluster --node-count 3"
		providerLabel = "Azure AKS"
		cniName = "azure-cni"
	default: // eks
		createCmd = "$ aws eks create-cluster --name my-cluster --kubernetes-version " + version + " --role-arn arn:aws:iam::…"
		providerLabel = "Amazon EKS"
		cniName = "aws-vpc-cni"
	}

	step(1, 0, createCmd, nil)
	step(2, 500*time.Millisecond, "Provisioning control plane  (this typically takes 10–15 minutes in a real cluster)…", nil)
	step(3, 600*time.Millisecond, "Control plane nodes starting — etcd, kube-apiserver, kube-controller-manager, kube-scheduler", nil)
	step(4, 600*time.Millisecond, "etcd cluster healthy — 3-node etcd quorum provisioned by cloud provider  (not visible to you)", nil)
	step(5, 500*time.Millisecond, "kube-apiserver available — regional endpoint provisioned behind cloud load balancer", nil)

	nsSystem := node("ns-kube-system", models.KindNamespace, "v1", "kube-system", "", nil, spec(models.ConfigMapSpec{}))
	managedCP := node("cp-managed", models.KindControlPlaneComponent, "v1", providerLabel+" Control Plane", "kube-system",
		labels("tier", "control-plane", "provider", provider),
		spec(models.PodSpec{}))
	step(6, 400*time.Millisecond, "✓ "+providerLabel+" control plane ready — fully managed  (etcd, apiserver, scheduler, controller-manager hidden behind cloud API)", func() {
		s.Add(nsSystem)
		s.Add(managedCP)
	})

	step(7, 300*time.Millisecond, "kubeconfig updated — kubectl context set to managed cluster endpoint", nil)

	// Auto-provision CoreDNS (always present in managed clusters)
	coreDNSDeploy := node("deploy-coredns", models.KindDeployment, "apps/v1", "coredns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.DeploymentSpec{Replicas: 2, Selector: map[string]string{"k8s-app": "kube-dns"}}))
	coreDNSDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 2, ReadyReplicas: 2, AvailableReplicas: 2})
	kubeDNSSvc := node("svc-kubedns", models.KindService, "v1", "kube-dns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.ServiceSpec{Type: models.ServiceClusterIP, ClusterIP: "10.96.0.10",
			Selector: map[string]string{"k8s-app": "kube-dns"},
			Ports:    []models.ServicePort{{Name: "dns", Protocol: "UDP", Port: 53, TargetPort: 53}},
		}))
	step(8, 400*time.Millisecond, "CoreDNS deployed automatically  (managed clusters always include DNS — 2 replicas, HA)", func() {
		s.Add(coreDNSDeploy)
		s.Add(kubeDNSSvc)
		for i := 1; i <= 2; i++ {
			p := podNode(fmt.Sprintf("pod-coredns-%d", i), fmt.Sprintf("coredns-managed-%d", i),
				"kube-system", "coredns", map[string]string{"k8s-app": "kube-dns"}, coreDNSDeploy.ID, nil, nil, nil)
			p.SimPhase = string(models.PodRunning)
			s.Add(p)
			s.AddEdge(edge(kubeDNSSvc.ID, p.ID, models.EdgeSelects, ""))
		}
	})

	step(9, 400*time.Millisecond, cniName+" deployed automatically  ("+providerLabel+" manages the CNI — pod network provisioned by cloud)", nil)
	step(10, 200*time.Millisecond, "✓ "+providerLabel+" cluster ready — 3 worker nodes available.  Control plane fully managed by cloud provider.", nil)
}

// BootstrapK3s simulates installing k3s, which bundles Flannel CNI, CoreDNS,
// Traefik ingress, and local-path-provisioner into a single install command.
func BootstrapK3s(s *ClusterStore, version string, onStep func(i, total int, label string)) {
	const total = 15
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	clearBootstrapNodes(s)
	s.ActiveVersion = version
	time.Sleep(200 * time.Millisecond)

	step(1, 0, "$ curl -sfL https://get.k3s.io | sh -", nil)
	step(2, 400*time.Millisecond, "[k3s] Starting k3s server v"+version+"  (single binary: apiserver+etcd+scheduler+controller-manager+kubelet+flannel)", nil)

	nsSystem := node("ns-kube-system", models.KindNamespace, "v1", "kube-system", "", nil, spec(models.ConfigMapSpec{}))
	step(3, 400*time.Millisecond, "namespace/kube-system created", func() { s.Add(nsSystem) })

	apiServer := node("cp-apiserver", models.KindControlPlaneComponent, "v1", "kube-apiserver", "kube-system",
		labels("component", "kube-apiserver", "tier", "control-plane"), spec(models.PodSpec{}))
	etcd := node("cp-etcd", models.KindControlPlaneComponent, "v1", "etcd", "kube-system",
		labels("component", "etcd", "tier", "control-plane"), spec(models.PodSpec{}))
	scheduler := node("cp-scheduler", models.KindControlPlaneComponent, "v1", "kube-scheduler", "kube-system",
		labels("component", "kube-scheduler", "tier", "control-plane"), spec(models.PodSpec{}))
	controllerMgr := node("cp-controller-manager", models.KindControlPlaneComponent, "v1", "kube-controller-manager", "kube-system",
		labels("component", "kube-controller-manager", "tier", "control-plane"), spec(models.PodSpec{}))

	step(4, 500*time.Millisecond, "[k3s] Starting embedded etcd  (SQLite-backed by default for single-node, etcd for HA)", func() {
		s.Add(etcd)
	})
	step(5, 400*time.Millisecond, "[k3s] kube-apiserver + kube-controller-manager + kube-scheduler running  (static pods)", func() {
		s.Add(apiServer)
		s.Add(scheduler)
		s.Add(controllerMgr)
		s.AddEdge(edge(apiServer.ID, etcd.ID, models.EdgeStores, "persist"))
		s.AddEdge(edge(scheduler.ID, apiServer.ID, models.EdgeWatches, "informer"))
		s.AddEdge(edge(controllerMgr.ID, apiServer.ID, models.EdgeWatches, "informer"))
	})

	// Built-in CoreDNS
	coreDNSDeploy := node("deploy-coredns", models.KindDeployment, "apps/v1", "coredns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"k8s-app": "kube-dns"}}))
	coreDNSDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1, ReadyReplicas: 1, AvailableReplicas: 1})
	kubeDNSSvc := node("svc-kubedns", models.KindService, "v1", "kube-dns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.ServiceSpec{Type: models.ServiceClusterIP, ClusterIP: "10.43.0.10",
			Selector: map[string]string{"k8s-app": "kube-dns"},
			Ports:    []models.ServicePort{{Name: "dns", Protocol: "UDP", Port: 53, TargetPort: 53}},
		}))
	corednsP := podNode("pod-coredns-1", "coredns-k3s-1", "kube-system", "coredns",
		map[string]string{"k8s-app": "kube-dns"}, coreDNSDeploy.ID, nil, nil, nil)
	corednsP.SimPhase = string(models.PodRunning)
	step(6, 500*time.Millisecond, "[k3s] Deploying CoreDNS  (built-in, 1 replica — cluster DNS ready)", func() {
		s.Add(coreDNSDeploy)
		s.Add(kubeDNSSvc)
		s.Add(corednsP)
		s.AddEdge(edge(kubeDNSSvc.ID, corednsP.ID, models.EdgeSelects, ""))
	})

	// Built-in Flannel — k3s embeds Flannel in its agent; no separate kube-flannel
	// namespace. The DaemonSet and pods live in kube-system (k3s ≥ v1.21).
	flannelDS := node("ds-kube-flannel", models.KindDaemonSet, "apps/v1", "kube-flannel-ds", "kube-system",
		labels("app", "flannel"),
		spec(models.DaemonSetSpec{Selector: map[string]string{"app": "flannel"}}))
	flannelDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 1, DesiredNumberScheduled: 1})
	flannelP := podNode("pod-flannel-node1", "kube-flannel-k3s", "kube-system", "flannel",
		map[string]string{"app": "flannel"}, flannelDS.ID, nil, nil, nil)
	flannelP.SimPhase = string(models.PodRunning)
	step(7, 500*time.Millisecond, "[k3s] Flannel CNI active  (embedded in k3s agent, DaemonSet in kube-system, VXLAN, pod CIDR: 10.42.0.0/16)", func() {
		s.Add(flannelDS)
		s.Add(flannelP)
		s.AddEdge(edge(flannelDS.ID, flannelP.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(flannelDS.ID, apiServer.ID, models.EdgeWatches, "informer"))
	})

	// Built-in kube-proxy (iptables)
	kubeProxyDS := node("ds-kubeproxy", models.KindDaemonSet, "apps/v1", "kube-proxy", "kube-system",
		labels("k8s-app", "kube-proxy"),
		spec(models.DaemonSetSpec{Selector: map[string]string{"k8s-app": "kube-proxy"}}))
	kubeProxyDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 1, DesiredNumberScheduled: 1})
	kubeProxyP := podNode("pod-kubeproxy-1", "kube-proxy-k3s", "kube-system", "kube-proxy",
		map[string]string{"k8s-app": "kube-proxy"}, kubeProxyDS.ID, nil, nil, nil)
	kubeProxyP.SimPhase = string(models.PodRunning)
	step(8, 400*time.Millisecond, "[k3s] kube-proxy deployed  (iptables mode, single node)", func() {
		s.Add(kubeProxyDS)
		s.Add(kubeProxyP)
		s.AddEdge(edge(kubeProxyDS.ID, kubeProxyP.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(kubeProxyDS.ID, apiServer.ID, models.EdgeWatches, "informer"))
	})

	// Built-in Traefik ingress
	nsTraefik := node("ns-traefik", models.KindNamespace, "v1", "kube-system", "", nil, spec(models.ConfigMapSpec{}))
	traefikDeploy := node("deploy-traefik", models.KindDeployment, "apps/v1", "traefik", "kube-system",
		labels("app.kubernetes.io/name", "traefik"),
		spec(models.DeploymentSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "traefik"}}))
	traefikDeploy.Status = statusJSON(models.DeploymentStatus{Replicas: 1, ReadyReplicas: 1})
	traefikRS := node("rs-traefik", models.KindReplicaSet, "apps/v1", "traefik-rs", "kube-system",
		labels("app.kubernetes.io/name", "traefik"),
		spec(models.ReplicaSetSpec{Replicas: 1, Selector: map[string]string{"app.kubernetes.io/name": "traefik"}, OwnerRef: traefikDeploy.ID}))
	traefikPod := podNode("pod-traefik", "traefik-k3s-xyz99", "kube-system", "traefik",
		map[string]string{"app.kubernetes.io/name": "traefik"}, traefikRS.ID, nil, nil, nil)
	traefikPod.SimPhase = string(models.PodRunning)
	_ = nsTraefik // namespace is kube-system for k3s traefik
	step(9, 500*time.Millisecond, "[k3s] Deploying Traefik ingress controller  (built-in HTTP/HTTPS reverse proxy on ports :80 :443)", func() {
		s.Add(traefikDeploy)
		s.Add(traefikRS)
		s.Add(traefikPod)
		s.AddEdge(edge(traefikDeploy.ID, traefikRS.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(traefikRS.ID, traefikPod.ID, models.EdgeOwns, ""))
		s.AddEdge(edge(traefikDeploy.ID, apiServer.ID, models.EdgeWatches, "informer"))
	})

	step(10, 300*time.Millisecond, "[k3s] local-path-provisioner deployed  (default StorageClass: rancher.io/local-path — auto-creates HostPath PVs)", nil)
	step(11, 200*time.Millisecond, "[k3s] metrics-server deployed  (HPA + kubectl top enabled by default)", nil)
	step(12, 200*time.Millisecond, "[k3s] Writing kubeconfig to /etc/rancher/k3s/k3s.yaml", nil)

	step(13, 200*time.Millisecond, "✓ k3s cluster ready  (all-in-one: control plane + Flannel CNI + CoreDNS + Traefik + local-path storage)", nil)
	step(14, 0, "Tip: k3s has the same API as standard K8s — use kubectl, helm, and any K8s tooling as normal.", nil)
	step(15, 0, "Tip: kube-proxy replacement via Cilium: k3s install with --flannel-backend=none --disable-kube-proxy + helm install cilium", nil)
}

// BootstrapKubeProxy progressively adds the kube-proxy DaemonSet,
// mimicking kubeadm's DaemonSet apply step.
func BootstrapKubeProxy(s *ClusterStore, onStep func(i, total int, label string)) {
	const total = 9

	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// Remove existing kube-proxy nodes
	for _, id := range []string{
		"pod-kubeproxy-1", "pod-kubeproxy-2", "pod-kubeproxy-3", "ds-kubeproxy",
	} {
		s.Delete(id)
	}
	time.Sleep(100 * time.Millisecond)

	apiServerID := "cp-apiserver"

	step(1, 0, "$ kubectl apply -f kube-proxy.yaml  (DaemonSet — one pod per node)", nil)
	step(2, 300*time.Millisecond, `serviceaccount/kube-proxy created`, nil)
	step(3, 200*time.Millisecond, `clusterrolebinding.rbac.authorization.k8s.io/kubeadm:node-proxier created`, nil)

	kubeProxyDS := node("ds-kubeproxy", models.KindDaemonSet, "apps/v1", "kube-proxy", "kube-system",
		labels("k8s-app", "kube-proxy"),
		spec(models.DaemonSetSpec{
			Selector: map[string]string{"k8s-app": "kube-proxy"},
		}))
	kubeProxyDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 0, DesiredNumberScheduled: 3})
	step(4, 400*time.Millisecond, `daemonset.apps/kube-proxy created  (scheduled on 3 nodes)`, func() {
		s.Add(kubeProxyDS)
		s.AddEdge(edge(kubeProxyDS.ID, apiServerID, models.EdgeWatches, "informer"))
	})

	for i := 1; i <= 3; i++ {
		idx := i
		podID := fmt.Sprintf("pod-kubeproxy-%d", idx)
		p := podNode(podID, fmt.Sprintf("kube-proxy-node%d", idx),
			"kube-system", "kube-proxy",
			map[string]string{"k8s-app": "kube-proxy"}, kubeProxyDS.ID, nil, nil, nil)
		p.SimPhase = "ContainerCreating"
		p.Status = statusJSON(map[string]string{"phase": "Pending"})
		s2 := s
		ds := kubeProxyDS
		func(pod *models.Node, n int) {
			step(4+n, 500*time.Millisecond, fmt.Sprintf("  pod/kube-proxy-node%d  Pending → ContainerCreating → Running", n), func() {
				s2.Add(pod)
				s2.AddEdge(edge(ds.ID, pod.ID, models.EdgeOwns, ""))
			})
			time.Sleep(700 * time.Millisecond)
			pod.SimPhase = "Running"
			pod.Status = statusJSON(map[string]string{"phase": "Running"})
			s2.Update(pod)
		}(p, idx)
	}

	kubeProxyDS.Status = statusJSON(models.DaemonSetStatus{NumberReady: 3, DesiredNumberScheduled: 3})
	s.Update(kubeProxyDS)

	step(9, 200*time.Millisecond, `✓ kube-proxy running on all 3 nodes — iptables rules synced, Services reachable`, nil)
}

// BootstrapWorkerNodes joins 3 worker Nodes to the cluster.
// Called after kube-proxy is installed so nodes are fully operational.
func BootstrapWorkerNodes(s *ClusterStore, version string, onStep func(i, total int, label string)) {
	const total = 10
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// Remove any existing worker nodes first (idempotent)
	for i := 1; i <= 3; i++ {
		s.Delete(fmt.Sprintf("worker-node-%d", i))
	}

	step(1, 0, "$ kubeadm join api.cluster.local:6443 --token ... --discovery-token-ca-cert-hash ...", nil)
	step(2, 300*time.Millisecond, "[preflight] Running pre-flight checks on worker nodes", nil)

	for i := 1; i <= 3; i++ {
		ii := i
		nodeID := fmt.Sprintf("worker-node-%d", ii)
		workerNode := node(nodeID, models.KindNode, "v1", fmt.Sprintf("worker-%d", ii), "",
			labels("kubernetes.io/role", "worker",
				"kubernetes.io/hostname", fmt.Sprintf("worker-%d", ii)),
			spec(models.NodeSpec{
				Capacity:       "4 CPU, 8Gi",
				Roles:          []string{"worker"},
				OSImage:        "Ubuntu 22.04 LTS",
				KubeletVersion: "v" + version,
			}))
		workerNode.Status = statusJSON(models.NodeStatus{Conditions: []string{"Ready"}})
		step(2+ii, 600*time.Millisecond, fmt.Sprintf("[worker-%d] kubelet registered — node/worker-%d joined and Ready", ii, ii), func() {
			s.Add(workerNode)
			if _, ok := s.Get("cp-apiserver"); ok {
				s.AddEdge(edge("cp-apiserver", workerNode.ID, models.EdgeWatches, "kubelet"))
			}
		})
	}

	step(6, 300*time.Millisecond, "$ kubectl get nodes", nil)
	for i := 1; i <= 3; i++ {
		step(6+i, 100*time.Millisecond, fmt.Sprintf("worker-%d   Ready   <none>   v%s", i, version), nil)
	}
	step(10, 100*time.Millisecond, "✓ 3 worker nodes joined — cluster ready to schedule workloads", nil)
}

// BootstrapHA builds a production-grade High-Availability control plane:
//   - External load balancer (HAProxy) at VIP 10.0.0.10:6443
//   - 3 etcd nodes forming a Raft quorum
//   - 3 kube-apiserver nodes behind the load balancer
//   - kube-scheduler and kube-controller-manager (active/standby via leader election)
//   - 3 worker Nodes
func BootstrapHA(s *ClusterStore, version string, onStep func(i, total int, label string)) {
	const total = 28
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil {
			action()
		}
		onStep(i, total, label)
	}

	// Clean up any existing control plane
	for _, id := range []string{
		"ns-kube-system", "cp-apiserver", "cp-etcd", "cp-scheduler",
		"cp-controller-manager", "ha-lb",
	} {
		s.Delete(id)
	}
	for i := 1; i <= 3; i++ {
		s.Delete(fmt.Sprintf("cp-etcd-%d", i))
		s.Delete(fmt.Sprintf("cp-apiserver-%d", i))
		s.Delete(fmt.Sprintf("worker-node-%d", i))
	}
	s.ActiveVersion = version

	step(1, 0, "$ kubeadm init --control-plane-endpoint=lb.cluster.local:6443 \\", nil)
	step(2, 100*time.Millisecond, "          --upload-certs --pod-network-cidr=10.244.0.0/16", nil)
	step(3, 200*time.Millisecond, "[HA] Targeting 3-node control plane with stacked etcd", nil)

	// Namespace
	nsSystem := node("ns-kube-system", models.KindNamespace, "v1", "kube-system", "", nil, spec(models.ConfigMapSpec{}))
	step(4, 200*time.Millisecond, "namespace/kube-system created", func() {
		s.Add(nsSystem)
	})

	// External Load Balancer
	lbNode := node("ha-lb", models.KindControlPlaneComponent, "v1", "api-lb", "kube-system",
		labels("component", "load-balancer", "tier", "control-plane"),
		spec(models.ServiceSpec{
			Type:      models.ServiceLoadBalancer,
			ClusterIP: "10.0.0.10",
			Ports:     []models.ServicePort{{Port: 6443, Protocol: "TCP"}},
		}))
	lbNode.Annotations = map[string]string{
		"k8svisualizer/role": "HAProxy external load balancer — distributes API traffic across 3 masters",
		"k8svisualizer/vip":  "10.0.0.10:6443",
	}
	step(5, 400*time.Millisecond, "[HA] Provisioning HAProxy load balancer at 10.0.0.10:6443", func() {
		s.Add(lbNode)
	})

	// Canonical cp-apiserver alias → points to LB (keeps existing scenarios working)
	cpAlias := node("cp-apiserver", models.KindControlPlaneComponent, "v1", "kube-apiserver", "kube-system",
		labels("component", "kube-apiserver", "tier", "control-plane"),
		spec(models.PodSpec{}))
	cpAlias.Annotations = map[string]string{
		"k8svisualizer/role": "Virtual API endpoint — all clients connect via LB at 10.0.0.10:6443",
	}
	s.Add(cpAlias)
	s.AddEdge(edge("cp-apiserver", "ha-lb", models.EdgeRoutes, "via LB"))

	// 3 etcd nodes
	for i := 1; i <= 3; i++ {
		ii := i
		etcdID := fmt.Sprintf("cp-etcd-%d", ii)
		prevID := fmt.Sprintf("cp-etcd-%d", ii-1)
		etcd := node(etcdID, models.KindControlPlaneComponent, "v1",
			fmt.Sprintf("etcd-%d", ii), "kube-system",
			labels("component", "etcd", "tier", "control-plane"),
			spec(models.PodSpec{}))
		etcd.Annotations = map[string]string{
			"k8svisualizer/role": fmt.Sprintf("etcd member %d/3 — Raft quorum needs ≥2 healthy (tolerate 1 failure)", ii),
		}
		step(5+ii, 500*time.Millisecond,
			fmt.Sprintf("[etcd-%d] joined Raft cluster (quorum: %d/3 members healthy)", ii, ii), func() {
				s.Add(etcd)
				if ii > 1 {
					s.AddEdge(edge(etcdID, prevID, models.EdgeStores, "raft-peer"))
				}
			})
	}

	// 3 API server nodes
	for i := 1; i <= 3; i++ {
		ii := i
		apiID := fmt.Sprintf("cp-apiserver-%d", ii)
		etcdID := fmt.Sprintf("cp-etcd-%d", ii)
		api := node(apiID, models.KindControlPlaneComponent, "v1",
			fmt.Sprintf("kube-apiserver-%d", ii), "kube-system",
			labels("component", "kube-apiserver", "tier", "control-plane"),
			spec(models.PodSpec{}))
		api.Annotations = map[string]string{
			"k8svisualizer/role": fmt.Sprintf("API server on master-%d — handles reads+writes for this master's partition", ii),
		}
		step(9+ii, 600*time.Millisecond,
			fmt.Sprintf("[master-%d] kube-apiserver started — connected to etcd-%d, registered with LB", ii, ii), func() {
				s.Add(api)
				s.AddEdge(edge(apiID, etcdID, models.EdgeStores, "persist"))
				s.AddEdge(edge("ha-lb", apiID, models.EdgeRoutes, "6443"))
			})
	}

	// Scheduler and controller-manager (leader elected)
	cm := node("cp-controller-manager", models.KindControlPlaneComponent, "v1",
		"kube-controller-manager", "kube-system",
		labels("component", "kube-controller-manager", "tier", "control-plane"),
		spec(models.PodSpec{}))
	cm.Annotations = map[string]string{
		"k8svisualizer/role": "Active leader (master-1) — competing masters use /kube-controller-manager lease for leader election",
	}
	step(13, 400*time.Millisecond, "[master-1] kube-controller-manager elected leader via API server lease", func() {
		s.Add(cm)
		s.AddEdge(edge("cp-controller-manager", "cp-apiserver", models.EdgeWatches, "informer"))
	})

	sched := node("cp-scheduler", models.KindControlPlaneComponent, "v1",
		"kube-scheduler", "kube-system",
		labels("component", "kube-scheduler", "tier", "control-plane"),
		spec(models.PodSpec{}))
	sched.Annotations = map[string]string{
		"k8svisualizer/role": "Active leader (master-1) — standby schedulers on master-2/3 watch /kube-scheduler lease",
	}
	step(14, 300*time.Millisecond, "[master-1] kube-scheduler elected leader — standby on master-2 and master-3", func() {
		s.Add(sched)
		s.AddEdge(edge("cp-scheduler", "cp-apiserver", models.EdgeWatches, "informer"))
	})

	// 3 worker nodes
	for i := 1; i <= 3; i++ {
		ii := i
		workerID := fmt.Sprintf("worker-node-%d", ii)
		worker := node(workerID, models.KindNode, "v1",
			fmt.Sprintf("worker-%d", ii), "",
			labels("kubernetes.io/role", "worker",
				"kubernetes.io/hostname", fmt.Sprintf("worker-%d", ii)),
			spec(models.NodeSpec{
				Capacity:       "4 CPU, 8Gi",
				Roles:          []string{"worker"},
				OSImage:        "Ubuntu 22.04 LTS",
				KubeletVersion: "v" + version,
			}))
		worker.Status = statusJSON(models.NodeStatus{Conditions: []string{"Ready"}})
		step(15+ii, 600*time.Millisecond,
			fmt.Sprintf("[worker-%d] joined via LB endpoint — kubelet registered, node Ready", ii), func() {
				s.Add(worker)
				s.AddEdge(edge("cp-apiserver", workerID, models.EdgeWatches, "kubelet"))
			})
	}

	step(19, 400*time.Millisecond, "✓ HA control plane ready — API, etcd, scheduler, controller-manager all running", nil)
	step(20, 200*time.Millisecond, "$ kubectl get nodes", nil)
	for i := 1; i <= 3; i++ {
		step(20+i, 100*time.Millisecond, fmt.Sprintf("worker-%d   Ready   <none>   v%s", i, version), nil)
	}
	step(24, 0, "HA resilience: 1 etcd failure → cluster survives (2/3 quorum). 2 etcd failures → writes blocked.", nil)
	step(25, 0, "LB failover: if master-1 is unreachable, LB routes to master-2 or master-3 within seconds.", nil)
	step(26, 0, "Leader election: new controller-manager/scheduler leader elected via API server in <30s.", nil)
	step(27, 0, "$ kubectl get pods -n kube-system  (all control plane pods should show Running)", nil)
	step(28, 0, "✓ Production-grade HA cluster bootstrapped!", nil)
}
