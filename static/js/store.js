// store.js — client-side state: nodes, edges, filters, observers

export class ClientStore {
  constructor() {
    this.nodes = new Map();     // id → node
    this.edges = new Map();     // id → edge
    this.selectedNodeID = null;
    this.selectedNamespace = ''; // '' means "all"
    this.hiddenKinds = new Set();
    this.version = '';
    this._subscribers = [];
  }

  // --- Snapshot / incremental update ---

  applySnapshot(snapshot) {
    this.nodes.clear();
    this.edges.clear();
    for (const n of snapshot.nodes || []) this.nodes.set(n.id, n);
    for (const e of snapshot.edges || []) this.edges.set(e.id, e);
    this.version = snapshot.version || '';
    this._notify('snapshot');
  }

  applyEvent(event) {
    switch (event.type) {
      case 'resource.created':
      case 'resource.updated':
        if (event.payload) this.nodes.set(event.payload.id, event.payload);
        this._notify('node', event.payload);
        break;
      case 'resource.deleted':
        if (event.payload) this.nodes.delete(event.payload.id);
        if (this.selectedNodeID === event.resourceID) {
          this.selectedNodeID = null;
          this._notify('selection', null);
        }
        this._notify('node', event.payload);
        break;
      case 'edge.created':
        if (event.payload) this.edges.set(event.payload.id, event.payload);
        this._notify('edge', event.payload);
        break;
      case 'edge.deleted':
        if (event.payload) this.edges.delete(event.payload.id);
        this._notify('edge', event.payload);
        break;
      case 'version.changed':
        if (event.payload) this.applySnapshot(event.payload);
        break;
      case 'snapshot':
        if (event.payload) this.applySnapshot(event.payload);
        break;
    }
  }

  // --- Filtered views ---

  /** Returns nodes visible under current namespace + kind filters */
  visibleNodes() {
    const out = [];
    for (const n of this.nodes.values()) {
      if (this.hiddenKinds.has(n.kind)) continue;
      const ns = n.metadata?.namespace || '';
      if (this.selectedNamespace && ns && ns !== this.selectedNamespace) continue;
      out.push(n);
    }
    return out;
  }

  /** Returns edges where both endpoints are in visibleNodes */
  visibleEdges() {
    const visible = new Set(this.visibleNodes().map(n => n.id));
    const out = [];
    for (const e of this.edges.values()) {
      if (visible.has(e.source) && visible.has(e.target)) out.push(e);
    }
    return out;
  }

  allNamespaces() {
    const ns = new Set();
    for (const n of this.nodes.values()) {
      const nodeNS = n.metadata?.namespace;
      if (nodeNS) ns.add(nodeNS);
    }
    return [...ns].sort();
  }

  allKinds() {
    const kinds = new Set();
    for (const n of this.nodes.values()) kinds.add(n.kind);
    return [...kinds].sort();
  }

  stats() {
    let pods = 0, running = 0;
    for (const n of this.nodes.values()) {
      if (n.kind === 'Pod') {
        pods++;
        if (n.simPhase === 'Running') running++;
      }
    }
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      pods,
      running,
    };
  }

  // --- Selection ---

  select(id) {
    this.selectedNodeID = id;
    this._notify('selection', id ? this.nodes.get(id) : null);
  }

  deselect() {
    this.selectedNodeID = null;
    this._notify('selection', null);
  }

  // --- Observers ---

  subscribe(callback) {
    this._subscribers.push(callback);
    return () => { this._subscribers = this._subscribers.filter(s => s !== callback); };
  }

  _notify(type, data) {
    for (const s of this._subscribers) {
      try { s(type, data); } catch (err) { console.error('store subscriber error:', err); }
    }
  }
}
