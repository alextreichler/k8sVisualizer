package models

import (
	"encoding/json"
	"time"
)

// Kind constants — matching real Kubernetes resource kinds
const (
	KindNamespace   = "Namespace"
	KindDeployment  = "Deployment"
	KindReplicaSet  = "ReplicaSet"
	KindPod         = "Pod"
	KindService     = "Service"
	KindIngress     = "Ingress"
	KindConfigMap   = "ConfigMap"
	KindSecret      = "Secret"
	KindPVC         = "PersistentVolumeClaim"
	KindPV          = "PersistentVolume"
	KindStorageClass = "StorageClass"
	KindStatefulSet = "StatefulSet"
	KindDaemonSet   = "DaemonSet"
	KindHPA         = "HorizontalPodAutoscaler"
	KindCronJob     = "CronJob"
	KindJob         = "Job"
	KindControlPlaneComponent = "ControlPlaneComponent"
	// KindCustomResource represents an instance of a Custom Resource Definition (CRD).
	// Used to show operator-managed resources such as Redpanda, Kafka, etc.
	KindCustomResource = "CustomResource"

	// cert-manager CRD kinds
	KindCertificate   = "Certificate"
	KindIssuer        = "Issuer"
	KindClusterIssuer = "ClusterIssuer"

	// ArgoCD CRD kind
	KindApplication = "Application"

	// Redpanda operator CRD kinds
	KindRedpandaTopic  = "RedpandaTopic"
	KindRedpandaUser   = "RedpandaUser"
	KindRedpandaSchema = "RedpandaSchema"
	KindHelmRelease    = "HelmRelease"
	KindHelmRepository = "HelmRepository"

	KindNode               = "Node"
	KindServiceAccount     = "ServiceAccount"
	KindRole               = "Role"
	KindClusterRole        = "ClusterRole"
	KindRoleBinding        = "RoleBinding"
	KindClusterRoleBinding = "ClusterRoleBinding"
	KindNetworkPolicy = "NetworkPolicy"
	KindResourceQuota = "ResourceQuota"

	KindLimitRange    = "LimitRange"
	KindPriorityClass = "PriorityClass"
	KindEndpointSlice = "EndpointSlice"

	// Pseudo-nodes: not real K8s resources, added by the simulator to show external access paths.
	KindExternalClient    = "ExternalClient"    // represents the internet / external client
	KindIngressController = "IngressController" // represents the nginx/Traefik ingress controller pod

	// Istio service mesh CRD kinds
	KindVirtualService  = "VirtualService"
	KindDestinationRule = "DestinationRule"
)

// PodPhase mirrors corev1.PodPhase
type PodPhase string

const (
	PodInitializing PodPhase = "Initializing" // init containers running — simulation only
	PodPending      PodPhase = "Pending"
	PodRunning      PodPhase = "Running"
	PodSucceeded    PodPhase = "Succeeded"
	PodFailed       PodPhase = "Failed"
	PodTerminating  PodPhase = "Terminating" // not a real k8s phase, used for simulation
)

// PVCPhase mirrors corev1.PersistentVolumeClaimPhase
type PVCPhase string

const (
	PVCPending PVCPhase = "Pending"
	PVCBound   PVCPhase = "Bound"
	PVCLost    PVCPhase = "Lost"
)

// PVPhase mirrors corev1.PersistentVolumePhase
type PVPhase string

const (
	PVAvailable PVPhase = "Available"
	PVBound     PVPhase = "Bound"
	PVReleased  PVPhase = "Released"
	PVFailed    PVPhase = "Failed"
)

// ServiceType mirrors corev1.ServiceType
type ServiceType string

const (
	ServiceClusterIP    ServiceType = "ClusterIP"
	ServiceNodePort     ServiceType = "NodePort"
	ServiceLoadBalancer ServiceType = "LoadBalancer"
	ServiceExternalName ServiceType = "ExternalName"
)

// ObjectMeta mirrors k8s.io/apimachinery ObjectMeta (subset used here)
type ObjectMeta struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
	UID         string            `json:"uid,omitempty"`
	CreatedAt   time.Time         `json:"creationTimestamp,omitempty"`
}

// TypeMeta mirrors k8s.io/apimachinery TypeMeta
type TypeMeta struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
}

