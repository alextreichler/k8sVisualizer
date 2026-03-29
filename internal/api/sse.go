package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/alextreichler/k8svisualizer/internal/models"
)

// SSEBroker fans out SSEEvents to all connected SSE clients.
type SSEBroker struct {
	mu         sync.RWMutex
	clients    map[chan models.SSEEvent]struct{}
	maxClients int // 0 = unlimited
}

// NewSSEBroker creates a ready-to-use SSEBroker.
// maxClients is the maximum number of concurrent SSE connections (0 = unlimited).
func NewSSEBroker(maxClients int) *SSEBroker {
	return &SSEBroker{
		clients:    make(map[chan models.SSEEvent]struct{}),
		maxClients: maxClients,
	}
}

// Subscribe registers a new client channel and returns (ch, true).
// Returns (nil, false) if the connection limit has been reached.
func (b *SSEBroker) Subscribe() (chan models.SSEEvent, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.maxClients > 0 && len(b.clients) >= b.maxClients {
		return nil, false
	}
	ch := make(chan models.SSEEvent, 64)
	b.clients[ch] = struct{}{}
	return ch, true
}

// Unsubscribe removes and closes a client channel.
func (b *SSEBroker) Unsubscribe(ch chan models.SSEEvent) {
	b.mu.Lock()
	if _, ok := b.clients[ch]; ok {
		delete(b.clients, ch)
		close(ch)
	}
	b.mu.Unlock() // release before close to avoid holding lock during GC
}

// Publish sends an event to all subscribed clients (non-blocking; drops if buffer full).
func (b *SSEBroker) Publish(event models.SSEEvent) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.clients {
		select {
		case ch <- event:
		default:
			// Client too slow — drop event rather than blocking.
		}
	}
}

// HandleSSE is the HTTP handler for GET /api/events.
// It immediately sends a snapshot then streams incremental events.
func (h *Handlers) HandleSSE(w http.ResponseWriter, r *http.Request) {
	// SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	namespace := r.URL.Query().Get("namespace")

	// Send immediate snapshot so client can initialise without a separate REST call.
	snap := h.store.Snapshot(namespace)
	if err := writeSSEEvent(w, models.SSEEvent{
		Type:      models.EventSnapshot,
		Timestamp: snap.Timestamp,
		Payload:   mustMarshal(snap),
	}); err != nil {
		return
	}
	flusher.Flush()

	// Subscribe to future events.
	ch, ok := h.broker.Subscribe()
	if !ok {
		http.Error(w, "too many connections", http.StatusServiceUnavailable)
		return
	}
	defer h.broker.Unsubscribe(ch)

	// Ping every 25s to keep the connection alive through proxies.
	// nginx's proxy_read_timeout defaults to 60s; staying well under it prevents drops.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ping.C:
			// SSE comment — invisible to clients but resets the proxy idle timer.
			if _, err := fmt.Fprintf(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-ch:
			if !ok {
				return
			}
			// Filter by namespace if requested
			if namespace != "" && event.Namespace != "" && event.Namespace != namespace {
				continue
			}
			if err := writeSSEEvent(w, event); err != nil {
				log.Printf("sse write error: %v", err)
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSEEvent(w http.ResponseWriter, event models.SSEEvent) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "data: %s\n\n", data)
	return err
}

func mustMarshal(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}
