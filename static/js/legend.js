// legend.js — builds the interactive legend panel in the sidebar

const NS_SVG = 'http://www.w3.org/2000/svg';

const LEGEND_NODES = [
  { kind: 'ControlPlaneComponent', label: 'Control Plane Component', shape: 'octagon' },
  { kind: 'CustomResource',        label: 'Custom Resource (CRD)',   shape: 'star4' },
  { kind: 'Deployment',            label: 'Deployment',              shape: 'hexagon' },
  { kind: 'StatefulSet',           label: 'StatefulSet',             shape: 'hexagon30' },
  { kind: 'DaemonSet',             label: 'DaemonSet',               shape: 'roundedRect' },
  { kind: 'ReplicaSet',            label: 'ReplicaSet',              shape: 'pentagon' },
  { kind: 'Pod',                   label: 'Pod',                     shape: 'circle' },
  { kind: 'Service',               label: 'Service',                 shape: 'diamond' },
  { kind: 'Ingress',               label: 'Ingress',                 shape: 'chevron' },
  { kind: 'ConfigMap',             label: 'ConfigMap',               shape: 'square' },
  { kind: 'Secret',                label: 'Secret',                  shape: 'squareRounded' },
  { kind: 'PersistentVolumeClaim', label: 'PVC',                     shape: 'cylSmall' },
  { kind: 'PersistentVolume',      label: 'PersistentVolume',        shape: 'cylLarge' },
  { kind: 'HorizontalPodAutoscaler', label: 'HPA',                   shape: 'triangle' },
  { kind: 'CronJob',               label: 'CronJob',                 shape: 'roundedRectSmall' },
  { kind: 'Job',                   label: 'Job',                     shape: 'squarePlain' },
];

// Edge types ordered from most architecturally important to least
const LEGEND_EDGES = [
  { type: 'stores',   label: 'stores',   desc: 'API server persists all state to etcd',              dash: null },
  { type: 'watches',  label: 'watches',  desc: 'Informer/ListWatch connection to kube-apiserver',    dash: null },
  { type: 'owns',     label: 'owns',     desc: 'Parent creates and manages this resource',            dash: null },
  { type: 'selects',  label: 'selects',  desc: 'Service routes traffic to Pods via label selector',  dash: '5,3' },
  { type: 'mounts',   label: 'mounts',   desc: 'Pod uses this as a volume or env var',               dash: '3,3' },
  { type: 'routes',   label: 'routes',   desc: 'Ingress forwards HTTP/S traffic to this Service',    dash: null },
  { type: 'scales',   label: 'scales',   desc: 'HPA adjusts the replica count of this workload',     dash: '6,3' },
  { type: 'bound',    label: 'bound',    desc: 'PVC is bound to this PersistentVolume',              dash: null },
  { type: 'headless', label: 'headless', desc: 'StatefulSet uses this Service for stable Pod DNS',   dash: '2,4' },
];

const EDGE_COLORS = {
  owns: '#4a5a7a', selects: '#7c4dff', mounts: '#26c6da',
  bound: '#a1887f', routes: '#ff7043', scales: '#f06292',
  headless: '#3d5afe', watches: '#26a69a', stores: '#ef5350',
};

export function buildLegend(containerEl) {
  containerEl.innerHTML = '';

  // ── Resources ────────────────────────────────────────────────
  containerEl.appendChild(groupTitle('Resources'));

  for (const item of LEGEND_NODES) {
    const row = div('legend-row');

    const svg = svgEl('svg');
    svg.setAttribute('viewBox', '-18 -18 36 36');
    svg.setAttribute('width', '28');
    svg.setAttribute('height', '28');
    svg.setAttribute('class', `legend-shape-icon node-${item.kind}`);

    const shape = buildShape(item.shape);
    shape.classList.add('node-shape');
    svg.appendChild(shape);
    row.appendChild(svg);

    const lbl = span('legend-item-label', item.label);
    row.appendChild(lbl);
    containerEl.appendChild(row);
  }

  // ── Relationships ─────────────────────────────────────────────
  const edgeTitle = groupTitle('Relationships');
  edgeTitle.style.marginTop = '12px';
  containerEl.appendChild(edgeTitle);

  for (const item of LEGEND_EDGES) {
    const row = div('legend-row');

    // Colored line swatch
    const swatchSvg = svgEl('svg');
    swatchSvg.setAttribute('viewBox', '0 0 44 10');
    swatchSvg.setAttribute('width', '44');
    swatchSvg.setAttribute('height', '10');
    swatchSvg.setAttribute('class', 'legend-edge-swatch');

    const line = document.createElementNS(NS_SVG, 'line');
    line.setAttribute('x1', '2');  line.setAttribute('y1', '5');
    line.setAttribute('x2', '42'); line.setAttribute('y2', '5');
    line.setAttribute('stroke', EDGE_COLORS[item.type] || '#888');
    line.setAttribute('stroke-width', '2');
    if (item.dash) line.setAttribute('stroke-dasharray', item.dash);
    swatchSvg.appendChild(line);
    row.appendChild(swatchSvg);

    // Label + description stacked
    const textWrap = div('legend-edge-text');
    textWrap.appendChild(span('legend-item-label', item.label));
    textWrap.appendChild(span('legend-edge-desc', item.desc));
    row.appendChild(textWrap);
    containerEl.appendChild(row);
  }
}

