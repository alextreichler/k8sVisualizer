package k8sversions

// MaturityLevel indicates how stable a feature is.
type MaturityLevel string

const (
	MaturityAlpha  MaturityLevel = "alpha"
	MaturityBeta   MaturityLevel = "beta"
	MaturityStable MaturityLevel = "stable"
	MaturityRemoved MaturityLevel = "removed"
)

// FeatureInfo describes when a resource kind/apiGroup became available.
type FeatureInfo struct {
	Kind       string        `json:"kind"`
	APIGroup   string        `json:"apiGroup"`
	AlphaIn    string        `json:"alphaIn,omitempty"`
	BetaIn     string        `json:"betaIn,omitempty"`
	StableIn   string        `json:"stableIn,omitempty"`
	RemovedIn  string        `json:"removedIn,omitempty"`
	Notes      string        `json:"notes,omitempty"`
}

// Maturity returns the maturity level of the feature in the given version.
func (f FeatureInfo) Maturity(version string) MaturityLevel {
	if f.RemovedIn != "" && versionGE(version, f.RemovedIn) {
		return MaturityRemoved
	}
	if f.StableIn != "" && versionGE(version, f.StableIn) {
		return MaturityStable
	}
	if f.BetaIn != "" && versionGE(version, f.BetaIn) {
		return MaturityBeta
	}
	if f.AlphaIn != "" && versionGE(version, f.AlphaIn) {
		return MaturityAlpha
	}
	return MaturityRemoved // not yet available
}

// Available returns true if the feature exists in the given version (not removed, has appeared).
func (f FeatureInfo) Available(version string) bool {
	m := f.Maturity(version)
	return m != MaturityRemoved
}