// Node is the graph-level representation of any K8s resource.
// Spec and Status are stored as raw JSON so we can hold any k8s type.
type Node struct {
	// Internal graph ID (stable UUID assigned by store, not the k8s UID)
	ID string `json:"id"`

	TypeMeta   `json:",inline"`
	ObjectMeta `json:"metadata"`

	Spec   json.RawMessage `json:"spec,omitempty"`
	Status json.RawMessage `json:"status,omitempty"`

	// Simulation-only fields (not present in real K8s objects)
	SimPhase  string `json:"simPhase,omitempty"`  // for Pods: Pending/Running/Terminating
	TickCount int    `json:"-"`                   // internal: ticks spent in current sim phase
}

// -- Kind-specific spec structs (mirror real K8s field names) --

type DeploymentSpec struct {
	Replicas int               `json:"replicas"`
	Selector map[string]string `json:"selector"` // simplified: matchLabels only
	Template PodTemplateSpec   `json:"template"`
}

type DeploymentStatus struct {
	Replicas          int `json:"replicas"`
	ReadyReplicas     int `json:"readyReplicas"`
	AvailableReplicas int `json:"availableReplicas"`
	UpdatedReplicas   int `json:"updatedReplicas"`
}

type PodTemplateSpec struct {
	Labels         map[string]string `json:"labels,omitempty"`
	ConfigMapRefs  []string          `json:"configMapRefs,omitempty"`  // IDs
	SecretRefs     []string          `json:"secretRefs,omitempty"`    // IDs
	PVCRefs        []string          `json:"pvcRefs,omitempty"`       // IDs
	InitContainers []ContainerInfo   `json:"initContainers,omitempty"` // run before main containers
	Containers     []ContainerInfo   `json:"containers,omitempty"`
}

type ReplicaSetSpec struct {
	Replicas int               `json:"replicas"`
	Selector map[string]string `json:"selector"`
	OwnerRef string            `json:"ownerRef"` // Deployment Node ID
}

type ReplicaSetStatus struct {
	Replicas      int `json:"replicas"`
	ReadyReplicas int `json:"readyReplicas"`
}

// ContainerInfo describes one container in a Pod: init, main, or sidecar.
type ContainerInfo struct {
	Name  string `json:"name"`
	Image string `json:"image,omitempty"`
	// Role is "init", "main", or "sidecar"
	Role  string `json:"role"`
	Ports []int  `json:"ports,omitempty"`
}

type PodSpec struct {
	Phase          PodPhase          `json:"phase"`
	NodeName       string            `json:"nodeName,omitempty"`
	OwnerRef       string            `json:"ownerRef,omitempty"` // RS or StatefulSet Node ID
	Labels         map[string]string `json:"labels,omitempty"`
	ConfigMapRefs  []string          `json:"configMapRefs,omitempty"`
	SecretRefs     []string          `json:"secretRefs,omitempty"`
	PVCRefs        []string          `json:"pvcRefs,omitempty"`
	InitContainers []ContainerInfo   `json:"initContainers,omitempty"`
	Containers     []ContainerInfo   `json:"containers,omitempty"`
}

type ServicePort struct {
	Name       string `json:"name,omitempty"`
	Protocol   string `json:"protocol"`
	Port       int    `json:"port"`
	TargetPort int    `json:"targetPort"`
	NodePort   int    `json:"nodePort,omitempty"`
}

type ServiceSpec struct {
	Type      ServiceType       `json:"type"`
	Selector  map[string]string `json:"selector,omitempty"`
	ClusterIP string            `json:"clusterIP,omitempty"`
	Ports     []ServicePort     `json:"ports"`
}

type IngressRule struct {
	Host      string `json:"host"`
	Path      string `json:"path"`
	PathType  string `json:"pathType"`
	ServiceID string `json:"serviceID"` // Node ID of target Service
	Port      int    `json:"port"`
}

type IngressSpec struct {
	IngressClassName string        `json:"ingressClassName,omitempty"`
	Rules            []IngressRule `json:"rules"`
	TLS              []string      `json:"tls,omitempty"` // host names
}

type ConfigMapSpec struct {
	Data       map[string]string `json:"data,omitempty"`
	BinaryData map[string]string `json:"binaryData,omitempty"`
}

