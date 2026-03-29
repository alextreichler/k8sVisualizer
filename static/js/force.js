// force.js — velocity-verlet force-directed layout simulation

const REPULSION      = 22000; // charge repulsion strength (high = nodes spread out)
const SPRING_K       = 0.03;  // link spring constant (low = soft springs)
const SPRING_REST    = 240;   // link rest length (px)
const CENTER_SHIFT   = 0.04;  // center-of-mass Y-only correction
const NS_COLUMN_STR  = 0.07;  // pull toward fixed namespace X column
const COLLISION_PAD  = 32;    // minimum gap between node edges
const DAMPING        = 0.62;  // velocity damping per tick
const ALPHA_DECAY    = 0.025; // cooling rate per frame
const ALPHA_MIN      = 0.001; // stop threshold
const BH_THETA       = 0.75;  // Barnes-Hut threshold
const NODE_RADIUS    = 24;    // default collision radius

// Fixed X column offsets (relative to cx) for each known namespace.
// Gives each namespace a dedicated horizontal lane so zone boxes never overlap.
// kube-system sits at centre (below the CP), app namespaces spread right, infra left.
const NS_X_TARGETS = {
  'kube-system':     0,
  'monitoring':   -520,
  'default':       420,
  'redpanda-system': 820,
  'redpanda':     1220,
};

// Hierarchical layout ranking
const KIND_RANKS = {
  'ControlPlaneComponent': 0,
  'Ingress': 1,
  'Service': 2,
  'CustomResource': 2, // CRD instances sit above the workloads they drive
  'Deployment': 3,
  'StatefulSet': 3,
  'DaemonSet': 3,
  'CronJob': 3,
  'Job': 3,
  'ReplicaSet': 4,
  'Pod': 5,
  'PersistentVolumeClaim': 6,
  'ConfigMap': 6,
  'Secret': 6,
  'PersistentVolume': 7,
};
const RANK_SPACING  = 210; // pixels between layers
const RANK_STRENGTH = 0.07; // pull towards target Y

// Fixed slot positions for known control plane components (offsets from CP center)
// Layout: scheduler and controller-manager flank the apiserver hub; etcd sits to its right
const CP_SLOTS = {
  'kube-apiserver':           { dx:    0, dy:   0 },
  'etcd':                     { dx:  230, dy:   0 },
  'kube-scheduler':           { dx: -230, dy: -90 },
  'kube-controller-manager':  { dx: -230, dy:  90 },
  'cloud-controller-manager': { dx:  230, dy:  90 },
};
const CP_SLOT_STRENGTH = 0.18; // strong pull — settles to clean diagram layout

export class ForceSimulation {
  constructor() {
    this._particles = new Map(); // id → {x,y,vx,vy,fx?,fy?,ns,kind,r}
    this._links = [];            // [{source,target}]
    this._alpha = 0;
    this._raf = null;
    this._onTick = null;
    this._cx = 0;
    this._cy = 0;
  }

  setCenter(cx, cy) { this._cx = cx; this._cy = cy; }

  onTick(cb) { this._onTick = cb; }

  // Load all nodes+links at once (replaces existing)
  load(nodes, edges) {
    const existing = this._particles;
    this._particles = new Map();
    for (const n of nodes) {
      const old = existing.get(n.id);
      const name = n.metadata?.name || '';
      if (old) {
        // keep existing position if we already have it
        this._particles.set(n.id, { ...old, ns: n.metadata?.namespace || '', kind: n.kind, name, r: NODE_RADIUS });
      } else {
        // Place new nodes near their target column (NS) + target row (rank)
        let startX, startY;
        if (n.kind === 'ControlPlaneComponent' && CP_SLOTS[name]) {
          const cpCY = this._cy + (0 - 3.5) * RANK_SPACING;
          startX = this._cx + CP_SLOTS[name].dx;
          startY = cpCY     + CP_SLOTS[name].dy;
        } else {
          const ns = n.metadata?.namespace || '';
          const rank = KIND_RANKS[n.kind] ?? 3;
          startX = this._nsTargetX(ns) + (Math.random() - 0.5) * 120;
          startY = this._cy + (rank - 3.5) * RANK_SPACING + (Math.random() - 0.5) * 80;
        }
        this._particles.set(n.id, {
          x: startX, y: startY,
          vx: 0, vy: 0,
          ns: n.metadata?.namespace || '',
          kind: n.kind,
          name,
          r: NODE_RADIUS,
        });
      }
    }
    this._links = edges
      .filter(e => this._particles.has(e.source) && this._particles.has(e.target))
      .map(e => ({ source: e.source, target: e.target }));
  }

