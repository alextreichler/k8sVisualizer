package k8sversions

// FieldNote describes a field-level deprecation or notable change in a specific K8s version.
type FieldNote struct {
	Kind       string `json:"kind"`
	APIGroup   string `json:"apiGroup"`
	FieldPath  string `json:"fieldPath"`            // e.g. "spec.template.spec.serviceAccount"
	DeprecatedIn string `json:"deprecatedIn,omitempty"`
	RemovedIn   string `json:"removedIn,omitempty"`
	UseInstead  string `json:"useInstead,omitempty"` // replacement field path
	Notes       string `json:"notes,omitempty"`
}

// FieldNotes is the list of known field-level changes across K8s versions.
var FieldNotes = []FieldNote{
	{
		Kind:        "Pod",
		APIGroup:    "v1",
		FieldPath:   "spec.serviceAccount",
		DeprecatedIn: "1.0",
		UseInstead:  "spec.serviceAccountName",
		Notes:       "spec.serviceAccount is a deprecated alias for spec.serviceAccountName.",
	},
	{
		Kind:        "Deployment",
		APIGroup:    "apps/v1",
		FieldPath:   "spec.progressDeadlineSeconds",
		DeprecatedIn: "",
		Notes:       "Default changed to 600s in apps/v1 (was unlimited in extensions/v1beta1).",
	},
	{
		Kind:         "Ingress",
		APIGroup:     "networking.k8s.io/v1",
		FieldPath:    "spec.rules[*].http.paths[*].pathType",
		DeprecatedIn: "",
		Notes:        "pathType is required in networking.k8s.io/v1 (was optional in v1beta1). Valid values: Exact, Prefix, ImplementationSpecific.",
	},
	{
		Kind:         "Ingress",
		APIGroup:     "networking.k8s.io/v1",
		FieldPath:    "spec.backend",
		DeprecatedIn: "1.19",
		UseInstead:   "spec.defaultBackend",
		Notes:        "spec.backend was renamed to spec.defaultBackend in networking.k8s.io/v1.",
	},
	{
		Kind:         "HorizontalPodAutoscaler",
		APIGroup:     "autoscaling/v2",
		FieldPath:    "spec.metrics",
		DeprecatedIn: "",
		Notes:        "autoscaling/v2 supports multiple metric types: Resource, Pods, Object, External, ContainerResource.",
	},
	{
		Kind:         "PodSecurityPolicy",
		APIGroup:     "policy/v1beta1",
		FieldPath:    "",
		DeprecatedIn: "1.21",
		RemovedIn:    "1.25",
		Notes:        "PodSecurityPolicy was removed in 1.25. Use Pod Security Admission (pod-security.kubernetes.io labels on namespaces) instead.",
	},
	{
		Kind:        "Deployment",
		APIGroup:    "apps/v1",
		FieldPath:   "spec.selector",
		Notes:       "spec.selector is immutable in apps/v1. It must be set on creation and cannot be changed.",
	},
	{
		Kind:        "StatefulSet",
		APIGroup:    "apps/v1",
		FieldPath:   "spec.volumeClaimTemplates",
		Notes:       "spec.volumeClaimTemplates are immutable after StatefulSet creation.",
	},
	{
		Kind:         "Node",
		APIGroup:     "v1",
		FieldPath:    "spec.externalID",
		DeprecatedIn: "1.8",
		RemovedIn:    "1.11",
		Notes:        "externalID was removed from Node spec.",
	},
	{
		Kind:         "Service",
		APIGroup:     "v1",
		FieldPath:    "spec.topologyKeys",
		DeprecatedIn: "1.21",
		RemovedIn:    "1.24",
		UseInstead:   "spec.trafficDistribution (1.30+)",
		Notes:        "Service topology keys were replaced by topology-aware routing.",
	},
	{
		Kind:      "Pod",
		APIGroup:  "v1",
		FieldPath: "spec.hostAliases",
		Notes:     "Added in 1.7. Allows adding entries to a Pod's /etc/hosts.",
	},
	{
		Kind:         "CronJob",
		APIGroup:     "batch/v1",
		FieldPath:    "spec.startingDeadlineSeconds",
		Notes:        "If startingDeadlineSeconds < 10, CronJob may never run due to the 10s controller sync period.",
	},
}

// VersionChangelog describes all feature and field changes between two adjacent versions.
type VersionChangelog struct {
	Version      string         `json:"version"`
	PrevVersion  string         `json:"prevVersion,omitempty"`
	NewFeatures  []FeatureInfo  `json:"newFeatures,omitempty"`
	RemovedAPIs  []APIMigration `json:"removedAPIs,omitempty"`
	FieldChanges []FieldNote    `json:"fieldChanges,omitempty"`
	Notes        []string       `json:"notes,omitempty"`
}

// ChangelogFor returns the changelog for upgrading from the previous version to `version`.
func ChangelogFor(version string) VersionChangelog {
	prev := PreviousVersion(version)
	cl := VersionChangelog{
		Version:     version,
		PrevVersion: prev,
		Notes:       versionNotes[version],
	}

	// New features: available in `version` but not in `prev`
	if prev != "" {
		for _, f := range Features {
			wasAvailable := f.Available(prev)
			isAvailable := f.Available(version)
			if !wasAvailable && isAvailable {
				cl.NewFeatures = append(cl.NewFeatures, f)
			}
		}
	}

	// Removed APIs: removed exactly in this version
	for _, m := range Migrations {
		if m.Removed == version {
			cl.RemovedAPIs = append(cl.RemovedAPIs, m)
		}
	}

	// Field changes: deprecated in this version
	for _, fn := range FieldNotes {
		if fn.DeprecatedIn == version || fn.RemovedIn == version {
			cl.FieldChanges = append(cl.FieldChanges, fn)
		}
	}

	return cl
}

// FieldNotesForKind returns field notes for a specific kind+apiGroup.
func FieldNotesForKind(kind, apiGroup string) []FieldNote {
	out := make([]FieldNote, 0)
	for _, fn := range FieldNotes {
		if fn.Kind == kind && (apiGroup == "" || fn.APIGroup == apiGroup) {
			out = append(out, fn)
		}
	}
	return out
}
