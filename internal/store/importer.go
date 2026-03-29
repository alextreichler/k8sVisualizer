package store

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
	"sigs.k8s.io/yaml"
)

// ImportYAML reads a multidoc K8s YAML stream and adds the resources to the store.
func ImportYAML(s *ClusterStore, yamlData []byte, defaultNamespace string) ([]*models.Node, error) {
	docs := bytes.Split(yamlData, []byte("\n---\n"))
	var imported []*models.Node

	for _, doc := range docs {
		doc = bytes.TrimSpace(doc)
		if len(doc) == 0 {
			continue
		}

		// Convert YAML to JSON
		jsonData, err := yaml.YAMLToJSON(doc)
		if err != nil {
			return nil, fmt.Errorf("error converting yaml to json: %v", err)
		}

		var partial struct {
			APIVersion string            `json:"apiVersion"`
			Kind       string            `json:"kind"`
			Metadata   models.ObjectMeta `json:"metadata"`
			Spec       json.RawMessage   `json:"spec"`
			Status     json.RawMessage   `json:"status"`
		}
		if err := json.Unmarshal(jsonData, &partial); err != nil {
			return nil, fmt.Errorf("error unmarshaling basic fields: %v", err)
		}

		// Skip empty documents or list wrappers for now
		if partial.Kind == "" || partial.Kind == "List" {
			continue
		}

		ns := partial.Metadata.Namespace
		if ns == "" {
			ns = defaultNamespace
		}

		id := fmt.Sprintf("%s-%s-%s", strings.ToLower(partial.Kind), partial.Metadata.Name, ns)
		
		n := &models.Node{
			ID: id,
			TypeMeta: models.TypeMeta{
				APIVersion: partial.APIVersion,
				Kind:       partial.Kind,
			},
			ObjectMeta: models.ObjectMeta{
				Name:        partial.Metadata.Name,
				Namespace:   ns,
				Labels:      partial.Metadata.Labels,
				Annotations: partial.Metadata.Annotations,
				CreatedAt:   time.Now(),
			},
			Spec:   partial.Spec,
			Status: partial.Status,
		}

		// Handle kind specific initialization if necessary
		if len(n.Spec) == 0 || string(n.Spec) == "null" {
			n.Spec = []byte("{}")
		}

		s.Add(n)
		imported = append(imported, n)
	}

	return imported, nil
}
