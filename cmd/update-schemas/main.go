// update-schemas fetches Redpanda operator CRD YAML files from GitHub,
// walks the embedded OpenAPI v3 schema tree, and writes flattened field
// JSON files into internal/schemas/data/. Run via: make update-schemas
//
// Usage:
//
//	go run ./cmd/update-schemas                        # fetch latest release
//	go run ./cmd/update-schemas -versions v24.3.1,v24.2.0
//	go run ./cmd/update-schemas -versions latest -out ./internal/schemas/data
//
// The GitHub API allows 60 unauthenticated requests/hour. Set GITHUB_TOKEN
// in the environment to raise the limit to 5000/hour.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"sigs.k8s.io/yaml"
)

// ── Types ────────────────────────────────────────────────────────────────────

// Field is one flattened entry from the CRD OpenAPI schema.
type Field struct {
	Path        string   `json:"path"`
	Type        string   `json:"type,omitempty"`
	Description string   `json:"description,omitempty"`
	Default     string   `json:"default,omitempty"`
	Required    bool     `json:"required,omitempty"`
	Enum        []string `json:"enum,omitempty"`
}

// CRDSchema is the output file format for one CRD at one operator version.
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

// IndexEntry is a record in the index file.
type IndexEntry struct {
	CRD      string   `json:"crd"`
	Versions []string `json:"versions"`
}

// ── CRD definitions ──────────────────────────────────────────────────────────

// crdDef describes one CRD we want to track.
type crdDef struct {
	kind  string // matches models.Kind* constant
	group string
	crd   string // full CRD name (plural.group)
	file  string // filename inside the repo
}

var crdDefs = []crdDef{
	{"Redpanda", "cluster.redpanda.com", "redpandas.cluster.redpanda.com", "cluster.redpanda.com_redpandas.yaml"},
	{"RedpandaTopic", "cluster.redpanda.com", "topics.cluster.redpanda.com", "cluster.redpanda.com_topics.yaml"},
	{"RedpandaUser", "cluster.redpanda.com", "users.cluster.redpanda.com", "cluster.redpanda.com_users.yaml"},
	{"RedpandaSchema", "cluster.redpanda.com", "schemas.cluster.redpanda.com", "cluster.redpanda.com_schemas.yaml"},
}

// Candidate paths inside the operator repo where CRDs might live.
// Tried in order; first successful fetch wins.
var crdRepoPaths = []string{
	"config/crd/bases",
	"operator/config/crd/bases",
	"charts/operator/crds",
}

const (
	repoOwner   = "redpanda-data"
	repoName    = "redpanda-operator"
	releasesAPI = "https://api.github.com/repos/" + repoOwner + "/" + repoName + "/releases"
	rawBase     = "https://raw.githubusercontent.com/" + repoOwner + "/" + repoName
)

// ── Main ─────────────────────────────────────────────────────────────────────

func main() {
	versionsFlag := flag.String("versions", "latest", "Comma-separated operator versions to fetch, or 'latest'")
	outDir := flag.String("out", "internal/schemas/data", "Output directory for JSON files")
	flag.Parse()

	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", *outDir, err)
	}

	versions, err := resolveVersions(*versionsFlag)
	if err != nil {
		log.Fatalf("resolve versions: %v", err)
	}
	log.Printf("fetching schemas for versions: %v", versions)

	// Track which versions we successfully wrote for the index.
	index := map[string]*IndexEntry{}
	for _, d := range crdDefs {
		index[d.kind] = &IndexEntry{CRD: d.crd}
	}

	for _, version := range versions {
		for _, def := range crdDefs {
			schema, err := fetchCRDSchema(version, def)
			if err != nil {
				log.Printf("WARN: %s @ %s: %v", def.kind, version, err)
				continue
			}

			fname := filepath.Join(*outDir, fmt.Sprintf("%s_%s.json", def.kind, version))
			data, _ := json.MarshalIndent(schema, "", "  ")
			if err := os.WriteFile(fname, data, 0o644); err != nil {
				log.Fatalf("write %s: %v", fname, err)
			}
			log.Printf("  wrote %s", fname)
			index[def.kind].Versions = append(index[def.kind].Versions, version)
		}
	}

	// Collect all distinct versions across all CRDs for the top-level list.
	versionSet := map[string]bool{}
	for _, entry := range index {
		for _, v := range entry.Versions {
			versionSet[v] = true
		}
	}
	allVersions := make([]string, 0, len(versionSet))
	for v := range versionSet {
		allVersions = append(allVersions, v)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(allVersions)))

	idxOut := struct {
		Versions []string               `json:"versions"`
		CRDs     map[string]*IndexEntry `json:"crds"`
	}{Versions: allVersions, CRDs: index}

	idxData, _ := json.MarshalIndent(idxOut, "", "  ")
	idxPath := filepath.Join(*outDir, "index.json")
	if err := os.WriteFile(idxPath, idxData, 0o644); err != nil {
		log.Fatalf("write index: %v", err)
	}
	log.Printf("wrote index → %s", idxPath)
}

// ── Version resolution ───────────────────────────────────────────────────────

func resolveVersions(flag string) ([]string, error) {
	if flag != "latest" {
		return strings.Split(flag, ","), nil
	}

	type release struct {
		TagName    string `json:"tag_name"`
		Prerelease bool   `json:"prerelease"`
		Draft      bool   `json:"draft"`
	}

	body, err := ghGet(releasesAPI + "?per_page=10")
	if err != nil {
		return nil, fmt.Errorf("list releases: %w", err)
	}
	var releases []release
	if err := json.Unmarshal(body, &releases); err != nil {
		return nil, fmt.Errorf("decode releases: %w", err)
	}
	for _, r := range releases {
		if !r.Prerelease && !r.Draft && r.TagName != "" {
			return []string{r.TagName}, nil
		}
	}
	return nil, fmt.Errorf("no stable release found")
}