type SecretSpec struct {
	Type string            `json:"type"`
	Data map[string]string `json:"data,omitempty"` // values shown as [redacted] in UI
}

type PVCSpec struct {
	StorageClassName string   `json:"storageClassName,omitempty"`
	AccessModes      []string `json:"accessModes"`
	Requests         string   `json:"requests"` // e.g. "5Gi"
}

type PVCStatus struct {
	Phase    PVCPhase `json:"phase"`
	BoundPVI string   `json:"boundPVID,omitempty"`
}

type PVSpec struct {
	StorageClassName string   `json:"storageClassName,omitempty"`
	AccessModes      []string `json:"accessModes"`
	Capacity         string   `json:"capacity"`
	ReclaimPolicy    string   `json:"reclaimPolicy"`
}

type PVStatus struct {
	Phase      PVPhase `json:"phase"`
	BoundPVCID string  `json:"boundPVCID,omitempty"`
}

// PVCTemplateSpec is used by StatefulSets to auto-create one PVC per pod ordinal.
// Mirrors the subset of k8s volumeClaimTemplates used in simulation.
type PVCTemplateSpec struct {
	Name             string   `json:"name"`
	StorageClassName string   `json:"storageClassName,omitempty"`
	AccessModes      []string `json:"accessModes"`
	Requests         string   `json:"requests"` // e.g. "5Gi"
}

type StatefulSetSpec struct {
	Replicas             int               `json:"replicas"`
	Selector             map[string]string `json:"selector"`
	ServiceName          string            `json:"serviceName"`
	VolumeClaimTemplates []string          `json:"volumeClaimTemplates,omitempty"` // PVC IDs (legacy)
	PVCTemplates         []PVCTemplateSpec `json:"pvcTemplates,omitempty"`         // auto-provisioned per ordinal
}

type StatefulSetStatus struct {
	Replicas      int `json:"replicas"`
	ReadyReplicas int `json:"readyReplicas"`
}

type DaemonSetSpec struct {
	Selector     map[string]string `json:"selector"`
	NodeSelector map[string]string `json:"nodeSelector,omitempty"`
}

type DaemonSetStatus struct {
	NumberReady          int `json:"numberReady"`
	DesiredNumberScheduled int `json:"desiredNumberScheduled"`
}

type HPASpec struct {
	ScaleTargetRef   string `json:"scaleTargetRef"` // Deployment Node ID
	MinReplicas      int    `json:"minReplicas"`
	MaxReplicas      int    `json:"maxReplicas"`
	TargetCPUPercent int    `json:"targetCPUUtilizationPercentage"`
}

type HPAStatus struct {
	CurrentReplicas       int `json:"currentReplicas"`
	CurrentCPUUtilization int `json:"currentCPUUtilizationPercentage"`
}

type NodeSpec struct {
	Capacity       string   `json:"capacity"`               // e.g. "4 CPU, 16Gi"
	Roles          []string `json:"roles"`                  // e.g. ["worker"]
	OSImage        string   `json:"osImage"`                // e.g. "Ubuntu 22.04"
	KubeletVersion string   `json:"kubeletVersion,omitempty"`
}

type NodeStatus struct {
	Conditions []string `json:"conditions"` // e.g. ["Ready"]
}

type ServiceAccountSpec struct {
	AutomountToken bool `json:"automountServiceAccountToken"`
}

type RoleSpec struct {
	Rules []PolicyRule `json:"rules"`
}

type PolicyRule struct {
	APIGroups []string `json:"apiGroups"`
	Resources []string `json:"resources"`
	Verbs     []string `json:"verbs"`
}

type RoleBindingSpec struct {
	RoleRefID  string   `json:"roleRefID"`  // Node ID of Role or ClusterRole
	SubjectIDs []string `json:"subjectIDs"` // Node IDs of ServiceAccounts
}

// NetworkPolicy restricts pod-to-pod communication within a namespace.
type NetworkPolicySpec struct {
	PodSelector map[string]string   `json:"podSelector"`
	PolicyTypes []string            `json:"policyTypes"`
	Ingress     []NetworkPolicyRule `json:"ingress,omitempty"`
	Egress      []NetworkPolicyRule `json:"egress,omitempty"`
}

