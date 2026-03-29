package store

import (
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// RunRBACScenario walks through creating RBAC resources for the coredns and
// kube-proxy components, showing the ServiceAccount → RoleBinding → ClusterRole chain.
func RunRBACScenario(s *ClusterStore, apiServerID string, onStep func(i, total int, label string)) {
	const total = 22
	step := func(i int, delay time.Duration, label string, action func()) {
		time.Sleep(delay)
		if action != nil { action() }
		onStep(i, total, label)
	}

	// Clean up any existing RBAC resources
	for _, id := range []string{
		"sa-coredns", "sa-kube-proxy",
		"cr-coredns", "cr-kube-proxy",
		"crb-coredns", "crb-kube-proxy",
	} {
		s.Delete(id)
	}
	time.Sleep(100 * time.Millisecond)

	step(1, 0, "$ # RBAC: Role-Based Access Control in Kubernetes", nil)
	step(2, 300*time.Millisecond, "$ # Every component gets a ServiceAccount — a namespaced identity", nil)
	step(3, 300*time.Millisecond, "$ # ClusterRoles define WHAT can be done (verbs on resources)", nil)
	step(4, 300*time.Millisecond, "$ # ClusterRoleBindings bind WHO (SA) to WHAT (ClusterRole)", nil)

	// --- coredns RBAC chain ---
	step(5, 400*time.Millisecond, "$ kubectl create serviceaccount coredns -n kube-system", nil)
	saCoreDNS := node("sa-coredns", models.KindServiceAccount, "v1", "coredns", "kube-system",
		labels("k8s-app", "kube-dns"),
		spec(models.ServiceAccountSpec{AutomountToken: true}))
	step(6, 500*time.Millisecond, "+ serviceaccount/coredns created", func() {
		s.Add(saCoreDNS)
	})

	step(7, 400*time.Millisecond, "$ kubectl apply -f coredns-clusterrole.yaml", nil)
	crCoreDNS := node("cr-coredns", models.KindClusterRole, "rbac.authorization.k8s.io/v1", "system:coredns", "",
		nil,
		spec(models.RoleSpec{Rules: []models.PolicyRule{
			{APIGroups: []string{""}, Resources: []string{"endpoints", "services", "pods", "namespaces"}, Verbs: []string{"list", "watch"}},
			{APIGroups: []string{""}, Resources: []string{"nodes"}, Verbs: []string{"get"}},
		}}))
	step(8, 500*time.Millisecond, "+ clusterrole.rbac.authorization.k8s.io/system:coredns created  (list/watch endpoints, services, pods, namespaces)", func() {
		s.Add(crCoreDNS)
	})

	step(9, 400*time.Millisecond, "$ kubectl apply -f coredns-clusterrolebinding.yaml", nil)
	crbCoreDNS := node("crb-coredns", models.KindClusterRoleBinding, "rbac.authorization.k8s.io/v1", "system:coredns", "",
		nil,
		spec(models.RoleBindingSpec{RoleRefID: crCoreDNS.ID, SubjectIDs: []string{saCoreDNS.ID}}))
	step(10, 500*time.Millisecond, "+ clusterrolebinding.rbac.authorization.k8s.io/system:coredns created  (SA coredns → ClusterRole system:coredns)", func() {
		s.Add(crbCoreDNS)
		s.AddEdge(edge(crbCoreDNS.ID, crCoreDNS.ID, models.EdgeBinds, "grants"))
		s.AddEdge(edge(crbCoreDNS.ID, saCoreDNS.ID, models.EdgeSubject, "subject"))
	})

	step(11, 300*time.Millisecond, "  ↳ Now coredns pods can list endpoints/services via the API server", nil)
	// Show coredns pods using the SA
	s.AddEdge(edge("pod-coredns-1", saCoreDNS.ID, models.EdgeUses, ""))
	s.AddEdge(edge("pod-coredns-2", saCoreDNS.ID, models.EdgeUses, ""))
	step(12, 200*time.Millisecond, "  ↳ pods/coredns → serviceaccount/coredns (token auto-mounted at /var/run/secrets)", nil)

	// --- kube-proxy RBAC chain ---
	step(13, 400*time.Millisecond, "$ kubectl create serviceaccount kube-proxy -n kube-system", nil)
	saKubeProxy := node("sa-kube-proxy", models.KindServiceAccount, "v1", "kube-proxy", "kube-system",
		labels("k8s-app", "kube-proxy"),
		spec(models.ServiceAccountSpec{AutomountToken: true}))
	step(14, 500*time.Millisecond, "+ serviceaccount/kube-proxy created", func() {
		s.Add(saKubeProxy)
	})

	step(15, 400*time.Millisecond, "$ kubectl apply -f kube-proxy-clusterrole.yaml", nil)
	crKubeProxy := node("cr-kube-proxy", models.KindClusterRole, "rbac.authorization.k8s.io/v1", "system:node-proxier", "",
		nil,
		spec(models.RoleSpec{Rules: []models.PolicyRule{
			{APIGroups: []string{""}, Resources: []string{"endpoints", "services", "nodes"}, Verbs: []string{"list", "watch", "get"}},
		}}))
	step(16, 500*time.Millisecond, "+ clusterrole.rbac.authorization.k8s.io/system:node-proxier created  (list/watch/get endpoints, services, nodes)", func() {
		s.Add(crKubeProxy)
	})

	step(17, 400*time.Millisecond, "$ kubectl apply -f kube-proxy-clusterrolebinding.yaml", nil)
	crbKubeProxy := node("crb-kube-proxy", models.KindClusterRoleBinding, "rbac.authorization.k8s.io/v1", "system:node-proxier", "",
		nil,
		spec(models.RoleBindingSpec{RoleRefID: crKubeProxy.ID, SubjectIDs: []string{saKubeProxy.ID}}))
	step(18, 500*time.Millisecond, "+ clusterrolebinding.rbac.authorization.k8s.io/system:node-proxier created", func() {
		s.Add(crbKubeProxy)
		s.AddEdge(edge(crbKubeProxy.ID, crKubeProxy.ID, models.EdgeBinds, "grants"))
		s.AddEdge(edge(crbKubeProxy.ID, saKubeProxy.ID, models.EdgeSubject, "subject"))
	})

	step(19, 200*time.Millisecond, "  ↳ kube-proxy pods → SA → ClusterRole (can now read node/endpoints from apiserver)", nil)
	s.AddEdge(edge("pod-kubeproxy-1", saKubeProxy.ID, models.EdgeUses, ""))

	step(20, 400*time.Millisecond, "  ↳ RBAC chain: Pod --uses--> SA --subject--> CRB --binds--> ClusterRole", nil)
	step(21, 400*time.Millisecond, "  ↳ The API server enforces this on every request the pod makes", nil)
	step(22, 300*time.Millisecond, "✓ RBAC setup complete — principle of least privilege enforced", nil)
}