// ── Shape builders (mirrors graph.js kindShape) ───────────────

function buildShape(name) {
  const r = 13;
  switch (name) {
    case 'star4': {
      const inner = r * 0.38;
      const d = `M0,${-r} L${inner},${-inner} L${r},0 L${inner},${inner} L0,${r} L${-inner},${inner} L${-r},0 L${-inner},${-inner} Z`;
      return sel('path', { d });
    }
    case 'octagon': {
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const a = (i * 45 + 22.5) * Math.PI / 180;
        pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
      }
      return poly(pts.join(' '));
    }
    case 'hexagon': {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = i * 60 * Math.PI / 180;
        pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
      }
      return poly(pts.join(' '));
    }
    case 'hexagon30': {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = (i * 60 + 30) * Math.PI / 180;
        pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
      }
      return poly(pts.join(' '));
    }
    case 'pentagon': {
      const pts = [];
      for (let i = 0; i < 5; i++) {
        const a = (i * 72 - 90) * Math.PI / 180;
        pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
      }
      return poly(pts.join(' '));
    }
    case 'circle':
      return sel('circle', { cx: 0, cy: 0, r });
    case 'diamond': {
      const d = r * 1.2;
      return poly(`0,${-d} ${d},0 0,${d} ${-d},0`);
    }
    case 'chevron':
      return sel('path', { d: `M${-r},${-r*0.7} L${r*0.5},0 L${-r},${r*0.7} L${-r*0.4},0 Z` });
    case 'square':
    case 'squarePlain': {
      const s = r * 1.3;
      return sel('rect', { x: -s, y: -s, width: s*2, height: s*2 });
    }
    case 'squareRounded': {
      const s = r * 1.3;
      return sel('rect', { x: -s, y: -s, width: s*2, height: s*2, rx: 5 });
    }
    case 'roundedRect': {
      const w = r * 1.6, h = r * 1.1;
      return sel('rect', { x: -w, y: -h, width: w*2, height: h*2, rx: 7 });
    }
    case 'roundedRectSmall': {
      const w = r * 1.4, h = r * 0.9;
      return sel('rect', { x: -w, y: -h, width: w*2, height: h*2, rx: 6 });
    }
    case 'triangle': {
      const h = r * 1.4;
      return poly(`0,${-h} ${r*1.1},${h*0.6} ${-r*1.1},${h*0.6}`);
    }
    case 'cylSmall': {
      const w = r * 1.1, h = r * 1.3, ry = h * 0.18;
      const g = document.createElementNS(NS_SVG, 'g');
      g.appendChild(sel('rect', { x: -w, y: -h/2 + ry, width: w*2, height: h - ry }));
      g.appendChild(sel('ellipse', { cx: 0, cy: -h/2 + ry, rx: w, ry }));
      return g;
    }
    case 'cylLarge': {
      const w = r * 1.35, h = r * 1.6, ry = h * 0.18;
      const g = document.createElementNS(NS_SVG, 'g');
      g.appendChild(sel('rect', { x: -w, y: -h/2 + ry, width: w*2, height: h - ry }));
      g.appendChild(sel('ellipse', { cx: 0, cy: -h/2 + ry, rx: w, ry }));
      return g;
    }
    default:
      return sel('circle', { cx: 0, cy: 0, r });
  }
}

// ── DOM helpers ───────────────────────────────────────────────

function svgEl(tag) { return document.createElementNS(NS_SVG, tag); }
function sel(tag, attrs = {}) {
  const e = document.createElementNS(NS_SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function poly(points) { return sel('polygon', { points }); }
function div(cls) { const e = document.createElement('div'); e.className = cls; return e; }
function span(cls, text) { const e = document.createElement('span'); e.className = cls; e.textContent = text; return e; }
function groupTitle(text) {
  const e = document.createElement('div');
  e.className = 'legend-group-title';
  e.textContent = text;
  return e;
}