  addNode(id, namespace, kind, x, y) {
    if (!this._particles.has(id)) {
      this._particles.set(id, {
        x: x ?? this._cx + (Math.random() - 0.5) * 200,
        y: y ?? this._cy + (Math.random() - 0.5) * 200,
        vx: 0, vy: 0,
        ns: namespace || '',  // addNode callers pass ns explicitly
        kind: kind || '',
        r: NODE_RADIUS,
      });
    }
  }

  removeNode(id) { this._particles.delete(id); }

  addLink(sourceID, targetID) {
    if (this._particles.has(sourceID) && this._particles.has(targetID)) {
      this._links.push({ source: sourceID, target: targetID });
    }
  }

  removeLinks(nodeID) {
    this._links = this._links.filter(l => l.source !== nodeID && l.target !== nodeID);
  }

  pinNode(id, x, y)   { const p = this._particles.get(id); if (p) { p.fx = x; p.fy = y; } }
  unpinNode(id)        { const p = this._particles.get(id); if (p) { delete p.fx; delete p.fy; } }

  reheat(alpha = 0.6) { this._alpha = alpha; this._startLoop(); }

  getPositions() {
    const pos = {};
    for (const [id, p] of this._particles) pos[id] = { x: p.x, y: p.y };
    return pos;
  }

  // --- private ---

  _startLoop() {
    if (this._raf !== null) return;
    const loop = () => {
      if (this._alpha < ALPHA_MIN) { this._raf = null; return; }
      this._tick();
      this._alpha *= (1 - ALPHA_DECAY);
      if (this._onTick) this._onTick(this.getPositions());
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _tick() {
    const particles = [...this._particles.values()];
    const n = particles.length;
    if (n === 0) return;

    // Reset acceleration
    for (const p of particles) { p.ax = 0; p.ay = 0; }

    // 1. Center-of-mass correction — Y axis only (namespace columns handle X)
    let sumY = 0;
    for (const p of particles) { sumY += p.y; }
    const shiftY = (this._cy - sumY / n) * CENTER_SHIFT;
    for (const p of particles) {
      if (p.fx === undefined) { p.y += shiftY; }
    }

    // 2. Charge repulsion (Barnes-Hut if n > 50)
    if (n <= 50) {
      this._repulsionDirect(particles);
    } else {
      this._repulsionBH(particles);
    }

    // 3. Link springs
    for (const link of this._links) {
      const a = this._particles.get(link.source);
      const b = this._particles.get(link.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = SPRING_K * (dist - SPRING_REST) * this._alpha;
      const fx = force * dx / dist;
      const fy = force * dy / dist;
      if (a.fx === undefined) { a.ax += fx; a.ay += fy; }
      if (b.fx === undefined) { b.ax -= fx; b.ay -= fy; }
    }

    // 4. Namespace column force — pulls each node toward its namespace's fixed X lane
    for (const p of particles) {
      if (p.fx !== undefined) continue;
      if (p.kind === 'ControlPlaneComponent') continue; // CP uses slot force
      const targetX = this._nsTargetX(p.ns);
      p.ax += (targetX - p.x) * NS_COLUMN_STR * this._alpha;
    }

    // 4.5 Hierarchical layer ranking (Y-axis pull based on kind)
    for (const p of particles) {
      if (p.fx !== undefined) continue;
      if (p.kind === 'ControlPlaneComponent') continue; // handled by CP slot force below
      const rank = KIND_RANKS[p.kind];
      if (rank !== undefined) {
        // Shift base rank offset to center the whole graph around this._cy
        const targetY = this._cy + (rank - 3.5) * RANK_SPACING;
        p.ay += (targetY - p.y) * RANK_STRENGTH * this._alpha;
      }
    }

    // 4.6 Control plane slot force — pulls known CP components to fixed diagram positions
    {
      const cpCY = this._cy + (0 - 3.5) * RANK_SPACING;
      for (const p of particles) {
        if (p.fx !== undefined) continue;
        if (p.kind !== 'ControlPlaneComponent') continue;
        const slot = CP_SLOTS[p.name];
        if (!slot) {
          // Unknown CP component: fall back to rank Y, center X
          const targetY = cpCY;
          p.ay += (targetY - p.y) * RANK_STRENGTH * this._alpha;
          continue;
        }
        const targetX = this._cx + slot.dx;
        const targetY = cpCY     + slot.dy;
        p.ax += (targetX - p.x) * CP_SLOT_STRENGTH * this._alpha;
        p.ay += (targetY - p.y) * CP_SLOT_STRENGTH * this._alpha;
      }
    }

    // 5. Integrate + collision
    for (const p of particles) {
      if (p.fx !== undefined) { p.x = p.fx; p.y = p.fy; p.vx = 0; p.vy = 0; continue; }
      p.vx = (p.vx + p.ax) * DAMPING;
      p.vy = (p.vy + p.ay) * DAMPING;
      p.x += p.vx;
      p.y += p.vy;
    }

    // Simple collision repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = particles[i], b = particles[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const minDist = a.r + b.r + COLLISION_PAD;
        if (dist < minDist) {
          const overlap = (minDist - dist) / dist * 0.5;
          if (a.fx === undefined) { a.x -= dx * overlap; a.y -= dy * overlap; }
          if (b.fx === undefined) { b.x += dx * overlap; b.y += dy * overlap; }
        }
      }
    }
  }

  _repulsionDirect(particles) {
    const n = particles.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = particles[i], b = particles[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy + 1;
        const dist  = Math.sqrt(dist2);
        const force = REPULSION / dist2 * this._alpha;
        const fx = force * dx / dist;
        const fy = force * dy / dist;
        if (a.fx === undefined) { a.ax -= fx; a.ay -= fy; }
        if (b.fx === undefined) { b.ax += fx; b.ay += fy; }
      }
    }
  }

