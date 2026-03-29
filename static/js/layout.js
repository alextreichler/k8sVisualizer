// layout.js — deterministic static grid layout
// Replaces the force-directed simulation with instant, stable positions.
// Same public API as ForceSimulation so main.js can hot-swap them.

// Column X offsets (relative to cx) per namespace
const NS_X_TARGETS = {
  'kube-system':     0,
  'monitoring':   -520,
  'default':       420,
  'redpanda-system': 820,
  'redpanda':     1220,
};

// Vertical layer index per resource kind
const KIND_RANKS = {
  'ControlPlaneComponent': 0,
  'Ingress':         1,
  'Service':         2,
  'CustomResource':  2,
  'ClusterRole':     2,
  'ClusterRoleBinding': 2,
  'Deployment':      3,
  'StatefulSet':     3,
  'DaemonSet':       3,
  'CronJob':         3,
  'Job':             3,
  'Namespace':       3,  // placed in their own column by name; same vertical band
  'HorizontalPodAutoscaler': 3,
  'Role':            3,
  'RoleBinding':     3,
  'ServiceAccount':  3,
  'ReplicaSet':      4,
  'Pod':             5,
  'PersistentVolumeClaim': 6,
  'ConfigMap':       6,
  'Secret':          6,
  'PersistentVolume': 7,
  'Node':            8,  // worker nodes at the bottom — pods are scheduled onto them
};

const RANK_SPACING = 230;  // px between rank rows
const ITEM_SPACING = 150;  // px between nodes in the same row+column group

// Fixed CP component positions (offsets from cx, cpCY)
const CP_SLOTS = {
  'kube-apiserver':           { dx:    0, dy:   0 },
  'etcd':                     { dx:  250, dy:   0 },
  'kube-scheduler':           { dx: -250, dy: -95 },
  'kube-controller-manager':  { dx: -250, dy:  95 },
  'cloud-controller-manager': { dx:  250, dy:  95 },
};

export class StaticLayout {
  constructor() {
    this._nodes = new Map(); // id → { x, y, ns, kind, name, fx?, fy? }
    this._edges = [];        // [{ source, target }]
    this._cx = 0;
    this._cy = 0;
    this._onTick = null;
    this._nsOffsets = new Map(); // ns|'__cp__' → { dx, dy }
  }

  // Move an entire namespace group by offset (dx, dy) from its default layout position.
  // Use '__cp__' for the Control Plane zone.
  setNsOffset(ns, dx, dy) {
    this._nsOffsets.set(ns, { dx, dy });
    this._compute();
    this._emit();
  }

  setCenter(cx, cy) {
    this._cx = cx;
    this._cy = cy;
    this._compute();
    this._emit();
  }

  onTick(cb) { this._onTick = cb; }

  // Load all nodes+links at once (replaces existing)
  load(nodes, edges) {
    const existing = this._nodes;
    this._nodes = new Map();
    for (const n of nodes) {
      const old = existing.get(n.id);
      this._nodes.set(n.id, {
        x: old?.x ?? 0,
        y: old?.y ?? 0,
        ns:   n.metadata?.namespace || '',
        kind: n.kind,
        name: n.metadata?.name || '',
        // preserve pin if any
        ...(old?.fx !== undefined ? { fx: old.fx, fy: old.fy } : {}),
      });
    }
    this._edges = edges
      .filter(e => this._nodes.has(e.source) && this._nodes.has(e.target))
      .map(e => ({ source: e.source, target: e.target }));
    this._compute();
    this._emit();
  }

  addNode(id, namespace, kind, x, y) {
    if (!this._nodes.has(id)) {
      this._nodes.set(id, {
        x: x ?? this._cx, y: y ?? this._cy,
        ns: namespace || '', kind: kind || '', name: '',
      });
      this._compute();
      this._emit();
    }
  }

  removeNode(id) {
    this._nodes.delete(id);
    this._compute();
    this._emit();
  }

  addLink(sourceID, targetID) {
    if (this._nodes.has(sourceID) && this._nodes.has(targetID)) {
      this._edges.push({ source: sourceID, target: targetID });
    }
  }