// ── CRD fetch & parse ────────────────────────────────────────────────────────

func fetchCRDSchema(version string, def crdDef) (*CRDSchema, error) {
	var (
		rawYAML []byte
		srcURL  string
		err     error
	)

	// Try each candidate path in the repo.
	for _, repoPath := range crdRepoPaths {
		url := fmt.Sprintf("%s/%s/%s/%s", rawBase, version, repoPath, def.file)
		rawYAML, err = ghGet(url)
		if err == nil {
			srcURL = url
			break
		}
		log.Printf("  try %s → %v", url, err)
	}
	if srcURL == "" {
		return nil, fmt.Errorf("CRD file not found in any known path for %s@%s", def.kind, version)
	}

	// Parse YAML into a generic map.
	var raw map[string]interface{}
	if err := yaml.Unmarshal(rawYAML, &raw); err != nil {
		return nil, fmt.Errorf("parse YAML: %w", err)
	}

	// Navigate to spec.versions[0].schema.openAPIV3Schema.properties.spec
	specSchema, apiVersion, err := extractSpecSchema(raw)
	if err != nil {
		return nil, fmt.Errorf("extract spec schema: %w", err)
	}

	fields := walkSchema(specSchema, "spec", map[string]bool{}, 0)
	sort.Slice(fields, func(i, j int) bool { return fields[i].Path < fields[j].Path })

	return &CRDSchema{
		CRD:             def.crd,
		Kind:            def.kind,
		Group:           def.group,
		APIVersion:      apiVersion,
		OperatorVersion: version,
		SourceURL:       srcURL,
		Fetched:         time.Now().UTC().Truncate(time.Second),
		Fields:          fields,
	}, nil
}

// extractSpecSchema navigates the raw CRD map to find the spec schema and k8s API version name.
func extractSpecSchema(raw map[string]interface{}) (map[string]interface{}, string, error) {
	crdSpec, _ := raw["spec"].(map[string]interface{})
	versions, _ := crdSpec["versions"].([]interface{})
	if len(versions) == 0 {
		return nil, "", fmt.Errorf("no versions found in CRD spec")
	}

	// Use the first (or only) version.
	ver, _ := versions[0].(map[string]interface{})
	apiVersion, _ := ver["name"].(string)
	schema, _ := ver["schema"].(map[string]interface{})
	openAPI, _ := schema["openAPIV3Schema"].(map[string]interface{})
	props, _ := openAPI["properties"].(map[string]interface{})
	specNode, _ := props["spec"].(map[string]interface{})

	if specNode == nil {
		return nil, "", fmt.Errorf("spec not found in openAPIV3Schema")
	}
	return specNode, apiVersion, nil
}

// walkSchema recursively flattens the OpenAPI v3 schema into a []Field.
// maxDepth prevents runaway recursion on deeply nested CRDs.
const maxDepth = 12

func walkSchema(node map[string]interface{}, path string, required map[string]bool, depth int) []Field {
	if depth > maxDepth {
		return nil
	}

	// x-kubernetes-preserve-unknown-fields: true means "any keys allowed here" —
	// there is no schema to walk.
	if preserve, _ := node["x-kubernetes-preserve-unknown-fields"].(bool); preserve {
		return nil
	}

	typ, _ := node["type"].(string)
	desc, _ := node["description"].(string)

	f := Field{
		Path:        path,
		Type:        typ,
		Description: cleanDesc(desc),
		Required:    required[lastName(path)],
	}
	if def, ok := node["default"]; ok {
		b, _ := json.Marshal(def)
		f.Default = strings.Trim(string(b), "\"")
	}
	if enums, ok := node["enum"].([]interface{}); ok {
		for _, e := range enums {
			b, _ := json.Marshal(e)
			f.Enum = append(f.Enum, strings.Trim(string(b), "\""))
		}
	}

	var fields []Field
	// Only emit a field record for leaf nodes or nodes that have a description.
	// Intermediate objects without descriptions just provide path context.
	if f.Description != "" || len(getProperties(node)) == 0 {
		fields = append(fields, f)
	}

	// Recurse into object properties.
	reqSet := map[string]bool{}
	if reqs, ok := node["required"].([]interface{}); ok {
		for _, r := range reqs {
			if s, ok := r.(string); ok {
				reqSet[s] = true
			}
		}
	}
	for name, child := range getProperties(node) {
		childMap, ok := child.(map[string]interface{})
		if !ok {
			continue
		}
		fields = append(fields, walkSchema(childMap, path+"."+name, reqSet, depth+1)...)
	}

	return fields
}

func getProperties(node map[string]interface{}) map[string]interface{} {
	props, _ := node["properties"].(map[string]interface{})
	return props
}

func lastName(path string) string {
	parts := strings.Split(path, ".")
	return parts[len(parts)-1]
}

// cleanDesc normalises whitespace in CRD descriptions (they often have leading tabs).
func cleanDesc(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(l)
	}
	joined := strings.Join(lines, " ")
	// Collapse runs of spaces.
	for strings.Contains(joined, "  ") {
		joined = strings.ReplaceAll(joined, "  ", " ")
	}
	return strings.TrimSpace(joined)
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

func ghGet(url string) ([]byte, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "k8sVisualizer/update-schemas")
	if tok := os.Getenv("GITHUB_TOKEN"); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("404 not found")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Polite delay to avoid hammering GitHub.
	time.Sleep(200 * time.Millisecond)
	return body, nil
}
