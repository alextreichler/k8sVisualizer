package store

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// ClusterStore is the in-memory state of the simulated cluster.
// All reads and writes are protected by an RWMutex.
// Every mutation fires an SSEEvent via the OnChange callback.
type ClusterStore struct {
	mu sync.RWMutex

	nodes map[string]*models.Node
	edges map[string]*models.Edge

	// Indexes for fast lookup
	byKind      map[string]map[string]struct{} // kind → set of Node IDs
	byNamespace map[string]map[string]struct{} // namespace → set of Node IDs

	// label index: key → value → set of Node IDs
	byLabel map[string]map[string]map[string]struct{}

	// Edge indexes
	edgesBySource map[string]map[string]struct{} // sourceID → set of Edge IDs
	edgesByTarget map[string]map[string]struct{} // targetID → set of Edge IDs

	// Mutation callback — called inside write lock; broker uses buffered channels so it won't block
	OnChange func(models.SSEEvent)

	// Active K8s version
	ActiveVersion string
}

// New creates an empty ClusterStore.
func New() *ClusterStore {
	return &ClusterStore{
		nodes:         make(map[string]*models.Node),
		edges:         make(map[string]*models.Edge),
		byKind:        make(map[string]map[string]struct{}),
		byNamespace:   make(map[string]map[string]struct{}),
		byLabel:       make(map[string]map[string]map[string]struct{}),
		edgesBySource: make(map[string]map[string]struct{}),
		edgesByTarget: make(map[string]map[string]struct{}),
		ActiveVersion: "1.29",
	}
}

// --- Node CRUD ---

// Add inserts a new node, assigns CreatedAt, and fires EventResourceCreated.
func (s *ClusterStore) Add(n *models.Node) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if n.ObjectMeta.CreatedAt.IsZero() {
		n.ObjectMeta.CreatedAt = time.Now()
	}

	s.nodes[n.ID] = n
	s.indexNode(n)
	s.fire(models.EventResourceCreated, n.Kind, n.ID, n.Namespace, n)
}

// Update replaces an existing node and fires EventResourceUpdated.
func (s *ClusterStore) Update(n *models.Node) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if old, ok := s.nodes[n.ID]; ok {
		s.deindexNode(old)
	}
	s.nodes[n.ID] = n
	s.indexNode(n)
	s.fire(models.EventResourceUpdated, n.Kind, n.ID, n.Namespace, n)
}

// Delete removes a node and all its edges, cascading SSE events.
func (s *ClusterStore) Delete(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	n, ok := s.nodes[id]
	if !ok {
		return
	}

	// Cascade: remove all edges referencing this node
	toRemove := make([]string, 0)
	for eid := range s.edgesBySource[id] {
		toRemove = append(toRemove, eid)
	}
	for eid := range s.edgesByTarget[id] {
		toRemove = append(toRemove, eid)
	}
	for _, eid := range toRemove {
		s.removeEdge(eid)
	}

	s.deindexNode(n)
	delete(s.nodes, id)
	s.fire(models.EventResourceDeleted, n.Kind, id, n.Namespace, map[string]string{"id": id, "kind": n.Kind})
}

// Get returns a node by ID (read lock).
func (s *ClusterStore) Get(id string) (*models.Node, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n, ok := s.nodes[id]
	return n, ok
}

// List returns all nodes (read lock). Returns a shallow copy of the slice.
func (s *ClusterStore) List() []*models.Node {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*models.Node, 0, len(s.nodes))
	for _, n := range s.nodes {
		out = append(out, n)
	}
	return out
}

// --- Edge CRUD ---

// AddEdge inserts an edge (deterministic ID prevents duplicates).
func (s *ClusterStore) AddEdge(e *models.Edge) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.edges[e.ID]; exists {
		return // idempotent
	}
	s.edges[e.ID] = e
	s.indexEdge(e)
	s.fire(models.EventEdgeCreated, "", e.ID, "", e)
}

// RemoveEdge deletes an edge by ID.
func (s *ClusterStore) RemoveEdge(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removeEdge(id)
}

// removeEdge is the unlocked internal version.
func (s *ClusterStore) removeEdge(id string) {
	e, ok := s.edges[id]
	if !ok {
		return
	}
	delete(s.edgesBySource[e.Source], id)
	delete(s.edgesByTarget[e.Target], id)
	delete(s.edges, id)
	s.fire(models.EventEdgeDeleted, "", id, "", map[string]string{"id": id})
}

// GetEdge returns an edge by ID.
func (s *ClusterStore) GetEdge(id string) (*models.Edge, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.edges[id]
	return e, ok
}

// ListEdges returns all edges.
func (s *ClusterStore) ListEdges() []*models.Edge {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*models.Edge, 0, len(s.edges))
	for _, e := range s.edges {
		out = append(out, e)
	}
	return out
}

