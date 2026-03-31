/**
 * TrafficSim — simulates external client → cluster traffic flows.
 *
 * Animates "packet" dots from an off-screen external client position through
 * the routing path (Ingress → Service → Pods or Service → Pods), coloring
 * each pulse green (success) or red (failure) based on live pod health.
 *
 * Usage:
 *   const sim = new TrafficSim(graph, store, canvasEl);
 *   sim.start('svc-nginx');      // 5 req/s default
 *   sim.start('ing-web', 10);    // 10 req/s
 *   sim.stop('svc-nginx');
 *   sim.stopAll();
 */

export { TrafficSim };

// Edge types that model traffic-relevant routing relationships
const TRAFFIC_EDGE_TYPES = new Set(['selects', 'routes', 'headless']);

class TrafficSim {
  constructor(graph, store, canvasEl) {
    this._graph  = graph;
    this._store  = store;
    this._canvas = canvasEl;
    this._active = new Map();   // nodeId → session
    this._layer  = this._initLayer();
  }

  _initLayer() {
    let layer = document.getElementById('traffic-pulse-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'traffic-pulse-layer';
      this._canvas.appendChild(layer);
    }
    return layer;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start continuous traffic to `nodeId` at `rps` requests/second. */
  start(nodeId, rps = 5) {
    this.stop(nodeId);
    const paths = this._findPaths(nodeId);
    if (!paths.length) return false;

    const session = { paths, rps, ok: 0, err: 0, intervalId: null };
    const interval = Math.max(80, Math.round(1000 / rps));
    this._tick(nodeId, session);                       // fire immediately
    session.intervalId = setInterval(() => this._tick(nodeId, session), interval);
    this._active.set(nodeId, session);
    this._updateOverlay(nodeId);
    return true;
  }

  stop(nodeId) {
    const s = this._active.get(nodeId);
    if (!s) return;
    clearInterval(s.intervalId);
    this._active.delete(nodeId);
    this._updateOverlay(null);
  }

  stopAll() {
    for (const id of [...this._active.keys()]) this.stop(id);
  }

  isActive(nodeId) { return this._active.has(nodeId); }

  setRps(nodeId, rps) {
    const s = this._active.get(nodeId);
    if (!s) return;
    const paths = s.paths;
    this.stop(nodeId);
    const newSession = { paths, rps, ok: s.ok, err: s.err, intervalId: null };
    const interval = Math.max(80, Math.round(1000 / rps));
    this._tick(nodeId, newSession);
    newSession.intervalId = setInterval(() => this._tick(nodeId, newSession), interval);
    this._active.set(nodeId, newSession);
    this._updateOverlay(nodeId);
  }

  // ── Path finding (BFS through routing edges to pods) ──────────────────────

  _findPaths(startId) {
    const result = [];
    const queue  = [[startId]];
    const seen   = new Set([startId]);

    while (queue.length > 0) {
      const path = queue.shift();
      const cur  = path[path.length - 1];
      const node = this._store.nodes.get(cur);

      if (node?.kind === 'Pod') {
        result.push(path);
        continue;
      }

      let advanced = false;
      for (const edge of this._store.edges.values()) {
        if (edge.source !== cur || seen.has(edge.target)) continue;
        const child = this._store.nodes.get(edge.target);
        if (!child) continue;
        // Follow routing edges, or any edge to a Pod
        if (!TRAFFIC_EDGE_TYPES.has(edge.type) && child.kind !== 'Pod') continue;
        seen.add(edge.target);
        queue.push([...path, edge.target]);
        advanced = true;
      }

      // No further routing found — treat this node as the endpoint
      if (!advanced && path.length >= 1) {
        result.push(path);
      }
    }

    return result.length ? result : [[startId]];
  }

  // ── Tick ──────────────────────────────────────────────────────────────────

  _tick(nodeId, session) {
    for (const path of session.paths) {
      const lastNode = this._store.nodes.get(path[path.length - 1]);
      
      // Check NetworkPolicy
      let blockedByNetpol = false;
      if (lastNode?.kind === 'Pod' && lastNode?.metadata?.namespace) {
        const ns = lastNode.metadata.namespace;
        for (const n of this._store.nodes.values()) {
          if (n.kind === 'NetworkPolicy' && n.metadata?.namespace === ns) {
            const sel = n.spec?.podSelector || {};
            let match = true;
            for (const [k,v] of Object.entries(sel)) {
              if (lastNode.metadata?.labels?.[k] !== v) { match = false; break; }
            }
            if (match) {
              // Simplified: if it selects the pod, check if it has any ingress rules allowing our traffic.
              // For simulation purposes, an empty ingress list means default deny.
              const ingress = n.spec?.ingress || [];
              if (ingress.length === 0) blockedByNetpol = true;
            }
          }
        }
      }

      const ok = !blockedByNetpol && (!lastNode || (
        lastNode.simPhase !== 'Failed' &&
        lastNode.simPhase !== 'NetworkNotReady' &&
        lastNode.simPhase !== 'CrashLoopBackOff'
      ));
      
      if (ok) session.ok++; else session.err++;
      this._animatePulse(path, ok ? 'ok' : 'err', blockedByNetpol);
    }
    this._refreshStats(nodeId, session);
  }

  // ── Animation ─────────────────────────────────────────────────────────────

  _animatePulse(path, status, blockedByNetpol = false) {
    const entryCenter = this._graph.getNodeCenter(path[0]);
    if (!entryCenter) return;

    // Build list of waypoints: external origin → each node in path
    const pts = [
      { x: Math.max(18, entryCenter.x - 100), y: entryCenter.y },
    ];
    for (const id of path) {
      const c = this._graph.getNodeCenter(id);
      if (!c) return;  // node not rendered / off-screen
      pts.push({ x: c.x, y: c.y });
    }

    if (blockedByNetpol && pts.length >= 2) {
      // Pull back the final waypoint slightly to simulate hitting a wall
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      const pdist = Math.sqrt(dx*dx + dy*dy) || 0.001;
      const pullBack = 45; // px
      if (pdist > pullBack) {
        last.x -= (dx/pdist) * pullBack;
        last.y -= (dy/pdist) * pullBack;
      }
    }

    const dot = document.createElement('div');
    dot.className = `traffic-pulse traffic-${status}`;
    this._layer.appendChild(dot);

    // Position with transform for GPU compositing
    dot.style.transform = `translate(${pts[0].x - 5}px,${pts[0].y - 5}px)`;

    const SPEED = 260; // px/second
    let seg = 0, dist = 0, lastTs = null;

    const len = (i) => {
      const dx = pts[i+1].x - pts[i].x, dy = pts[i+1].y - pts[i].y;
      return Math.sqrt(dx*dx + dy*dy) || 0.001;
    };

    const frame = (ts) => {
      if (lastTs === null) { lastTs = ts; requestAnimationFrame(frame); return; }
      dist += ((ts - lastTs) / 1000) * SPEED;
      lastTs = ts;

      // Advance segments
      while (seg < pts.length - 1 && dist >= len(seg)) {
        dist -= len(seg);
        seg++;
      }

      if (seg >= pts.length - 1) {
        dot.classList.add('traffic-land');
        setTimeout(() => dot.remove(), 380);
        return;
      }

      const t  = dist / len(seg);
      const p0 = pts[seg], p1 = pts[seg + 1];
      const x  = p0.x + (p1.x - p0.x) * t;
      const y  = p0.y + (p1.y - p0.y) * t;
      dot.style.transform = `translate(${x - 5}px,${y - 5}px)`;
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  }

  // ── Stats overlay ─────────────────────────────────────────────────────────

  _updateOverlay(activeId) {
    const overlay = document.getElementById('traffic-overlay');
    if (!overlay) return;
    overlay.style.display = this._active.size > 0 ? '' : 'none';
  }

  _refreshStats(nodeId, session) {
    const node  = this._store.nodes.get(nodeId);
    const name  = node?.name || node?.metadata?.name || nodeId;
    const total = session.ok + session.err;
    const pct   = total > 0 ? ((session.err / total) * 100).toFixed(1) : '0.0';

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('traffic-title',  `↑ ${name}`);
    set('ts-ok',          session.ok);
    set('ts-err',         session.err);
    set('ts-total',       total);
    set('ts-errrate',     pct + '%');

    const errEl  = document.getElementById('ts-err');
    const rateEl = document.getElementById('ts-errrate');
    if (errEl)  errEl.style.color  = session.err > 0 ? 'var(--danger)' : 'var(--success)';
    if (rateEl) rateEl.style.color = parseFloat(pct) > 20 ? 'var(--danger)'
                                   : parseFloat(pct) > 0  ? 'var(--warning)' : 'var(--success)';

    // Update hop breakdown (render once — paths don't change during a session)
    if (!session._hopHtml) {
      session._hopHtml = this._buildHopHtml(session.paths[0] || []);
    }
    const pathEl = document.getElementById('traffic-path');
    if (pathEl) pathEl.innerHTML = session._hopHtml;
  }

  // Build an HTML hop-by-hop breakdown for the representative path.
  _buildHopHtml(path) {
    if (!path.length) return '';

    // Detect kube-proxy and CoreDNS in the store for annotation
    let hasKubeProxy = false;
    let hasDNS = false;
    for (const n of this._store.nodes.values()) {
      const nname = n.metadata?.name || n.name || '';
      if (n.kind === 'DaemonSet' && nname === 'kube-proxy') hasKubeProxy = true;
      if ((n.kind === 'Deployment' || n.kind === 'Pod') && nname === 'coredns') hasDNS = true;
    }

    const lines = [];

    // DNS note when traffic starts at a Service (client uses DNS to resolve ClusterIP)
    const firstNode = this._store.nodes.get(path[0]);
    if (hasDNS && firstNode?.kind === 'Service') {
      lines.push('<span class="hop hop-dns">DNS  CoreDNS resolves name → ClusterIP</span>');
    }

    for (let i = 0; i < path.length; i++) {
      const n = this._store.nodes.get(path[i]);
      if (!n) continue;
      const nname = n.metadata?.name || n.name || path[i];
      const kind  = n.kind;
      const arrow = i === 0 ? '▶' : '→';
      const cls   = `hop hop-${kind.toLowerCase().replace(/[^a-z]/g, '')}`;
      lines.push(`<span class="${cls}">${arrow} <em>${kind}</em> ${nname}</span>`);

      // Insert kube-proxy DNAT annotation after Service → Pod transition
      if (hasKubeProxy && kind === 'Service' && i < path.length - 1) {
        lines.push('<span class="hop hop-kubeproxy">  ↳ kube-proxy: DNAT ClusterIP → Pod IP</span>');
      }
    }

    return lines.join('\n');
  }
}