// Features is the master list of K8s resource kind availability.
// Multiple entries for the same Kind with different APIGroups represent migrations.
var Features = []FeatureInfo{
	// Core resources (available since 1.0, always stable)
	{Kind: "Namespace",               APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "Pod",                     APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "Service",                 APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "ConfigMap",               APIGroup: "v1",                          StableIn: "1.2"},
	{Kind: "Secret",                  APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "PersistentVolumeClaim",   APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "PersistentVolume",        APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "ReplicationController",   APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "ServiceAccount",          APIGroup: "v1",                          StableIn: "1.0"},
	{Kind: "Endpoints",               APIGroup: "v1",                          StableIn: "1.0"},

	// apps/v1 workloads
	{Kind: "Deployment",  APIGroup: "apps/v1",           StableIn: "1.9",  Notes: "Moved from extensions/v1beta1"},
	{Kind: "ReplicaSet",  APIGroup: "apps/v1",           StableIn: "1.9",  Notes: "Moved from extensions/v1beta1"},
	{Kind: "StatefulSet", APIGroup: "apps/v1",           StableIn: "1.9",  Notes: "Moved from apps/v1beta1"},
	{Kind: "DaemonSet",   APIGroup: "apps/v1",           StableIn: "1.9",  Notes: "Moved from extensions/v1beta1"},

	// extensions/v1beta1 (removed in 1.16)
	{Kind: "Deployment",  APIGroup: "extensions/v1beta1", AlphaIn: "1.1",  RemovedIn: "1.16", Notes: "Use apps/v1 instead"},
	{Kind: "ReplicaSet",  APIGroup: "extensions/v1beta1", AlphaIn: "1.1",  RemovedIn: "1.16", Notes: "Use apps/v1 instead"},
	{Kind: "DaemonSet",   APIGroup: "extensions/v1beta1", AlphaIn: "1.1",  RemovedIn: "1.16", Notes: "Use apps/v1 instead"},
	{Kind: "StatefulSet", APIGroup: "apps/v1beta1",        AlphaIn: "1.5",  RemovedIn: "1.16", Notes: "Use apps/v1 instead"},
	{Kind: "StatefulSet", APIGroup: "apps/v1beta2",        BetaIn:  "1.8",  RemovedIn: "1.16", Notes: "Use apps/v1 instead"},

	// Ingress
	{Kind: "Ingress", APIGroup: "extensions/v1beta1",      AlphaIn: "1.1",  RemovedIn: "1.22", Notes: "Use networking.k8s.io/v1"},
	{Kind: "Ingress", APIGroup: "networking.k8s.io/v1beta1", BetaIn: "1.14", RemovedIn: "1.22", Notes: "Graduated to networking.k8s.io/v1 in 1.19"},
	{Kind: "Ingress", APIGroup: "networking.k8s.io/v1",     StableIn: "1.19"},

	// HPA
	{Kind: "HorizontalPodAutoscaler", APIGroup: "autoscaling/v1",      StableIn: "1.3"},
	{Kind: "HorizontalPodAutoscaler", APIGroup: "autoscaling/v2beta1",  BetaIn: "1.6",  RemovedIn: "1.26"},
	{Kind: "HorizontalPodAutoscaler", APIGroup: "autoscaling/v2beta2",  BetaIn: "1.12", RemovedIn: "1.26"},
	{Kind: "HorizontalPodAutoscaler", APIGroup: "autoscaling/v2",       StableIn: "1.26"},

	// CronJob
	{Kind: "CronJob", APIGroup: "batch/v1beta1", BetaIn: "1.5",  RemovedIn: "1.25", Notes: "Use batch/v1"},
	{Kind: "CronJob", APIGroup: "batch/v1",      StableIn: "1.21"},
	{Kind: "Job",     APIGroup: "batch/v1",      StableIn: "1.5"},

	// NetworkPolicy
	{Kind: "NetworkPolicy", APIGroup: "networking.k8s.io/v1", StableIn: "1.7"},

	// PodDisruptionBudget
	{Kind: "PodDisruptionBudget", APIGroup: "policy/v1beta1", BetaIn: "1.4",  RemovedIn: "1.25"},
	{Kind: "PodDisruptionBudget", APIGroup: "policy/v1",      StableIn: "1.21"},

	// StorageClass
	{Kind: "StorageClass", APIGroup: "storage.k8s.io/v1", StableIn: "1.6"},

	// VolumeAttachment
	{Kind: "VolumeAttachment", APIGroup: "storage.k8s.io/v1", StableIn: "1.13"},

	// EndpointSlice
	{Kind: "EndpointSlice", APIGroup: "discovery.k8s.io/v1beta1", BetaIn: "1.17"},
	{Kind: "EndpointSlice", APIGroup: "discovery.k8s.io/v1",      StableIn: "1.21"},

	// IngressClass
	{Kind: "IngressClass", APIGroup: "networking.k8s.io/v1beta1", BetaIn: "1.18"},
	{Kind: "IngressClass", APIGroup: "networking.k8s.io/v1",      StableIn: "1.19"},

	// Lease
	{Kind: "Lease", APIGroup: "coordination.k8s.io/v1beta1", BetaIn: "1.12"},
	{Kind: "Lease", APIGroup: "coordination.k8s.io/v1",      StableIn: "1.14"},

	// CSIDriver, CSINode
	{Kind: "CSIDriver", APIGroup: "storage.k8s.io/v1", StableIn: "1.18"},
	{Kind: "CSINode",   APIGroup: "storage.k8s.io/v1", StableIn: "1.17"},

	// Dynamic Resource Allocation (DRA)
	// v1alpha1: 1.26 only — replaced by v1alpha2 in 1.27 (breaking change)
	{Kind: "ResourceClaim",         APIGroup: "resource.k8s.io/v1alpha1", AlphaIn: "1.26", RemovedIn: "1.27", Notes: "Initial DRA alpha; replaced by v1alpha2 in 1.27"},
	{Kind: "ResourceClaimTemplate", APIGroup: "resource.k8s.io/v1alpha1", AlphaIn: "1.26", RemovedIn: "1.27", Notes: "Initial DRA alpha; replaced by v1alpha2 in 1.27"},
	// v1alpha2: 1.27–1.31, removed in 1.32 when v1beta1 stabilised
	{Kind: "ResourceClaim",         APIGroup: "resource.k8s.io/v1alpha2", AlphaIn: "1.27", RemovedIn: "1.32", Notes: "Graduated to resource.k8s.io/v1beta1 in 1.31"},
	{Kind: "ResourceClaimTemplate", APIGroup: "resource.k8s.io/v1alpha2", AlphaIn: "1.27", RemovedIn: "1.32", Notes: "Graduated to resource.k8s.io/v1beta1 in 1.31"},
	// v1beta1: beta in 1.31
	{Kind: "ResourceClaim",         APIGroup: "resource.k8s.io/v1beta1",  BetaIn: "1.31", Notes: "Dynamic Resource Allocation — request hardware/accelerators"},
	{Kind: "ResourceClaimTemplate", APIGroup: "resource.k8s.io/v1beta1",  BetaIn: "1.31", Notes: "Template for per-pod ResourceClaims"},

	// VolumeAttributesClass — 1.29+
	// v1alpha1 is deprecated (not removed) when v1beta1 lands in 1.32; removal expected in a later release
	{Kind: "VolumeAttributesClass", APIGroup: "storage.k8s.io/v1alpha1", AlphaIn: "1.29", Notes: "Deprecated in 1.32; migrate to storage.k8s.io/v1beta1"},
	{Kind: "VolumeAttributesClass", APIGroup: "storage.k8s.io/v1beta1",  BetaIn: "1.32", Notes: "Modify volume QoS/performance attributes without re-provisioning"},
}

// AvailableKinds returns all FeatureInfo entries available in the given version.
func AvailableKinds(version string) []FeatureInfo {
	out := make([]FeatureInfo, 0)
	for _, f := range Features {
		if f.Available(version) {
			out = append(out, f)
		}
	}
	return out
}

// IsDeprecated returns true if the kind+apiGroup is deprecated (removed) in the given version.
func IsDeprecated(kind, apiGroup, version string) bool {
	for _, f := range Features {
		if f.Kind == kind && f.APIGroup == apiGroup {
			return f.Maturity(version) == MaturityRemoved && f.RemovedIn != ""
		}
	}
	return false
}

// GetFeature returns the FeatureInfo for a kind+apiGroup, or nil if not found.
func GetFeature(kind, apiGroup string) *FeatureInfo {
	for i := range Features {
		if Features[i].Kind == kind && Features[i].APIGroup == apiGroup {
			return &Features[i]
		}
	}
	return nil
}