// EdgesForNode returns all edges where source or target matches nodeID.
func (s *ClusterStore) EdgesForNode(nodeID string) []*models.Edge {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := make(map[string]struct{})
	out := make([]*models.Edge, 0)
	for eid := range s.edgesBySource[nodeID] {
		if _, ok := seen[eid]; !ok {
			seen[eid] = struct{}{}
			out = append(out, s.edges[eid])
		}
	}
	for eid := range s.edgesByTarget[nodeID] {
		if _, ok := seen[eid]; !ok {
			seen[eid] = struct{}{}
			out = append(out, s.edges[eid])
		}
	}
	return out
}

// --- Deterministic edge ID helper ---

// EdgeID builds a deterministic edge ID from its components.
func EdgeID(sourceID, targetID string, etype models.EdgeType) string {
	return fmt.Sprintf("edge-%s-%s-%s", sourceID, targetID, etype)
}

// --- Snapshot ---

// Snapshot returns a consistent GraphSnapshot (acquires read lock).
func (s *ClusterStore) Snapshot(namespace string) *models.GraphSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	nodes := make([]*models.Node, 0, len(s.nodes))
	nodeSet := make(map[string]struct{})

	for _, n := range s.nodes {
		if namespace != "" && n.Namespace != namespace && n.Namespace != "" {
			continue
		}
		nodes = append(nodes, n)
		nodeSet[n.ID] = struct{}{}
	}

	edges := make([]*models.Edge, 0, len(s.edges))
	for _, e := range s.edges {
		_, srcOk := nodeSet[e.Source]
		_, tgtOk := nodeSet[e.Target]
		if srcOk && tgtOk {
			edges = append(edges, e)
		}
	}

	return &models.GraphSnapshot{
		Nodes:     nodes,
		Edges:     edges,
		Timestamp: time.Now().UnixMilli(),
		Version:   s.ActiveVersion,
	}
}

// --- Reset ---

// Clear wipes all data (does not fire SSE events — caller handles that).
func (s *ClusterStore) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodes = make(map[string]*models.Node)
	s.edges = make(map[string]*models.Edge)
	s.byKind = make(map[string]map[string]struct{})
	s.byNamespace = make(map[string]map[string]struct{})
	s.byLabel = make(map[string]map[string]map[string]struct{})
	s.edgesBySource = make(map[string]map[string]struct{})
	s.edgesByTarget = make(map[string]map[string]struct{})
}

// --- Index helpers (called inside lock) ---

func (s *ClusterStore) indexNode(n *models.Node) {
	if s.byKind[n.Kind] == nil {
		s.byKind[n.Kind] = make(map[string]struct{})
	}
	s.byKind[n.Kind][n.ID] = struct{}{}

	ns := n.Namespace
	if ns == "" {
		ns = "__cluster__"
	}
	if s.byNamespace[ns] == nil {
		s.byNamespace[ns] = make(map[string]struct{})
	}
	s.byNamespace[ns][n.ID] = struct{}{}

	for k, v := range n.Labels {
		if s.byLabel[k] == nil {
			s.byLabel[k] = make(map[string]map[string]struct{})
		}
		if s.byLabel[k][v] == nil {
			s.byLabel[k][v] = make(map[string]struct{})
		}
		s.byLabel[k][v][n.ID] = struct{}{}
	}
}

func (s *ClusterStore) deindexNode(n *models.Node) {
	delete(s.byKind[n.Kind], n.ID)
	ns := n.Namespace
	if ns == "" {
		ns = "__cluster__"
	}
	delete(s.byNamespace[ns], n.ID)
	for k, v := range n.Labels {
		if s.byLabel[k] != nil && s.byLabel[k][v] != nil {
			delete(s.byLabel[k][v], n.ID)
		}
	}
}

func (s *ClusterStore) indexEdge(e *models.Edge) {
	if s.edgesBySource[e.Source] == nil {
		s.edgesBySource[e.Source] = make(map[string]struct{})
	}
	s.edgesBySource[e.Source][e.ID] = struct{}{}

	if s.edgesByTarget[e.Target] == nil {
		s.edgesByTarget[e.Target] = make(map[string]struct{})
	}
	s.edgesByTarget[e.Target][e.ID] = struct{}{}
}

// --- SSE event helper ---

func (s *ClusterStore) fire(etype models.EventType, kind, id, ns string, payload interface{}) {
	if s.OnChange == nil {
		return
	}
	raw, _ := json.Marshal(payload)
	s.OnChange(models.SSEEvent{
		Type:       etype,
		Kind:       kind,
		ResourceID: id,
		Namespace:  ns,
		Timestamp:  time.Now().UnixMilli(),
		Payload:    raw,
	})
}