type NetworkPolicyRule struct {
	From  []NetworkPolicyPeer `json:"from,omitempty"`
	To    []NetworkPolicyPeer `json:"to,omitempty"`
	Ports []NetworkPolicyPort `json:"ports,omitempty"`
}

type NetworkPolicyPeer struct {
	NamespaceSelector map[string]string `json:"namespaceSelector,omitempty"`
	PodSelector       map[string]string `json:"podSelector,omitempty"`
}

type NetworkPolicyPort struct {
	Protocol string `json:"protocol,omitempty"`
	Port     int    `json:"port,omitempty"`
}

// ResourceQuota caps total resource consumption per namespace.
type ResourceQuotaSpec struct {
	Hard map[string]string `json:"hard"` // e.g. {"pods": "10", "cpu": "4", "memory": "8Gi"}
}

type ResourceQuotaStatus struct {
	Hard map[string]string `json:"hard"`
	Used map[string]string `json:"used"`
}

type RedpandaClusterSpec struct {
	Replicas int    `json:"replicas"`
	Version  string `json:"version,omitempty"`
}

type LimitRangeSpec struct {
	Limits []LimitRangeItem `json:"limits,omitempty"`
}
type LimitRangeItem struct {
	Type           string            `json:"type"` // "Container", "Pod", "PersistentVolumeClaim"
	Default        map[string]string `json:"default,omitempty"`
	DefaultRequest map[string]string `json:"defaultRequest,omitempty"`
	Max            map[string]string `json:"max,omitempty"`
	Min            map[string]string `json:"min,omitempty"`
}

type PriorityClassSpec struct {
	Value         int    `json:"value"`
	GlobalDefault bool   `json:"globalDefault,omitempty"`
	Description   string `json:"description,omitempty"`
}

type EndpointSliceSpec struct {
	AddressType string          `json:"addressType"` // "IPv4"
	Endpoints   []SliceEndpoint `json:"endpoints,omitempty"`
	Ports       []SlicePort     `json:"ports,omitempty"`
}
type SliceEndpoint struct {
	Addresses  []string        `json:"addresses"`
	Conditions map[string]bool `json:"conditions,omitempty"` // ready, serving, terminating
	TargetRef  string          `json:"targetRef,omitempty"`  // pod ID
}
type SlicePort struct {
	Name     string `json:"name,omitempty"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

// ── Istio service mesh spec structs ──────────────────────────────────────────

// VirtualServiceSpec mirrors the Istio networking.istio.io/v1 VirtualService.
type VirtualServiceSpec struct {
	Hosts    []string    `json:"hosts"`
	Gateways []string    `json:"gateways,omitempty"`
	Http     []HTTPRoute `json:"http,omitempty"`
}

type HTTPRoute struct {
	Name  string               `json:"name,omitempty"`
	Match []HTTPMatchRequest   `json:"match,omitempty"`
	Route []HTTPRouteDestDest  `json:"route"`
}

type HTTPMatchRequest struct {
	Uri map[string]string `json:"uri,omitempty"`
}

type HTTPRouteDestDest struct {
	Destination IstioDestination `json:"destination"`
	Weight      int              `json:"weight,omitempty"`
}

type IstioDestination struct {
	Host   string `json:"host"`
	Subset string `json:"subset,omitempty"`
	Port   int    `json:"port,omitempty"`
}

// DestinationRuleSpec mirrors the Istio networking.istio.io/v1 DestinationRule.
type DestinationRuleSpec struct {
	Host          string          `json:"host"`
	TrafficPolicy *IstioTraffic   `json:"trafficPolicy,omitempty"`
	Subsets       []IstioSubset   `json:"subsets,omitempty"`
}

type IstioTraffic struct {
	ConnectionPool *IstioConnPool `json:"connectionPool,omitempty"`
	OutlierDetect  *IstioOutlier  `json:"outlierDetection,omitempty"`
}

type IstioConnPool struct {
	Http1MaxPendingRequests int `json:"http1MaxPendingRequests,omitempty"`
	Http2MaxRequests        int `json:"http2MaxRequests,omitempty"`
}

type IstioOutlier struct {
	Consecutive5xxErrors int    `json:"consecutive5xxErrors,omitempty"`
	Interval             string `json:"interval,omitempty"`
	BaseEjectionTime     string `json:"baseEjectionTime,omitempty"`
}

type IstioSubset struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
}
