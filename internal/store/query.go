package store

import (
	"github.com/alextreichler/k8svisualizer/internal/models"
)

// FilterByKind returns all nodes of the given kind.
func (s *ClusterStore) FilterByKind(kind string) []*models.Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := s.byKind[kind]
	out := make([]*models.Node, 0, len(ids))
	for id := range ids {
		if n, ok := s.nodes[id]; ok {
			out = append(out, n)
		}
	}
	return out
}

// FilterByNamespace returns all nodes in the given namespace.
// Use "" to get cluster-scoped resources.
func (s *ClusterStore) FilterByNamespace(namespace string) []*models.Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ns := namespace
	if ns == "" {
		ns = "__cluster__"
	}
	ids := s.byNamespace[ns]
	out := make([]*models.Node, 0, len(ids))
	for id := range ids {
		if n, ok := s.nodes[id]; ok {
			out = append(out, n)
		}
	}
	return out
}

// FilterByKindAndNamespace returns nodes matching both kind and namespace.
func (s *ClusterStore) FilterByKindAndNamespace(kind, namespace string) []*models.Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ns := namespace
	if ns == "" {
		ns = "__cluster__"
	}
	kindSet := s.byKind[kind]
	nsSet := s.byNamespace[ns]
	out := make([]*models.Node, 0)
	// iterate the smaller set
	if len(kindSet) <= len(nsSet) {
		for id := range kindSet {
			if _, inNs := nsSet[id]; inNs {
				if n, ok := s.nodes[id]; ok {
					out = append(out, n)
				}
			}
		}
	} else {
		for id := range nsSet {
			if _, inKind := kindSet[id]; inKind {
				if n, ok := s.nodes[id]; ok {
					out = append(out, n)
				}
			}
		}
	}
	return out
}

// LookupByLabels returns nodes whose labels contain all key=value pairs in selector.
// Returns nil if selector is empty.
func (s *ClusterStore) LookupByLabels(selector map[string]string) []*models.Node {
	if len(selector) == 0 {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	var resultSet map[string]struct{}
	for k, v := range selector {
		candidates, ok := s.byLabel[k]
		if !ok {
			return nil
		}
		matches, ok := candidates[v]
		if !ok {
			return nil
		}
		if resultSet == nil {
			// copy first set
			resultSet = make(map[string]struct{}, len(matches))
			for id := range matches {
				resultSet[id] = struct{}{}
			}
		} else {
			// intersect
			for id := range resultSet {
				if _, ok := matches[id]; !ok {
					delete(resultSet, id)
				}
			}
		}
		if len(resultSet) == 0 {
			return nil
		}
	}

	out := make([]*models.Node, 0, len(resultSet))
	for id := range resultSet {
		if n, ok := s.nodes[id]; ok {
			out = append(out, n)
		}
	}
	return out
}

// EdgesOfType returns all edges of a given type originating from sourceID.
func (s *ClusterStore) EdgesOfType(sourceID string, etype models.EdgeType) []*models.Edge {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*models.Edge, 0)
	for eid := range s.edgesBySource[sourceID] {
		if e, ok := s.edges[eid]; ok && e.Type == etype {
			out = append(out, e)
		}
	}
	return out
}

// AllNamespaces returns a sorted list of namespace names present in the store.
func (s *ClusterStore) AllNamespaces() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0)
	for ns := range s.byNamespace {
		if ns == "__cluster__" {
			continue
		}
		out = append(out, ns)
	}
	return out
}
