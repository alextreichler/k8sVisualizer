export function animateHeartbeat(graph, sourceId, targetId, color = '#4caf82') {
  const source = graph.getNodeCenter(sourceId);
  const target = graph.getNodeCenter(targetId);
  if (!source || !target) return;

  let layer = document.getElementById('traffic-pulse-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'traffic-pulse-layer';
    document.getElementById('canvas').appendChild(layer);
  }

  const dot = document.createElement('div');
  dot.style.position = 'absolute';
  dot.style.left = '0';
  dot.style.top = '0';
  dot.style.width = '6px';
  dot.style.height = '6px';
  dot.style.borderRadius = '50%';
  dot.style.backgroundColor = color;
  dot.style.boxShadow = `0 0 6px 2px ${color}80`;
  dot.style.zIndex = '999';
  dot.style.pointerEvents = 'none';
  layer.appendChild(dot);

  dot.style.transform = `translate(${source.x - 3}px,${source.y - 3}px)`;

  const SPEED = 400; // px/sec
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dist = Math.sqrt(dx*dx + dy*dy) || 0.001;
  let currentDist = 0;
  let lastTs = null;

  const frame = (ts) => {
    if (!lastTs) { lastTs = ts; requestAnimationFrame(frame); return; }
    currentDist += ((ts - lastTs) / 1000) * SPEED;
    lastTs = ts;

    if (currentDist >= dist) {
      dot.remove();
      return;
    }

    const t = currentDist / dist;
    const x = source.x + dx * t;
    const y = source.y + dy * t;
    dot.style.transform = `translate(${x - 3}px,${y - 3}px)`;
    requestAnimationFrame(frame);
  };

  requestAnimationFrame(frame);
}