  removeLinks(nodeID) {
    this._edges = this._edges.filter(l => l.source !== nodeID && l.target !== nodeID);
  }

  pinNode(id, x, y) {
    const p = this._nodes.get(id);
    if (p) { p.fx = x; p.fy = y; p.x = x; p.y = y; }
  }

  unpinNode(id) {
    const p = this._nodes.get(id);
    if (p) {
      delete p.fx;
      delete p.fy;
      this._compute();
      this._emit();
    }
  }

  // Clear all user-dragged namespace offsets and recompute default positions.
  resetNsOffsets() {
    this._nsOffsets.clear();
    this._compute();
    this._emit();
  }

  // reheat() is a no-op for static layout (positions are immediate)
  // Accepts optional alpha arg to match ForceSimulation API
  reheat(_alpha) {
    this._compute();
    this._emit();
  }

  getPositions() {
    const pos = {};
    for (const [id, p] of this._nodes) pos[id] = { x: p.x, y: p.y };
    return pos;
  }

  // --- private ---

  _emit() {
    if (this._onTick) this._onTick(this.getPositions());
  }

  // Returns the absolute X target for a namespace string.
  // Namespace nodes use their .name field; unknown namespaces get a hash position.
  _colX(ns) {
    if (!ns) return this._cx;
    if (NS_X_TARGETS[ns] !== undefined) return this._cx + NS_X_TARGETS[ns];
    let h = 0;
    for (const c of ns) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
    return this._cx + ((h % 1200) - 600);
  }

  // Resolves which column a node should appear in.
  // - Real namespace:  use it directly.
  // - Namespace node:  use node.name (the namespace it represents).
  // - Cluster-scoped:  infer from a connected node's namespace.
  _effectiveNs(id) {
    const p = this._nodes.get(id);
    if (!p) return '';
    if (p.ns) return p.ns;
    if (p.kind === 'Namespace') return p.name; // e.g. name='redpanda' → redpanda column
    // Cluster-scoped (e.g. PersistentVolume): look at connected nodes
    for (const e of this._edges) {
      const peerId = e.source === id ? e.target : (e.target === id ? e.source : null);
      if (!peerId) continue;
      const peer = this._nodes.get(peerId);
      if (peer?.ns) return peer.ns;
    }
    return '';
  }

  _compute() {
    // Group nodes by (effectiveNs, rank), excluding pinned nodes
    const groups = new Map(); // "ns|rank" → [id, ...]
    const cpCY = this._cy + (0 - 3.5) * RANK_SPACING;

    for (const [id, p] of this._nodes) {
      if (p.fx !== undefined) continue; // pinned — user placed it

      if (p.kind === 'ControlPlaneComponent') {
        // Position using CP_SLOTS, then apply any user-dragged offset
        const slot = CP_SLOTS[p.name];
        const off = this._nsOffsets.get('__cp__') || { dx: 0, dy: 0 };
        if (slot) {
          p.x = this._cx + slot.dx + off.dx;
          p.y = cpCY + slot.dy + off.dy;
        } else {
          p.x = this._cx + off.dx;
          p.y = cpCY + off.dy;
        }
        continue;
      }

      const rank = KIND_RANKS[p.kind] ?? 3;
      const ns   = this._effectiveNs(id);
      const key  = `${ns}|${rank}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(id);
    }

    // Position each group: spread nodes evenly around their column centre
    for (const [key, ids] of groups) {
      const [ns, rankStr] = key.split('|');
      const rank = parseInt(rankStr, 10);
      const colX = this._colX(ns);
      const rowY = this._cy + (rank - 3.5) * RANK_SPACING;

      const count = ids.length;
      const totalWidth = (count - 1) * ITEM_SPACING;
      const startX = colX - totalWidth / 2;

      const off = this._nsOffsets.get(ns) || { dx: 0, dy: 0 };
      ids.forEach((id, i) => {
        const p = this._nodes.get(id);
        if (p.fx !== undefined) return;
        p.x = startX + i * ITEM_SPACING + off.dx;
        p.y = rowY + off.dy;
      });
    }
  }
}
