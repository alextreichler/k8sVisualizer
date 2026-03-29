// Package schemas embeds CRD field definitions fetched by cmd/update-schemas
// and exposes accessor functions used by the HTTP handler and tests.
package schemas

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"time"
)

// ── Types ─────────────────────────────────────────────────────────────────────

// Field is one entry in a CRD spec, with its dot-notation path, type, and
// human-readable description extracted from the operator's CRD YAML.
type Field struct {
	Path        string   `json:"path"`
	Type        string   `json:"type,omitempty"`
	Description string   `json:"description,omitempty"`
	Default     string   `json:"default,omitempty"`
	Required    bool     `json:"required,omitempty"`
	Enum        []string `json:"enum,omitempty"`
}

// CRDSchema holds all fields for one CRD at one operator version.
type CRDSchema struct {
	CRD             string    `json:"crd"`
	Kind            string    `json:"kind"`
	Group           string    `json:"group"`
	APIVersion      string    `json:"apiVersion"`
	OperatorVersion string    `json:"operatorVersion"`
	SourceURL       string    `json:"sourceURL"`
	Fetched         time.Time `json:"fetched"`
	Fields          []Field   `json:"fields"`
}

// IndexEntry describes the CRD name and available versions for one Kind.
type IndexEntry struct {
	CRD      string   `json:"crd"`
	Versions []string `json:"versions"`
}

// Index is the top-level listing returned by GET /api/schemas.
type Index struct {
	Versions []string               `json:"versions"`
	CRDs     map[string]*IndexEntry `json:"crds"`
}

// ── Embedded data ─────────────────────────────────────────────────────────────

//go:embed data
var dataFS embed.FS // embed.FS is from the "embed" standard library package

// ── Registry ──────────────────────────────────────────────────────────────────

// registry is populated once at init time from the embedded JSON files.
var registry = map[string]map[string]*CRDSchema{} // kind → version → schema
var globalIndex *Index

func init() {
	entries, err := fs.ReadDir(dataFS, "data")
	if err != nil {
		panic("schemas: cannot read embedded data dir: " + err.Error())
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") || e.Name() == "index.json" {
			continue
		}
		b, err := fs.ReadFile(dataFS, path.Join("data", e.Name()))
		if err != nil {
			continue
		}
		var s CRDSchema
		if err := json.Unmarshal(b, &s); err != nil {
			continue
		}
		if registry[s.Kind] == nil {
			registry[s.Kind] = map[string]*CRDSchema{}
		}
		registry[s.Kind][s.OperatorVersion] = &s
	}

	// Load index.
	idxBytes, err := fs.ReadFile(dataFS, "data/index.json")
	if err == nil {
		var idx Index
		if json.Unmarshal(idxBytes, &idx) == nil {
			globalIndex = &idx
		}
	}
}

// ── Public API ────────────────────────────────────────────────────────────────

// GetIndex returns the index of available CRD schemas.
func GetIndex() *Index {
	return globalIndex
}

// Get returns the schema for the given kind at the given operator version.
// If version is empty, the latest available version is used.
func Get(kind, version string) (*CRDSchema, error) {
	versions, ok := registry[kind]
	if !ok {
		return nil, fmt.Errorf("no schema found for kind %q", kind)
	}
	if version == "" {
		version = latestVersion(versions)
	}
	s, ok := versions[version]
	if !ok {
		return nil, fmt.Errorf("no schema for kind %q at version %q", kind, version)
	}
	return s, nil
}

// Kinds returns all kinds that have at least one registered schema.
func Kinds() []string {
	out := make([]string, 0, len(registry))
	for k := range registry {
		out = append(out, k)
	}
	return out
}

// Versions returns all operator versions available for a given kind.
func Versions(kind string) []string {
	m, ok := registry[kind]
	if !ok {
		return nil
	}
	out := make([]string, 0, len(m))
	for v := range m {
		out = append(out, v)
	}
	return out
}

// latestVersion returns the lexicographically greatest version string, which
// works correctly for semver tags like v24.3.1 > v24.2.0.
func latestVersion(m map[string]*CRDSchema) string {
	latest := ""
	for v := range m {
		if v > latest {
			latest = v
		}
	}
	return latest
}