  _repulsionBH(particles) {
    const tree = buildQuadtree(particles);
    for (const p of particles) {
      if (p.fx !== undefined) continue;
      applyBHRepulsion(p, tree, BH_THETA, REPULSION * this._alpha);
    }
  }

  // Returns the absolute X target for a namespace.
  // Known namespaces use the fixed table; unknown namespaces get a consistent
  // hash-derived position so they don't collide with known ones.
  _nsTargetX(ns) {
    if (!ns) return this._cx;
    if (NS_X_TARGETS[ns] !== undefined) return this._cx + NS_X_TARGETS[ns];
    // Unknown namespace: stable hash → position in gaps between known columns
    let h = 0;
    for (const c of ns) h = (h * 31 + c.charCodeAt(0)) & 0xffffff;
    return this._cx + ((h % 1200) - 600);
  }
}

// --- Barnes-Hut quadtree ---

function buildQuadtree(particles) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of particles) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 + 1;

  const root = { cx, cy, half, mass: 0, comx: 0, comy: 0, children: null, particle: null };
  for (const p of particles) insertBH(root, p);
  computeMass(root);
  return root;
}

function insertBH(node, p) {
  if (node.particle === null && node.children === null) {
    node.particle = p;
    return;
  }
  if (node.children === null) {
    // Split
    const { cx, cy, half } = node;
    const h = half / 2;
    node.children = [
      { cx: cx - h, cy: cy - h, half: h, mass: 0, comx: 0, comy: 0, children: null, particle: null },
      { cx: cx + h, cy: cy - h, half: h, mass: 0, comx: 0, comy: 0, children: null, particle: null },
      { cx: cx - h, cy: cy + h, half: h, mass: 0, comx: 0, comy: 0, children: null, particle: null },
      { cx: cx + h, cy: cy + h, half: h, mass: 0, comx: 0, comy: 0, children: null, particle: null },
    ];
    insertBH(quadrant(node.children, node.cx, node.cy, node.particle), node.particle);
    node.particle = null;
  }
  insertBH(quadrant(node.children, node.cx, node.cy, p), p);
}

function quadrant(children, cx, cy, p) {
  return children[(p.x < cx ? 0 : 1) + (p.y < cy ? 0 : 2)];
}

function computeMass(node) {
  if (node.particle) { node.mass = 1; node.comx = node.particle.x; node.comy = node.particle.y; return; }
  if (!node.children) return;
  for (const c of node.children) { computeMass(c); node.mass += c.mass; node.comx += c.comx; node.comy += c.comy; }
  if (node.mass > 0) { node.comx /= node.mass; node.comy /= node.mass; }
}

function applyBHRepulsion(p, node, theta, strength) {
  if (node.mass === 0) return;
  const dx = node.comx - p.x;
  const dy = node.comy - p.y;
  const dist2 = dx * dx + dy * dy + 1;
  const dist  = Math.sqrt(dist2);

  if (node.particle === p) return; // skip self

  if (!node.children || (node.half * 2) / dist < theta) {
    // Treat as single body
    const force = strength * node.mass / dist2;
    p.ax -= force * dx / dist;
    p.ay -= force * dy / dist;
  } else {
    for (const c of node.children) applyBHRepulsion(p, c, theta, strength);
  }
}
