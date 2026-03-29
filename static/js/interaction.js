// interaction.js — drag nodes, zoom/pan viewport, click-to-select

export class InteractionHandler {
  constructor(svgEl, simulation, onViewChange) {
    this._svg = svgEl;
    this._sim = simulation;
    this._onViewChange = onViewChange; // (tx, ty, scale) => void
    this._tx = 0;
    this._ty = 0;
    this._scale = 1;
    this._draggingNode = null;
    this._dragStart = null;
    this._panning = false;
    this._panStart = null;
    this._onNodeClick = null;
    this._bind();
  }

  onNodeClick(cb) { this._onNodeClick = cb; }

  setTransform(tx, ty, scale) {
    this._tx = tx; this._ty = ty; this._scale = scale;
    this._onViewChange(tx, ty, scale);
  }

  getTransform() { return { tx: this._tx, ty: this._ty, scale: this._scale }; }

  zoomIn()    { this._zoomAt(this._svgCenter(), 1.2); }
  zoomOut()   { this._zoomAt(this._svgCenter(), 1/1.2); }
  resetZoom() { this.setTransform(0, 0, 1); }

  zoomToFit(positions) {
    const ids = Object.keys(positions);
    if (ids.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const { x, y } = positions[id];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const bounds = this._svg.getBoundingClientRect();
    const W = bounds.width, H = bounds.height;
    const graphW = maxX - minX + 80;
    const graphH = maxY - minY + 80;
    const scale = Math.min(W / graphW, H / graphH, 2) * 0.9;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.setTransform(W / 2 - cx * scale, H / 2 - cy * scale, scale);
  }

  _bind() {
    const svg = this._svg;

    // Wheel → zoom
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      this._zoomAt({ x: mx, y: my }, factor);
    }, { passive: false });

    // Pointer events for drag + pan
    svg.addEventListener('pointerdown', (e) => {
      const nodeEl = e.target.closest('.node');
      if (nodeEl) {
        // Drag node
        const id = nodeEl._nodeID;
        if (!id) return;
        this._draggingNode = id;
        this._dragStart = { x: e.clientX, y: e.clientY };
        const svgPos = this._toSVGCoords(e);
        this._sim.pinNode(id, svgPos.x, svgPos.y);
        svg.setPointerCapture(e.pointerId);
        e.stopPropagation();
      } else if (e.target === svg || e.target.id === 'viewport' ||
                 e.target.closest('#edges-layer') || e.target.closest('#nodes-layer')) {
        // Pan background
        this._panning = true;
        this._panStart = { x: e.clientX - this._tx, y: e.clientY - this._ty };
        svg.setPointerCapture(e.pointerId);
      }
    });

    svg.addEventListener('pointermove', (e) => {
      if (this._draggingNode) {
        const svgPos = this._toSVGCoords(e);
        this._sim.pinNode(this._draggingNode, svgPos.x, svgPos.y);
        this._sim.reheat(0.1);
      } else if (this._panning && this._panStart) {
        this._tx = e.clientX - this._panStart.x;
        this._ty = e.clientY - this._panStart.y;
        this._onViewChange(this._tx, this._ty, this._scale);
      }
    });

    svg.addEventListener('pointerup', (e) => {
      if (this._draggingNode) {
        this._sim.unpinNode(this._draggingNode);
        // Detect click: pointer barely moved
        if (this._dragStart && this._onNodeClick) {
          const dx = Math.abs(e.clientX - this._dragStart.x);
          const dy = Math.abs(e.clientY - this._dragStart.y);
          if (dx < 5 && dy < 5) this._onNodeClick(this._draggingNode);
        }
        this._draggingNode = null;
        this._dragStart = null;
      }
      this._panning = false;
      this._panStart = null;
    });
  }

  _toSVGCoords(e) {
    const rect = this._svg.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return {
      x: (cx - this._tx) / this._scale,
      y: (cy - this._ty) / this._scale,
    };
  }

  _svgCenter() {
    const rect = this._svg.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  }

  _zoomAt(point, factor) {
    const newScale = Math.max(0.1, Math.min(5, this._scale * factor));
    this._tx = point.x - (point.x - this._tx) * (newScale / this._scale);
    this._ty = point.y - (point.y - this._ty) * (newScale / this._scale);
    this._scale = newScale;
    this._onViewChange(this._tx, this._ty, this._scale);
  }
}
