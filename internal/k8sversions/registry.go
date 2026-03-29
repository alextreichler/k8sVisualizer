// Package k8sversions provides metadata about Kubernetes API versions,
// including feature availability, API group migrations, and field-level deprecations.
package k8sversions

import "fmt"

// SupportedVersions is the list of K8s versions the tool knows about, oldest first.
var SupportedVersions = []string{
	"1.16", "1.17", "1.18", "1.19", "1.20", "1.21",
	"1.22", "1.23", "1.24", "1.25", "1.26", "1.27",
	"1.28", "1.29", "1.30",
}

// DefaultVersion is the version used when none is specified.
const DefaultVersion = "1.29"

// IsSupported returns true if the given version string is in SupportedVersions.
func IsSupported(v string) bool {
	for _, sv := range SupportedVersions {
		if sv == v {
			return true
		}
	}
	return false
}

// PreviousVersion returns the version immediately before v, or "" if v is the oldest.
func PreviousVersion(v string) string {
	for i, sv := range SupportedVersions {
		if sv == v && i > 0 {
			return SupportedVersions[i-1]
		}
	}
	return ""
}

// VersionInfo is a summary of a K8s version for the /api/versions response.
type VersionInfo struct {
	Version       string   `json:"version"`
	IsDefault     bool     `json:"isDefault"`
	NotableChange []string `json:"notableChanges,omitempty"`
}

// Summary returns a list of VersionInfo for all supported versions.
func Summary() []VersionInfo {
	out := make([]VersionInfo, 0, len(SupportedVersions))
	for _, v := range SupportedVersions {
		vi := VersionInfo{
			Version:       v,
			IsDefault:     v == DefaultVersion,
			NotableChange: versionNotes[v],
		}
		out = append(out, vi)
	}
	return out
}

// versionNotes maps version to human-readable notable changes (for the UI changelog).
var versionNotes = map[string][]string{
	"1.16": {
		"extensions/v1beta1: Deployment, DaemonSet, StatefulSet, ReplicaSet removed (use apps/v1)",
		"networking.k8s.io/v1beta1 Ingress introduced",
	},
	"1.17": {
		"StorageClass volumeBindingMode GA",
		"CSI migration beta",
	},
	"1.18": {
		"IngressClass resource added (networking.k8s.io/v1beta1)",
		"kubectl debug alpha",
	},
	"1.19": {
		"Ingress GA: networking.k8s.io/v1 (extensions/v1beta1 deprecated)",
		"Storage capacity tracking alpha",
		"Immutable ConfigMaps and Secrets beta",
	},
	"1.20": {
		"kubectl debug beta",
		"CronJob v2 beta",
		"PodDisruptionBudget policy/v1beta1",
	},
	"1.21": {
		"CronJob batch/v1 GA (batch/v1beta1 deprecated)",
		"Immutable Secrets/ConfigMaps GA",
		"PodDisruptionBudget policy/v1 beta",
		"IPv4/IPv6 dual-stack GA",
	},
	"1.22": {
		"Ingress extensions/v1beta1 REMOVED (use networking.k8s.io/v1)",
		"CustomResourceDefinitions apiextensions.k8s.io/v1beta1 REMOVED",
		"ServiceAccount token volume projection GA",
	},
	"1.23": {
		"HorizontalPodAutoscaler autoscaling/v2 GA",
		"FlexVolumes deprecated",
		"PodSecurity admission alpha",
	},
	"1.24": {
		"Dockershim removed from kubelet",
		"Non-graceful node shutdown beta",
		"Gateway API v0.5 (alpha in core)",
	},
	"1.25": {
		"PodSecurityPolicy REMOVED (use PodSecurity admission)",
		"Ephemeral containers GA",
		"CronJob batch/v1beta1 REMOVED",
	},
	"1.26": {
		"autoscaling/v2 HPA: autoscaling/v2beta2 deprecated",
		"CPUManagerPolicy alpha options",
		"Retroactive StorageClass assignment beta",
	},
	"1.27": {
		"Kubernetes v1.27 'Chill Vibes'",
		"SeccompDefault GA",
		"ReadWriteOncePod PV access mode GA",
	},
	"1.28": {
		"Sidecar containers (alpha)",
		"Mixed version proxy alpha",
		"Job success/completion policy alpha",
	},
	"1.29": {
		"ReadWriteOncePod GA",
		"KV store based watch cache beta",
		"Node log query alpha",
	},
	"1.30": {
		"Structured authentication configuration GA",
		"Pod scheduling readiness GA",
		"Volume group snapshot alpha",
	},
}

// versionLess returns true if a < b (both "1.NN" format).
func versionLess(a, b string) bool {
	var aMajor, aMinor, bMajor, bMinor int
	fmt.Sscanf(a, "%d.%d", &aMajor, &aMinor)
	fmt.Sscanf(b, "%d.%d", &bMajor, &bMinor)
	if aMajor != bMajor {
		return aMajor < bMajor
	}
	return aMinor < bMinor
}

// versionGE returns true if a >= b.
func versionGE(a, b string) bool {
	return !versionLess(a, b)
}
