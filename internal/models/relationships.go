package models

// EdgeType describes the semantic relationship between two K8s resources.
type EdgeType string

const (
	// EdgeOwns: parent resource owns/creates child (Deployment→RS, RS→Pod, SS→Pod, DS→Pod)
	EdgeOwns EdgeType = "owns"
	// EdgeSelects: Service selects Pods via label selector
	EdgeSelects EdgeType = "selects"
	// EdgeMounts: Pod mounts a ConfigMap, Secret, or PVC
	EdgeMounts EdgeType = "mounts"
	// EdgeBound: PVC is bound to a PV
	EdgeBound EdgeType = "bound"
	// EdgeRoutes: Ingress routes traffic to a Service
	EdgeRoutes EdgeType = "routes"
	// EdgeScales: HPA scales a Deployment
	EdgeScales EdgeType = "scales"
	// EdgeHeadless: StatefulSet uses a headless Service for DNS
	EdgeHeadless EdgeType = "headless"
	// EdgeWatches: Component watches the API server via Informer/ListWatch (scheduler, controller-manager, addons)
	EdgeWatches EdgeType = "watches"
	// EdgeStores: kube-apiserver persists all cluster state to etcd
	EdgeStores EdgeType = "stores"
	// EdgeUses: Pod uses a ServiceAccount
	EdgeUses EdgeType = "uses"
	// EdgeBinds: RoleBinding grants a Role/ClusterRole
	EdgeBinds EdgeType = "binds"
	// EdgeSubject: RoleBinding has a ServiceAccount as subject
	EdgeSubject EdgeType = "subject"
	// EdgeScheduledOn: Pod is scheduled onto a Node
	EdgeScheduledOn EdgeType = "scheduled-on"
)

// Edge represents a directed relationship between two Nodes.
type Edge struct {
	ID     string   `json:"id"`
	Source string   `json:"source"` // Node ID
	Target string   `json:"target"` // Node ID
	Type   EdgeType `json:"type"`
	Label  string   `json:"label,omitempty"`
}

// GraphSnapshot is the full or filtered graph state sent to the frontend.
type GraphSnapshot struct {
	Nodes     []*Node `json:"nodes"`
	Edges     []*Edge `json:"edges"`
	Timestamp int64   `json:"timestamp"` // unix milliseconds
	Version   string  `json:"version"`   // active K8s version
}
