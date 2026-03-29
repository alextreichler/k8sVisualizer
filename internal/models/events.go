package models

import "encoding/json"

// EventType describes what happened to a resource.
type EventType string

const (
	EventResourceCreated    EventType = "resource.created"
	EventResourceUpdated    EventType = "resource.updated"
	EventResourceDeleted    EventType = "resource.deleted"
	EventEdgeCreated        EventType = "edge.created"
	EventEdgeDeleted        EventType = "edge.deleted"
	EventSnapshot           EventType = "snapshot"
	EventVersionChanged     EventType = "version.changed"
	EventSimulationTick     EventType = "simulation.tick"
	EventScenarioStep       EventType = "scenario.step"
)

// SSEEvent is the payload sent over the Server-Sent Events stream.
type SSEEvent struct {
	Type        EventType       `json:"type"`
	Kind        string          `json:"kind,omitempty"`
	ResourceID  string          `json:"resourceID,omitempty"`
	Namespace   string          `json:"namespace,omitempty"`
	Timestamp   int64           `json:"timestamp"` // unix milliseconds
	Payload     json.RawMessage `json:"payload,omitempty"`
}
