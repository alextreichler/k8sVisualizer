package k8sversions

// APIMigration describes when a resource kind moved from one apiGroup/version to another.
type APIMigration struct {
	Kind      string `json:"kind"`
	From      string `json:"from"`     // old apiVersion (e.g. "extensions/v1beta1")
	To        string `json:"to"`       // new apiVersion (e.g. "apps/v1")
	Since     string `json:"since"`    // version where "To" became the preferred/stable version
	Removed   string `json:"removed"`  // version where "From" was removed entirely
	Notes     string `json:"notes,omitempty"`
}

// Migrations is the full list of K8s API group migrations.
var Migrations = []APIMigration{
	{
		Kind:    "Deployment",
		From:    "extensions/v1beta1",
		To:      "apps/v1",
		Since:   "1.9",
		Removed: "1.16",
		Notes:   "apps/v1 Deployment requires spec.selector to be set and is immutable.",
	},
	{
		Kind:    "ReplicaSet",
		From:    "extensions/v1beta1",
		To:      "apps/v1",
		Since:   "1.9",
		Removed: "1.16",
	},
	{
		Kind:    "DaemonSet",
		From:    "extensions/v1beta1",
		To:      "apps/v1",
		Since:   "1.9",
		Removed: "1.16",
	},
	{
		Kind:    "StatefulSet",
		From:    "apps/v1beta1",
		To:      "apps/v1",
		Since:   "1.9",
		Removed: "1.16",
	},
	{
		Kind:    "StatefulSet",
		From:    "apps/v1beta2",
		To:      "apps/v1",
		Since:   "1.9",
		Removed: "1.16",
	},
	{
		Kind:    "Ingress",
		From:    "extensions/v1beta1",
		To:      "networking.k8s.io/v1",
		Since:   "1.19",
		Removed: "1.22",
		Notes:   "networking.k8s.io/v1 Ingress requires spec.rules[*].http.paths[*].pathType.",
	},
	{
		Kind:    "Ingress",
		From:    "networking.k8s.io/v1beta1",
		To:      "networking.k8s.io/v1",
		Since:   "1.19",
		Removed: "1.22",
	},
	{
		Kind:    "HorizontalPodAutoscaler",
		From:    "autoscaling/v2beta1",
		To:      "autoscaling/v2",
		Since:   "1.26",
		Removed: "1.26",
	},
	{
		Kind:    "HorizontalPodAutoscaler",
		From:    "autoscaling/v2beta2",
		To:      "autoscaling/v2",
		Since:   "1.26",
		Removed: "1.26",
	},
	{
		Kind:    "CronJob",
		From:    "batch/v1beta1",
		To:      "batch/v1",
		Since:   "1.21",
		Removed: "1.25",
	},
	{
		Kind:    "PodDisruptionBudget",
		From:    "policy/v1beta1",
		To:      "policy/v1",
		Since:   "1.21",
		Removed: "1.25",
	},
	{
		Kind:    "EndpointSlice",
		From:    "discovery.k8s.io/v1beta1",
		To:      "discovery.k8s.io/v1",
		Since:   "1.21",
		Removed: "1.25",
	},
	{
		Kind:    "IngressClass",
		From:    "networking.k8s.io/v1beta1",
		To:      "networking.k8s.io/v1",
		Since:   "1.19",
		Removed: "1.22",
	},
}

// MigrationsForVersion returns all migrations where the old API was removed in this version or earlier.
func MigrationsForVersion(version string) []APIMigration {
	out := make([]APIMigration, 0)
	for _, m := range Migrations {
		if m.Removed != "" && versionGE(version, m.Removed) {
			out = append(out, m)
		}
	}
	return out
}

// ActiveMigrationsForVersion returns migrations where the old API is deprecated (removed in a future version)
// but the new API is already available.
func ActiveMigrationsForVersion(version string) []APIMigration {
	out := make([]APIMigration, 0)
	for _, m := range Migrations {
		// Old API exists (not yet removed) but new API is available
		isOldAvailable := m.Removed == "" || versionLess(version, m.Removed)
		isNewAvailable := versionGE(version, m.Since)
		if isOldAvailable && isNewAvailable {
			out = append(out, m)
		}
	}
	return out
}

// PreferredAPIVersion returns the recommended apiVersion for a kind in the given cluster version.
func PreferredAPIVersion(kind, clusterVersion string) string {
	// Find the latest migration target that is available in this version
	for _, m := range Migrations {
		if m.Kind == kind && versionGE(clusterVersion, m.Since) {
			return m.To
		}
	}
	return ""
}
