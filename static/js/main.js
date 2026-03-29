// main.js — initialises and wires all modules

import { ClientStore } from './store.js';
import { SSEClient }   from './sse.js';
import { SVGGraph }    from './graph.js';
import { StaticLayout } from './layout.js';
import { InteractionHandler } from './interaction.js';
import { DetailPanel } from './panel.js';
import { Controls }    from './controls.js';
import { buildLegend } from './legend.js';
import { api }         from './api.js';
import { Terminal }    from './terminal.js';
import { TrafficSim }  from './traffic.js';

const svg    = document.getElementById('graph-svg');
const canvas = document.getElementById('canvas');

// ---- Create modules ----
const store = new ClientStore();
const graph = new SVGGraph(svg);
const sim   = new StaticLayout();
const panel = new DetailPanel({
  titleEl:   document.getElementById('detail-title'),
  contentEl: document.getElementById('detail-content'),
  emptyEl:   document.getElementById('detail-panel-empty'),
  store:     store,
});

const interaction = new InteractionHandler(svg, sim, (tx, ty, scale) => {
  graph.setViewTransform(tx, ty, scale);
});

const controls = new Controls({ store, graph, simulation: sim, interaction });

// Wire namespace zone drag → layout offsets
graph.onNsOffsetChange((ns, dx, dy) => sim.setNsOffset(ns, dx, dy));

// Wire Ingress traffic simulation
panel.onSimulateTraffic((ingressID) => graph.animateTrafficFrom(ingressID));

// Wire Edit button → resource editor modal
panel.onEdit((node) => controls.openEditModal(node));

// ---- Set simulation center ----
function updateCenter() {
  const r = canvas.getBoundingClientRect();
  sim.setCenter(r.width / 2, r.height / 2);
}
updateCenter();
window.addEventListener('resize', updateCenter);

// ---- Force simulation → graph positions ----
sim.onTick((positions) => {
  graph.applyPositions(positions);
});

// ---- Store → graph rendering ----
store.subscribe((type, data) => {
  const nodes = store.visibleNodes();
  const edges = store.visibleEdges();

  if (type === 'snapshot') {
    // Full reload: rebuild simulation
    sim.load(nodes, edges);
    graph.render(nodes, edges);
    // Positions are computed instantly — fit immediately
    interaction.zoomToFit(sim.getPositions());
    return;
  }

  if (type === 'node') {
    // Incremental node change: update graph, patch simulation
    graph.render(nodes, edges);
    sim.load(nodes, edges);
    sim.reheat(0.3);
    return;
  }

  if (type === 'edge') {
    graph.render(nodes, edges);
    sim.load(nodes, edges);
    sim.reheat(0.2);
    return;
  }

  if (type === 'selection') {
    if (store.selectedNodeID) {
      graph.markSelected(store.selectedNodeID, true);
    } else {
      // Deselect all
      for (const n of store.nodes.values()) graph.markSelected(n.id, false);
      panel.hide();
    }
    return;
  }
});

// ---- Graph → selection → panel ----
interaction.onNodeClick((id) => {
  const prev = store.selectedNodeID;
  if (prev) graph.markSelected(prev, false);

  if (prev === id) {
    store.deselect();
    return;
  }

  store.select(id);
  graph.markSelected(id, true);
  const node = store.nodes.get(id);
  if (node) {
    panel.show(node);
    // Auto-expand the panel if it's hidden
    if (typeof setPanelVisible === 'function') setPanelVisible(true);
  }
});

// Update panel when selected node is mutated
store.subscribe((type, data) => {
  if (type === 'node' && data && store.selectedNodeID === data.id) {
    panel.update(data);
  }
});

// ---- Cluster-ready gating ----
// Scenarios and guides require a bootstrapped cluster (control plane present).
const GATED_SCENARIO_BTNS = [
  'btn-scenario-redpanda',
  'btn-scenario-argocd',
  'btn-scenario-rbac',
  'btn-scenario-hpa',
  'btn-scenario-rolling',
  'btn-guide-certmanager',
  'btn-guide-redpanda',
];
const CLUSTER_READY_HINT = 'Bootstrap a cluster first (sidebar → Bootstrap Cluster)';

function isClusterReady() {
  for (const n of store.nodes.values()) {
    if (n.kind === 'ControlPlaneComponent') return true;
  }
  return false;
}

function updateScenarioGating() {
  const ready = isClusterReady();
  for (const id of GATED_SCENARIO_BTNS) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    // Only gate if button isn't mid-run (disabled by its own click handler)
    if (!ready) {
      btn.disabled = true;
      btn.title = CLUSTER_READY_HINT;
      btn.style.opacity = '0.45';
    } else {
      // Re-enable only if it was gated (not mid-run — mid-run buttons have ⏳ text)
      if (btn.title === CLUSTER_READY_HINT) {
        btn.disabled = false;
        btn.title = '';
        btn.style.opacity = '';
      }
    }
  }
}

// React to node changes and snapshots
store.subscribe((type) => {
  if (type === 'snapshot' || type === 'node') updateScenarioGating();
});

// Initial state on load
updateScenarioGating();

// ---- Cluster Events drawer ----
const eventsPanel  = document.getElementById('events-panel');
const eventsTbody  = document.getElementById('events-tbody');
const eventsCount  = document.getElementById('events-count');
const eventsHeader = document.getElementById('events-header');
const eventsClear  = document.getElementById('events-clear');
let _eventsTotal   = 0;

function clusterEvent(type, objectRef, reason, message) {
  const now = new Date().toLocaleTimeString('en-US', { hour12: false });
  if (!eventsTbody) return;
  _eventsTotal++;
  if (eventsCount) eventsCount.textContent = `${_eventsTotal} event${_eventsTotal !== 1 ? 's' : ''}`;
  const tr = document.createElement('tr');
  tr.className = `type-${type.toLowerCase()}`;
  tr.innerHTML = `<td>${now}</td><td>${type}</td><td>${objectRef}</td><td>${reason}</td><td>${message}</td>`;
  eventsTbody.appendChild(tr);
  // Keep max 200 rows
  while (eventsTbody.rows.length > 200) eventsTbody.deleteRow(0);
  // Auto-scroll if near bottom
  const body = eventsTbody.closest('.events-body');
  if (body) body.scrollTop = body.scrollHeight;
  // Auto-expand on first event
  if (_eventsTotal === 1 && eventsPanel?.classList.contains('collapsed')) {
    eventsPanel.classList.remove('collapsed');
  }
}

// Translate SSE resource events into Kubernetes-style Events
function translateToK8sEvent(sseEvent) {
  const n = sseEvent.payload;
  if (!n) return;
  const name = n.metadata?.name || n.id || '';
  const ns   = n.metadata?.namespace || '';
  const kind = n.kind || '';
  const objRef = `${kind}/${name}`;

  switch (sseEvent.type) {
    case 'resource.created': {
      switch (kind) {
        case 'Pod': {
          const phase = n.simPhase || 'Pending';
          clusterEvent('Normal', objRef, 'Scheduled', `Pod assigned to node in namespace "${ns}"`);
          if (phase === 'Pending' || phase === 'Running') {
            const initCtrs = n.spec?.initContainers || [];
            const ctrs     = n.spec?.containers || [];
            for (const c of initCtrs) {
              clusterEvent('Normal', objRef, 'Pulling', `Pulling init container image "${c.image || c.name}"`);
            }
            for (const c of ctrs) {
              clusterEvent('Normal', objRef, 'Pulling', `Pulling container image "${c.image || c.name}"`);
            }
          }
          break;
        }
        case 'Deployment':
          clusterEvent('Normal', objRef, 'ScalingReplicaSet', `Scaled up ReplicaSet for ${name} to ${n.spec?.replicas ?? 1} replica(s)`);
          break;
        case 'ReplicaSet':
          clusterEvent('Normal', objRef, 'SuccessfulCreate', `Created Pod template for ReplicaSet ${name}`);
          break;
        case 'StatefulSet':
          clusterEvent('Normal', objRef, 'SuccessfulCreate', `StatefulSet created — ordered pod startup begins (pod 0 first)`);
          break;
        case 'Service': {
          const svcType = n.spec?.type || 'ClusterIP';
          if (svcType === 'NodePort') {
            const port = n.spec?.ports?.[0]?.nodePort || n.spec?.ports?.[0]?.port || '';
            clusterEvent('Normal', objRef, 'Created', `NodePort Service created — reachable from outside cluster on port ${port} of every Node`);
          } else if (svcType === 'LoadBalancer') {
            clusterEvent('Normal', objRef, 'Created', `LoadBalancer Service created — cloud provider will provision an external IP`);
          } else if (n.spec?.clusterIP === 'None') {
            clusterEvent('Normal', objRef, 'Created', `Headless Service (ClusterIP=None) — each Pod gets stable DNS: <pod>.<svc>.<ns>.svc.cluster.local`);
          } else {
            clusterEvent('Normal', objRef, 'Created', `ClusterIP Service created — stable internal IP for Pod traffic`);
          }
          break;
        }
        case 'Ingress':
          clusterEvent('Normal', objRef, 'Created', `Ingress rules applied — Ingress Controller will configure external HTTP/S routing`);
          break;
        case 'PersistentVolumeClaim':
          clusterEvent('Normal', objRef, 'ProvisioningSucceeded', `PVC created — waiting for StorageProvisioner to allocate a PersistentVolume`);
          break;
        case 'PersistentVolume':
          clusterEvent('Normal', objRef, 'ProvisioningSucceeded', `PV provisioned (${n.spec?.capacity || ''}) — available for PVC binding`);
          break;
        case 'CustomResource':
          clusterEvent('Normal', objRef, 'Sync', `CR applied — operator detected it via Informer and will reconcile into cluster resources`);
          break;
        case 'Namespace':
          clusterEvent('Normal', objRef, 'Created', `Namespace created — resources can now be scoped to "${name}"`);
          break;
      }
      break;
    }

    case 'resource.updated': {
      if (kind === 'Pod') {
        const phase = n.simPhase || '';
        switch (phase) {
          case 'Running':
            clusterEvent('Normal', objRef, 'Started', `All containers started — pod is Ready and passing readiness probes`);
            break;
          case 'Pending':
            clusterEvent('Normal', objRef, 'Scheduled', `Pod pending — waiting for PVC binding or image pull`);
            break;
          case 'ContainerCreating':
            clusterEvent('Normal', objRef, 'Pulling', `Pulling container image and setting up network namespace + volume mounts`);
            break;
          case 'Failed':
            clusterEvent('Warning', objRef, 'BackOff', `Container exited with error — CrashLoopBackOff may follow. Run: kubectl logs ${name} --previous`);
            break;
          case 'Terminating':
            clusterEvent('Normal', objRef, 'Killing', `Pod termination: SIGTERM sent → 30s grace period → SIGKILL if still running`);
            break;
          case 'CrashLoopBackOff':
            clusterEvent('Warning', objRef, 'BackOff', `CrashLoopBackOff — container keeps crashing, kubelet backing off (10s→20s→40s…). Check: kubectl logs ${name} --previous`);
            break;
          case 'ImagePullBackOff':
            clusterEvent('Warning', objRef, 'BackOff', `ImagePullBackOff — cannot pull image. Check image tag exists and registry is reachable. Check: kubectl describe pod ${name}`);
            break;
          case 'OOMKilled':
            clusterEvent('Warning', objRef, 'OOMKilling', `OOMKilled — container exceeded memory limit and was killed by kernel OOM. Increase resources.limits.memory`);
            break;
        }
      } else if (kind === 'PersistentVolumeClaim') {
        const phase = n.status?.phase || '';
        if (phase === 'Bound') {
          clusterEvent('Normal', objRef, 'Bound', `PVC successfully bound to a PersistentVolume`);
        } else if (phase === 'Pending') {
          clusterEvent('Normal', objRef, 'Released', `PVC unbound — PV status is now Released. PVC will rebind on next pod attach`);
        }
      } else if (kind === 'PersistentVolume') {
        const phase = n.status?.phase || '';
        if (phase === 'Released') {
          clusterEvent('Normal', objRef, 'Released', `PV released from its PVC. To reuse: delete PV or clear spec.claimRef`);
        }
      } else if (kind === 'Deployment' || kind === 'StatefulSet') {
        const replicas = n.spec?.replicas ?? '?';
        clusterEvent('Normal', objRef, 'ScalingReplicaSet', `Replica count updated to ${replicas}`);
      }
      break;
    }

    case 'resource.deleted': {
      const deletedKind = sseEvent.kind || kind;
      const deletedId   = (sseEvent.payload?.id || n.id || '').replace(/^[a-z]+-/, '');
      if (deletedKind === 'Pod') {
        clusterEvent('Normal', `Pod/${deletedId}`, 'Killing', `Container stopped — pod removed from cluster`);
      }
      break;
    }

    case 'edge.created': {
      const e = sseEvent.payload;
      if (e?.type === 'bound') {
        clusterEvent('Normal', `PVC`, 'VolumeBinding', `PVC bound to PV — storage is ready, pod can start`);
      }
      break;
    }
  }
}

// Wire up events panel UI
if (eventsHeader) {
  eventsHeader.addEventListener('click', (e) => {
    if (e.target.id === 'events-clear') return;
    eventsPanel?.classList.toggle('collapsed');
  });
}
if (eventsClear) {
  eventsClear.addEventListener('click', (e) => {
    e.stopPropagation();
    if (eventsTbody) eventsTbody.innerHTML = '';
    _eventsTotal = 0;
    if (eventsCount) eventsCount.textContent = '0 events';
  });
}

// ---- Sidebar reset ----
function resetSidebarUI() {
  // Clear all step logs
  for (const el of [
    document.getElementById('bootstrap-log'),
    document.getElementById('scenario-log'),
    document.getElementById('guide-log'),
    document.getElementById('chaos-log'),
  ]) {
    if (el) { el.innerHTML = ''; el.style.display = 'none'; }
  }
  _activeStepLog = 'scenario';

  // Bootstrap buttons
  const bootstrapResets = [
    ['btn-bootstrap-controlplane', '⓪ Initialize Control Plane'],
    ['btn-bootstrap-coredns',      '① Install CoreDNS'],
    ['btn-bootstrap-cni',          '② CNI'],
    ['btn-bootstrap-kubeproxy',    '③ Install kube-proxy'],
    ['btn-bootstrap-nodelocaldns', '④ NodeLocal DNSCache (optional)'],
    ['btn-bootstrap-managed',      '▶ Provision Managed Cluster'],
    ['btn-bootstrap-k3s',          '▶ Install k3s'],
    ['btn-bootstrap-workers',      '⑤ Join Worker Nodes'],
    ['btn-bootstrap-ha',           '▶ Bootstrap HA Cluster (3+3+3)'],
  ];
  for (const [id, label] of bootstrapResets) {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = false; btn.textContent = label; btn.style.background = ''; }
  }

  // Scenario buttons
  const scenarioResets = [
    ['btn-scenario-redpanda', '▶ Deploy Redpanda (Simulated Mock)'],
    ['btn-scenario-argocd',   '▶ Install ArgoCD (GitOps)'],
    ['btn-scenario-rbac',     '▶ RBAC Tutorial'],
    ['btn-scenario-hpa',      '▶ HPA Demo (Autoscale on CPU)'],
    ['btn-scenario-rolling',  '▶ Rolling Update'],
    ['btn-scenario-nodedrain','▶ Node Drain & Upgrade'],
  ];
  for (const [id, label] of scenarioResets) {
    const btn = document.getElementById(id);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }

  // Guide buttons
  const certBtn2  = document.getElementById('btn-guide-certmanager');
  const rpdBtn2   = document.getElementById('btn-guide-redpanda');
  if (certBtn2) { certBtn2.disabled = false; certBtn2.textContent = '① Install cert-manager';              certBtn2.style.background = ''; }
  if (rpdBtn2)  { rpdBtn2.disabled  = false; rpdBtn2.textContent  = '② Install redpanda (operator + chart)'; rpdBtn2.style.background = ''; }

  // Reset any user-dragged namespace positions
  sim.resetNsOffsets();
  graph.resetNsOffsets();

  // Re-apply cluster-ready gating (cluster is now empty after reset)
  updateScenarioGating();
}

document.getElementById('btn-reset')?.addEventListener('click', resetSidebarUI);

// ---- Bootstrap log ----
let _activeStepLog = 'scenario'; // 'scenario' | 'bootstrap'
const bootstrapLog = document.getElementById('bootstrap-log');

function appendBootstrapLine(label, step, total) {
  if (!bootstrapLog) return;
  bootstrapLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'scenario-line';
  if (label.startsWith('$')) line.classList.add('scenario-cmd');
  else if (label.includes('✓')) line.classList.add('scenario-ok');
  else if (label.startsWith('+')) line.classList.add('scenario-add');
  else line.classList.add('scenario-info');
  line.textContent = label;
  bootstrapLog.appendChild(line);
  bootstrapLog.scrollTop = bootstrapLog.scrollHeight;
}

function wireBootstrapBtn(btnId, action, readyLabel) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    bootstrapLog.style.display = 'block';
    bootstrapLog.innerHTML = '';
    _activeStepLog = 'bootstrap';
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '⏳ Running…';
    try {
      await api.bootstrap(action);
    } catch (e) {
      appendBootstrapLine('Error: ' + e.message, 1, 1);
      btn.disabled = false;
      btn.textContent = orig;
      _activeStepLog = 'scenario';
    }
    // Re-enable button after animation completes (~15s)
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = readyLabel;
      _activeStepLog = 'scenario';
    }, 15000);
  });
}

wireBootstrapBtn('btn-bootstrap-controlplane', 'controlplane', '⓪ Initialize Control Plane');
wireBootstrapBtn('btn-bootstrap-coredns',   'coredns',    '① Install CoreDNS');
wireBootstrapBtn('btn-bootstrap-kubeproxy', 'kube-proxy', '③ Install kube-proxy');

// ---- Bootstrap method selector ----
const bootstrapMethod  = document.getElementById('bootstrap-method');
const bootstrapKubeadm = document.getElementById('bootstrap-kubeadm');
const bootstrapManaged = document.getElementById('bootstrap-managed');
const bootstrapK3s     = document.getElementById('bootstrap-k3s');
const bootstrapHA      = document.getElementById('bootstrap-ha');

function showBootstrapMethod(method) {
  bootstrapKubeadm.style.display = method === 'kubeadm' ? 'flex' : 'none';
  bootstrapManaged.style.display = method === 'managed' ? 'flex' : 'none';
  bootstrapK3s.style.display     = method === 'k3s'     ? 'flex' : 'none';
  if (bootstrapHA) bootstrapHA.style.display = method === 'ha' ? 'flex' : 'none';
}
if (bootstrapMethod) {
  bootstrapMethod.addEventListener('change', () => showBootstrapMethod(bootstrapMethod.value));
  showBootstrapMethod(bootstrapMethod.value);
}

// ---- CNI button with plugin picker ----
const cniSelect      = document.getElementById('cni-select');
const btnCNI         = document.getElementById('btn-bootstrap-cni');
const btnKubeProxy   = document.getElementById('btn-bootstrap-kubeproxy');

function updateKubeProxyVisibility() {
  if (!cniSelect || !btnKubeProxy) return;
  const isCilium = cniSelect.value === 'cilium';
  btnKubeProxy.style.opacity = isCilium ? '0.4' : '1';
  btnKubeProxy.title = isCilium ? 'Not needed — Cilium replaces kube-proxy via eBPF' : '';
}
if (cniSelect) {
  cniSelect.addEventListener('change', updateKubeProxyVisibility);
  updateKubeProxyVisibility();
}

if (btnCNI) {
  btnCNI.addEventListener('click', async () => {
    const plugin = cniSelect ? cniSelect.value : 'flannel';
    if (!bootstrapLog) return;
    bootstrapLog.style.display = 'block';
    bootstrapLog.innerHTML = '';
    _activeStepLog = 'bootstrap';
    btnCNI.disabled = true;
    btnCNI.textContent = '⏳ Running…';
    try {
      await api.bootstrap('cni', { plugin });
    } catch (e) {
      appendBootstrapLine('Error: ' + e.message, 1, 1);
      btnCNI.disabled = false;
      btnCNI.textContent = '② CNI';
      _activeStepLog = 'scenario';
    }
    setTimeout(() => {
      btnCNI.disabled = false;
      btnCNI.textContent = '② CNI';
      _activeStepLog = 'scenario';
    }, 18000);
  });
}

// ---- NodeLocal DNSCache button ----
const btnNodeLocalDNS = document.getElementById('btn-bootstrap-nodelocaldns');
if (btnNodeLocalDNS) {
  btnNodeLocalDNS.addEventListener('click', async () => {
    if (!bootstrapLog) return;
    bootstrapLog.style.display = 'block';
    bootstrapLog.innerHTML = '';
    _activeStepLog = 'bootstrap';
    btnNodeLocalDNS.disabled = true;
    btnNodeLocalDNS.textContent = '⏳ Running…';
    try {
      await api.bootstrap('nodelocaldns');
    } catch (e) {
      appendBootstrapLine('Error: ' + e.message, 1, 1);
      btnNodeLocalDNS.disabled = false;
      btnNodeLocalDNS.textContent = '④ NodeLocal DNSCache (optional)';
      _activeStepLog = 'scenario';
    }
    setTimeout(() => {
      btnNodeLocalDNS.disabled = false;
      btnNodeLocalDNS.textContent = '④ NodeLocal DNSCache ✓';
      _activeStepLog = 'scenario';
    }, 12000);
  });
}

// ---- Worker nodes button ----
const btnWorkers = document.getElementById('btn-bootstrap-workers');
if (btnWorkers) {
  btnWorkers.addEventListener('click', async () => {
    if (!bootstrapLog) return;
    bootstrapLog.style.display = 'block';
    bootstrapLog.innerHTML = '';
    _activeStepLog = 'bootstrap';
    btnWorkers.disabled = true;
    btnWorkers.textContent = '⏳ Joining workers…';
    try {
      await api.bootstrap('workers');
    } catch (e) {
      appendBootstrapLine('Error: ' + e.message, 1, 1);
      btnWorkers.disabled = false;
      btnWorkers.textContent = '⑤ Join Worker Nodes';
      _activeStepLog = 'scenario';
    }
    setTimeout(() => {
      btnWorkers.disabled = false;
      btnWorkers.textContent = '⑤ Join Worker Nodes ✓';
      _activeStepLog = 'scenario';
    }, 15000);
  });
}

// ---- HA bootstrap button ----
const btnBootstrapHA = document.getElementById('btn-bootstrap-ha');
if (btnBootstrapHA) {
  btnBootstrapHA.addEventListener('click', async () => {
    if (!bootstrapLog) return;
    bootstrapLog.style.display = 'block';
    bootstrapLog.innerHTML = '';
    _activeStepLog = 'bootstrap';
    btnBootstrapHA.disabled = true;
    btnBootstrapHA.textContent = '⏳ Bootstrapping HA…';
    try {
      await api.bootstrap('ha');
    } catch (e) {
      appendBootstrapLine('Error: ' + e.message, 1, 1);
      btnBootstrapHA.disabled = false;
      btnBootstrapHA.textContent = '▶ Bootstrap HA Cluster (3+3+3)';
      _activeStepLog = 'scenario';
    }
    setTimeout(() => {
      btnBootstrapHA.disabled = false;
      btnBootstrapHA.textContent = '▶ Bootstrap HA Cluster (3+3+3)';
      _activeStepLog = 'scenario';
    }, 30000);
  });
}

// ---- Managed cluster button ----
const managedProvider = document.getElementById('managed-provider');
const btnManaged      = document.getElementById('btn-bootstrap-managed');
if (btnManaged) {
  btnManaged.addEventListener('click', async () => {
    const provider = managedProvider ? managedProvider.value : 'eks';
    if (!bootstrapLog) return;
    bootstrapLog.style.display = 'block';
    bootstrapLog.innerHTML = '';
    _activeStepLog = 'bootstrap';
    btnManaged.disabled = true;
    btnManaged.textContent = '⏳ Provisioning…';
    try {
      await api.bootstrap('managed', { provider });
    } catch (e) {
      appendBootstrapLine('Error: ' + e.message, 1, 1);
      btnManaged.disabled = false;
      btnManaged.textContent = '▶ Provision Managed Cluster';
      _activeStepLog = 'scenario';
    }
    setTimeout(() => {
      btnManaged.disabled = false;
      btnManaged.textContent = '▶ Provision Managed Cluster';
      _activeStepLog = 'scenario';
    }, 18000);
  });
}

// ---- k3s button ----
const btnK3s = document.getElementById('btn-bootstrap-k3s');
if (btnK3s) {
  btnK3s.addEventListener('click', async () => {
    if (!bootstrapLog) return;
    bootstrapLog.style.display = 'block';
    bootstrapLog.innerHTML = '';
    _activeStepLog = 'bootstrap';
    btnK3s.disabled = true;
    btnK3s.textContent = '⏳ Installing k3s…';
    try {
      await api.bootstrap('k3s');
    } catch (e) {
      appendBootstrapLine('Error: ' + e.message, 1, 1);
      btnK3s.disabled = false;
      btnK3s.textContent = '▶ Install k3s';
      _activeStepLog = 'scenario';
    }
    setTimeout(() => {
      btnK3s.disabled = false;
      btnK3s.textContent = '▶ Install k3s';
      _activeStepLog = 'scenario';
    }, 20000);
  });
}

// ---- Scenario log ----
const scenarioLog = document.getElementById('scenario-log');
const scenarioBtn = document.getElementById('btn-scenario-redpanda');

function appendScenarioLine(label, step, total) {
  if (!scenarioLog) return;
  scenarioLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'scenario-line';

  // Classify line style
  if (label.startsWith('$')) {
    line.classList.add('scenario-cmd');
  } else if (label.includes('✓')) {
    line.classList.add('scenario-ok');
  } else if (label.startsWith('+')) {
    line.classList.add('scenario-add');
  } else if (label.startsWith('  ↳') || label.startsWith('  ')) {
    line.classList.add('scenario-sub');
  } else if (label.includes('StatefulSet:')) {
    line.classList.add('scenario-info');
  } else {
    line.classList.add('scenario-info');
  }

  line.textContent = label;
  scenarioLog.appendChild(line);
  scenarioLog.scrollTop = scenarioLog.scrollHeight;

  if (step === total) {
    // Re-enable button when done
    if (scenarioBtn) { scenarioBtn.disabled = false; scenarioBtn.textContent = '▶ Deploy Redpanda (Helm + Operator)'; }
  }
}

if (scenarioBtn) {
  scenarioBtn.addEventListener('click', async () => {
    scenarioLog.style.display = 'block';
    scenarioLog.innerHTML = '';
    _activeStepLog = 'scenario';
    scenarioBtn.disabled = true;
    scenarioBtn.textContent = '⏳ Deploying…';
    try {
      const opVer = document.getElementById('redpanda-operator-version')?.value || 'direct';
      await api.runScenario('redpanda-helm', { operatorVersion: opVer });
    } catch (e) {
      appendScenarioLine('Error: ' + e.message, 1, 1);
      scenarioBtn.disabled = false;
      scenarioBtn.textContent = '▶ Deploy Redpanda (Helm + Operator)';
    }
  });
}

// ---- Generic scenario runner helper ----
function wireScenarioBtn(btnId, scenarioName, runningLabel, doneLabel, estimatedSteps) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    scenarioLog.style.display = 'block';
    scenarioLog.innerHTML = '';
    _activeStepLog = 'scenario';
    btn.disabled = true;
    btn.textContent = runningLabel;
    try {
      await api.runScenario(scenarioName);
    } catch (e) {
      appendScenarioLine('Error: ' + e.message, 1, 1);
      btn.disabled = false;
      btn.textContent = doneLabel;
      return;
    }
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = doneLabel;
      _activeStepLog = 'scenario';
    }, estimatedSteps * 600);
  });
}

wireScenarioBtn('btn-scenario-rbac',    'rbac',     '⏳ Running RBAC tutorial…', '▶ RBAC Tutorial',     22);
wireScenarioBtn('btn-scenario-hpa',     'hpa-demo', '⏳ Running HPA demo…',      '▶ HPA Demo (Autoscale on CPU)',                   24);
wireScenarioBtn('btn-scenario-nodedrain', 'node-drain', '⏳ Draining Node…', '▶ Node Drain & Upgrade', 10);

// Rolling update uses the dedicated API endpoint, not runScenario
const rollingBtn = document.getElementById('btn-scenario-rolling');
if (rollingBtn) {
  rollingBtn.addEventListener('click', async () => {
    scenarioLog.style.display = 'block';
    scenarioLog.innerHTML = '';
    _activeStepLog = 'scenario';
    rollingBtn.disabled = true;
    rollingBtn.textContent = '⏳ Rolling update…';
    try {
      await api.rollingUpdate();
    } catch (e) {
      appendScenarioLine('Error: ' + e.message, 1, 1);
      rollingBtn.disabled = false;
      rollingBtn.textContent = '▶ Rolling Update (Deployment)';
      return;
    }
    setTimeout(() => {
      rollingBtn.disabled = false;
      rollingBtn.textContent = '▶ Rolling Update (Deployment)';
      _activeStepLog = 'scenario';
    }, 20000);
  });
}

// ---- ArgoCD scenario ----
const argoCDBtn = document.getElementById('btn-scenario-argocd');
if (argoCDBtn) {
  argoCDBtn.addEventListener('click', async () => {
    scenarioLog.style.display = 'block';
    scenarioLog.innerHTML = '';
    _activeStepLog = 'scenario';
    argoCDBtn.disabled = true;
    argoCDBtn.textContent = '⏳ Installing ArgoCD…';
    try {
      await api.runScenario('argocd');
    } catch (e) {
      appendScenarioLine('Error: ' + e.message, 1, 1);
      argoCDBtn.disabled = false;
      argoCDBtn.textContent = '▶ Install ArgoCD (GitOps)';
      return;
    }
    setTimeout(() => {
      argoCDBtn.disabled = false;
      argoCDBtn.textContent = '▶ Install ArgoCD (GitOps)';
      _activeStepLog = 'scenario';
    }, 30000);
  });
}

// ---- Chaos injection buttons ----
function pickRandomRunningPod() {
  const pods = [...store.nodes.values()].filter(n => n.kind === 'Pod' && n.simPhase === 'Running');
  if (!pods.length) return null;
  return pods[Math.floor(Math.random() * pods.length)];
}

function pickRandomWorkerNode() {
  const nodes = [...store.nodes.values()].filter(n => n.kind === 'Node');
  if (!nodes.length) return null;
  return nodes[Math.floor(Math.random() * nodes.length)];
}

const chaosLog = document.getElementById('chaos-log');

function appendChaosLine(label) {
  if (!chaosLog) return;
  chaosLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'scenario-line scenario-info';
  line.textContent = label;
  chaosLog.appendChild(line);
  chaosLog.scrollTop = chaosLog.scrollHeight;
}

function wireChaosBtn(btnId, failureType, targetFn, targetName) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const target = targetFn();
    if (!target) {
      alert(`No suitable ${targetName} found. Make sure a cluster is running with at least one ${targetName}.`);
      return;
    }
    if (chaosLog) { chaosLog.style.display = 'block'; }
    appendChaosLine(`⚡ Injecting ${failureType} → ${target.metadata?.name || target.id}…`);
    try {
      await api.simulateFailure(failureType, target.id);
      appendChaosLine(`✓ ${failureType} injected into ${target.metadata?.name || target.id}`);
    } catch (e) {
      appendChaosLine(`✗ Error: ${e.message}`);
    }
  });
}

wireChaosBtn('btn-chaos-crash-loop',    'crash-loop',          pickRandomRunningPod,  'running pod');
wireChaosBtn('btn-chaos-oom',           'oom-killed',          pickRandomRunningPod,  'running pod');
wireChaosBtn('btn-chaos-image-pull',    'image-pull-backoff',  pickRandomRunningPod,  'running pod');
wireChaosBtn('btn-chaos-liveness',      'liveness-probe',      pickRandomRunningPod,  'running pod');
wireChaosBtn('btn-chaos-node-notready', 'node-not-ready',      pickRandomWorkerNode,  'node');

// ---- SSE client ----
const statusDot   = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');

const sse = new SSEClient('/api/events');
sse
  .on('_connected', () => {
    statusDot.className   = 'status-dot connected';
    statusLabel.textContent = 'live';
  })
  .on('_error', () => {
    statusDot.className   = 'status-dot error';
    statusLabel.textContent = 'reconnecting…';
  })
  .on('snapshot', (event) => {
    store.applySnapshot(event.payload);
  })
  .on('version.changed', (event) => {
    store.applyEvent(event);
  })
  .on('resource.created', (event) => { store.applyEvent(event); translateToK8sEvent(event); })
  .on('resource.updated', (event) => { store.applyEvent(event); translateToK8sEvent(event); })
  .on('resource.deleted', (event) => { store.applyEvent(event); translateToK8sEvent(event); })
  .on('edge.created',     (event) => { store.applyEvent(event); translateToK8sEvent(event); })
  .on('edge.deleted',     (event) => store.applyEvent(event))
  .on('scenario.step',    (event) => {
    const p = event.payload || {};
    if (_activeStepLog === 'bootstrap') {
      appendBootstrapLine(p.label || '', p.step || 0, p.total || 1);
    } else if (_activeStepLog === 'guide') {
      appendGuideLine(p.label || '', p.step || 0, p.total || 1);
    } else {
      appendScenarioLine(p.label || '', p.step || 0, p.total || 1);
    }
    // Feed guided mode if enabled
    if (_guidedMode) {
      queueGuidedStep(p.label || '', p.step || 0, p.total || 1);
    }
  });

sse.connect();

function pulseControlPlane(resourceId) {
  if (!resourceId) return;
  // Don't pulse for control plane components themselves or it gets too noisy
  const node = store.nodes.get(resourceId);
  if (node && node.kind === 'ControlPlaneComponent') return;

  const cpApiserverId = store.nodes.has('cp-apiserver') ? 'cp-apiserver' : (store.nodes.has('cp-managed') ? 'cp-managed' : null);
  if (cpApiserverId) {
    animateHeartbeat(graph, cpApiserverId, resourceId, 'rgba(79, 142, 247, 0.8)');
  }
}

// ---- Controls ----
await controls.init();

// ---- Terminal ----
const terminal = new Terminal({ store });
terminal.mount();

// ---- Legend overlay ----
const legendOverlayBtn   = document.getElementById('legend-overlay-btn');
const legendOverlayPanel = document.getElementById('legend-overlay-panel');
if (legendOverlayBtn && legendOverlayPanel) {
  buildLegend(legendOverlayPanel);
  legendOverlayBtn.addEventListener('click', () => {
    const open = legendOverlayPanel.classList.toggle('open');
    legendOverlayBtn.classList.toggle('active', open);
  });
}

// ---- Accordion sidebar sections ----
document.querySelectorAll('.sidebar-section.collapsible .section-toggle').forEach(h2 => {
  h2.addEventListener('click', () => {
    const section = h2.closest('.sidebar-section');
    const open = section.dataset.open === 'true';
    section.dataset.open = open ? 'false' : 'true';
  });
});

// ---- Interactive Guide ----
const btnGuideCertManager = document.getElementById('btn-guide-certmanager');
const btnGuideRedpanda    = document.getElementById('btn-guide-redpanda');
const guideLog            = document.getElementById('guide-log');

function appendGuideLine(label, step, total) {
  if (!guideLog) return;
  guideLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = 'scenario-line';
  if (label.startsWith('$'))                    line.classList.add('scenario-cmd');
  else if (label.includes('✓'))                 line.classList.add('scenario-ok');
  else if (label.startsWith('+'))               line.classList.add('scenario-add');
  else if (label.startsWith('  ↳') || label.startsWith('  ')) line.classList.add('scenario-sub');
  else                                           line.classList.add('scenario-info');
  line.textContent = label;
  guideLog.appendChild(line);
  guideLog.scrollTop = guideLog.scrollHeight;
}

function runGuideScenario(scenarioName, btn, runningLabel, doneLabel, totalSteps) {
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (guideLog) { guideLog.style.display = 'block'; guideLog.innerHTML = ''; }
    _activeStepLog = 'guide';
    btn.disabled = true;
    btn.textContent = runningLabel;
    try {
      const opts = {};
      if (scenarioName === 'redpanda-helm') {
        opts.operatorVersion = document.getElementById('redpanda-operator-version')?.value || 'direct';
      }
      await api.runScenario(scenarioName, opts);
    } catch (e) {
      appendGuideLine('Error: ' + e.message, 1, 1);
      btn.disabled = false;
      btn.textContent = btn.dataset.origLabel || doneLabel;
      _activeStepLog = 'scenario';
    }
    // Re-enable after scenario completes (estimated duration based on total steps)
    const estimatedMs = totalSteps * 600;
    setTimeout(() => {
      btn.disabled = false;
      btn.style.background = 'var(--success)';
      btn.textContent = doneLabel;
      _activeStepLog = 'scenario';
    }, estimatedMs);
  });
}

runGuideScenario('cert-manager', btnGuideCertManager,
  '⏳ Installing cert-manager…', '✓ cert-manager installed', 32);
runGuideScenario('redpanda-helm', btnGuideRedpanda,
  '⏳ Installing redpanda…', '✓ redpanda installed', 48);

// ---- Helm Apply ----
const btnHelmApply = document.getElementById('btn-helm-apply');
const helmValues = document.getElementById('helm-values');
if (btnHelmApply) {
  btnHelmApply.addEventListener('click', async () => {
    btnHelmApply.disabled = true;
    btnHelmApply.textContent = 'Rendering...';
    try {
      const res = await fetch('/api/simulate/helm-apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          releaseName: 'redpanda',
          namespace: 'redpanda',
          chartPath: 'redpanda-operator/charts/redpanda',
          valuesYaml: helmValues.value
        })
      });
      if (!res.ok) {
        const data = await res.json();
        alert('Helm apply failed: ' + (data.error || res.statusText));
      } else {
        const data = await res.json();
        console.log('Helm apply success:', data);
        store.reload();
      }
    } catch (err) {
      alert('Error applying helm chart: ' + err.message);
    } finally {
      btnHelmApply.disabled = false;
      btnHelmApply.textContent = '⎈ Apply Real Helm Chart';
    }
  });
}

// ── Traffic simulation ────────────────────────────────────────────────────

const trafficSim = new TrafficSim(graph, store, document.getElementById('canvas'));
let _trafficActiveNode = null;

panel.onSimulateTraffic((node) => {
  if (_trafficActiveNode === node.id) {
    // Toggle off if already active
    trafficSim.stop(node.id);
    _trafficActiveNode = null;
    // Reset button label
    const btn = document.getElementById('detail-traffic-btn');
    if (btn) btn.textContent = '▶ Traffic';
    return;
  }
  // Stop any previous target
  if (_trafficActiveNode) trafficSim.stop(_trafficActiveNode);

  const ok = trafficSim.start(node.id, 5);
  if (ok) {
    _trafficActiveNode = node.id;
    const btn = document.getElementById('detail-traffic-btn');
    if (btn) btn.textContent = '■ Stop Traffic';
    // Mark node as traffic-active (dashed stroke animation)
    graph.markSelected && graph._nodeEls?.get(node.id)?.classList.add('traffic-active');
  }
});

// Stop button in the overlay
document.getElementById('traffic-stop-btn')?.addEventListener('click', () => {
  if (_trafficActiveNode) {
    trafficSim.stop(_trafficActiveNode);
    const el = graph._nodeEls?.get(_trafficActiveNode);
    el?.classList.remove('traffic-active');
    _trafficActiveNode = null;
    const btn = document.getElementById('detail-traffic-btn');
    if (btn) btn.textContent = '▶ Traffic';
  }
});

// RPS slider
const trafficSlider = document.getElementById('traffic-rps-slider');
const trafficRpsVal = document.getElementById('traffic-rps-val');
trafficSlider?.addEventListener('input', () => {
  const rps = parseInt(trafficSlider.value, 10);
  if (trafficRpsVal) trafficRpsVal.textContent = rps;
  if (_trafficActiveNode) trafficSim.setRps(_trafficActiveNode, rps);
});

// ── Panel resize & collapse ───────────────────────────────────────────────

const root = document.documentElement;
const SIDEBAR_DEFAULT = 268;
const PANEL_DEFAULT   = 308;
const SIDEBAR_MIN = 160, SIDEBAR_MAX = 480;
const PANEL_MIN   = 200, PANEL_MAX   = 520;

// Persist widths across sessions
let _sidebarW = parseInt(localStorage.getItem('sidebarW') || SIDEBAR_DEFAULT, 10);
let _panelW   = parseInt(localStorage.getItem('panelW')   || PANEL_DEFAULT,   10);
let _sidebarVisible = localStorage.getItem('sidebarVisible') !== 'false';
let _panelVisible   = localStorage.getItem('panelVisible')   !== 'false';

function applySidebarW(w) {
  _sidebarW = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, w));
  root.style.setProperty('--sidebar-w', _sidebarW + 'px');
  localStorage.setItem('sidebarW', _sidebarW);
}
function applyPanelW(w) {
  _panelW = Math.max(PANEL_MIN, Math.min(PANEL_MAX, w));
  root.style.setProperty('--panel-w', _panelW + 'px');
  localStorage.setItem('panelW', _panelW);
}

function setSidebarVisible(visible) {
  _sidebarVisible = visible;
  localStorage.setItem('sidebarVisible', visible);
  document.body.classList.toggle('sidebar-hidden', !visible);
  const btn = document.getElementById('btn-sidebar-collapse');
  if (btn) btn.textContent = visible ? '◀ Collapse' : '▶ Expand';
  // Re-apply width so CSS var is correct when re-expanding
  if (visible) root.style.setProperty('--sidebar-w', _sidebarW + 'px');
  updateCenter();
}

function setPanelVisible(visible) {
  _panelVisible = visible;
  localStorage.setItem('panelVisible', visible);
  document.body.classList.toggle('panel-hidden', !visible);
  const btn = document.getElementById('btn-panel-toggle');
  if (btn) btn.textContent = visible ? '◀' : '▶';
  if (visible) root.style.setProperty('--panel-w', _panelW + 'px');
  updateCenter();
}

// Apply persisted widths on load
applySidebarW(_sidebarW);
applyPanelW(_panelW);
setSidebarVisible(_sidebarVisible);
setPanelVisible(_panelVisible);

document.getElementById('btn-sidebar-collapse')?.addEventListener('click', () => setSidebarVisible(!_sidebarVisible));
document.getElementById('btn-panel-toggle')?.addEventListener('click', () => setPanelVisible(!_panelVisible));
// Edge tabs: always reachable even when the panel is fully collapsed
document.getElementById('sidebar-edge-tab')?.addEventListener('click', () => setSidebarVisible(!_sidebarVisible));
document.getElementById('panel-edge-tab')?.addEventListener('click',   () => setPanelVisible(!_panelVisible));

// Drag-to-resize
const sidebarHandle = document.getElementById('sidebar-resize-handle');
const panelHandle   = document.getElementById('panel-resize-handle');
let _resizing = null; // 'sidebar' | 'panel' | null

function startResize(which, e) {
  _resizing = which;
  document.body.classList.add('resizing');
  if (which === 'sidebar') sidebarHandle?.classList.add('dragging');
  if (which === 'panel')   panelHandle?.classList.add('dragging');
  e.preventDefault();
}

sidebarHandle?.addEventListener('mousedown', (e) => startResize('sidebar', e));
panelHandle?.addEventListener('mousedown',   (e) => startResize('panel', e));

document.addEventListener('mousemove', (e) => {
  if (!_resizing) return;
  if (_resizing === 'sidebar') {
    applySidebarW(e.clientX);
    updateCenter();
  } else {
    applyPanelW(window.innerWidth - e.clientX);
    updateCenter();
  }
});

document.addEventListener('mouseup', () => {
  if (!_resizing) return;
  _resizing = null;
  document.body.classList.remove('resizing');
  sidebarHandle?.classList.remove('dragging');
  panelHandle?.classList.remove('dragging');
});

// ── Health bar ────────────────────────────────────────────────────────────

const healthBarFill = document.getElementById('health-bar-fill');
const healthPct     = document.getElementById('health-pct');

function updateHealthBar() {
  const pods    = parseInt(document.getElementById('stat-pods')?.textContent    || '0', 10);
  const running = parseInt(document.getElementById('stat-running')?.textContent || '0', 10);
  if (!healthBarFill || !healthPct) return;
  if (pods === 0) {
    healthBarFill.style.width = '0%';
    healthPct.textContent = '—';
    healthBarFill.className = 'health-bar-fill';
    return;
  }
  const pct = Math.round((running / pods) * 100);
  healthBarFill.style.width = pct + '%';
  healthPct.textContent = `${running}/${pods}`;
  healthBarFill.className = 'health-bar-fill' +
    (pct < 50 ? ' error' : pct < 80 ? ' warn' : '');
}

// Hook into stats updates — reuse the existing stats subscriber
store.subscribe((type) => {
  if (type === 'snapshot' || type === 'node') {
    // stats are updated a tick later by the controls module; defer
    setTimeout(updateHealthBar, 50);
  }
});

// ── Hover tooltip ──────────────────────────────────────────────────────────

const tooltip    = document.getElementById('node-tooltip');
const ttKind     = document.getElementById('tt-kind');
const ttName     = document.getElementById('tt-name');
const ttNs       = document.getElementById('tt-ns');
const ttMeta     = document.getElementById('tt-meta');

let tooltipHideTimer;

graph.onNodeHover((id, clientX, clientY) => {
  if (!tooltip) return;
  clearTimeout(tooltipHideTimer);

  if (!id) {
    // Small delay before hiding so moving between nodes doesn't flicker
    tooltipHideTimer = setTimeout(() => { tooltip.style.display = 'none'; }, 80);
    return;
  }

  const node = store.nodes.get(id);
  if (!node) return;

  const name = node.metadata?.name || node.id;
  const ns   = node.metadata?.namespace || '';
  const spec = node.spec ? (typeof node.spec === 'string' ? JSON.parse(node.spec) : node.spec) : {};

  // Kind label
  if (ttKind) ttKind.textContent = node.kind;

  // Name
  if (ttName) ttName.textContent = name;

  // Namespace
  if (ttNs) {
    if (ns) { ttNs.textContent = `ns: ${ns}`; ttNs.style.display = ''; }
    else ttNs.style.display = 'none';
  }

  // Quick meta line (kind-specific)
  let meta = '';
  switch (node.kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'ReplicaSet':
      meta = `Replicas: ${spec.replicas ?? 1}`;
      break;
    case 'Pod':
      meta = `Phase: ${node.simPhase || 'Unknown'}`;
      break;
    case 'Service':
      meta = `Type: ${spec.type || 'ClusterIP'}`;
      if (spec.ports?.[0]) meta += `  ·  port ${spec.ports[0].port}`;
      break;
    case 'PersistentVolumeClaim':
      meta = `Storage: ${spec.resources?.requests?.storage || spec.requests || '—'}`;
      break;
    case 'PersistentVolume':
      meta = `Capacity: ${spec.capacity?.storage || spec.capacity || '—'}  ·  ${spec.persistentVolumeReclaimPolicy || 'Retain'}`;
      break;
    case 'HorizontalPodAutoscaler':
      meta = `Min: ${spec.minReplicas ?? 1}  Max: ${spec.maxReplicas ?? '—'}`;
      break;
    case 'Ingress':
      meta = spec.rules?.[0]?.host ? `Host: ${spec.rules[0].host}` : 'Catch-all rule';
      break;
    case 'Node':
      meta = `Status: ${node.status?.conditions?.[0]?.type || 'Ready'}`;
      break;
  }
  if (ttMeta) {
    if (meta) { ttMeta.textContent = meta; ttMeta.style.display = ''; }
    else ttMeta.style.display = 'none';
  }

  // Position near cursor, clipped to canvas
  tooltip.style.display = 'block';
  const canvasBounds = canvas.getBoundingClientRect();
  let tx = clientX - canvasBounds.left + 18;
  let ty = clientY - canvasBounds.top  + 14;
  const tw = tooltip.offsetWidth  || 180;
  const th = tooltip.offsetHeight || 80;
  if (tx + tw > canvasBounds.width  - 8) tx = clientX - canvasBounds.left - tw - 18;
  if (ty + th > canvasBounds.height - 8) ty = clientY - canvasBounds.top  - th - 14;
  tooltip.style.left = `${Math.max(4, tx)}px`;
  tooltip.style.top  = `${Math.max(4, ty)}px`;
});

// Hide tooltip when pointer leaves the SVG canvas entirely
canvas.addEventListener('pointerleave', () => {
  clearTimeout(tooltipHideTimer);
  if (tooltip) tooltip.style.display = 'none';
});

// ── Search / filter bar ────────────────────────────────────────────────────

const searchBar   = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const searchClose = document.getElementById('search-close');

function openSearch() {
  if (!searchBar) return;
  searchBar.classList.add('visible');
  searchInput?.focus();
}

function closeSearch() {
  if (!searchBar) return;
  searchBar.classList.remove('visible');
  if (searchInput) searchInput.value = '';
  graph.setFilter('');
  if (searchCount) searchCount.textContent = '';
}

searchInput?.addEventListener('input', () => {
  const text = searchInput.value;
  graph.setFilter(text);
  if (searchCount) {
    if (text.trim()) {
      const matches = graph.getFilterMatchCount();
      const total   = store.nodes.size;
      searchCount.textContent = `${matches} / ${total}`;
    } else {
      searchCount.textContent = '';
    }
  }
});

searchClose?.addEventListener('click', closeSearch);

// ── Keyboard shortcuts modal ───────────────────────────────────────────────

const shortcutsModal = document.getElementById('shortcuts-modal');
const shortcutsClose = document.getElementById('shortcuts-close');

function openShortcuts() {
  if (shortcutsModal) shortcutsModal.style.display = 'flex';
}
function closeShortcuts() {
  if (shortcutsModal) shortcutsModal.style.display = 'none';
}

shortcutsClose?.addEventListener('click', closeShortcuts);
shortcutsModal?.addEventListener('click', (e) => {
  if (e.target === shortcutsModal) closeShortcuts();
});

document.getElementById('btn-shortcuts')?.addEventListener('click', openShortcuts);

// ── Export cluster YAML ────────────────────────────────────────────────────

function exportYAML(nodes) {
  // Minimal YAML serializer for export (flat + 2-level)
  function scl(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    const s = String(v);
    return (s === '' || s === 'true' || s === 'false' || s === 'null' || /: /.test(s))
      ? `"${s.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"` : s;
  }
  function obj2yaml(o, indent) {
    const pad = '  '.repeat(indent);
    return Object.entries(o)
      .filter(([,v]) => v !== null && v !== undefined)
      .map(([k, v]) => {
        if (Array.isArray(v)) {
          if (!v.length) return `${pad}${k}: []`;
          const items = v.map(item => {
            if (item !== null && typeof item === 'object') {
              const entries = Object.entries(item).filter(([,iv]) => iv !== undefined && iv !== null);
              if (!entries.length) return `${pad}  - {}`;
              let first = true;
              return entries.map(([ek, ev]) => {
                const pfx = first ? `${pad}  - ` : `${pad}    `;
                first = false;
                if (ev !== null && typeof ev === 'object' && !Array.isArray(ev))
                  return `${pfx}${ek}:\n${obj2yaml(ev, indent + 2)}`;
                return `${pfx}${ek}: ${scl(ev)}`;
              }).join('\n');
            }
            return `${pad}  - ${scl(item)}`;
          });
          return `${pad}${k}:\n${items.join('\n')}`;
        }
        if (v !== null && typeof v === 'object') {
          const inner = obj2yaml(v, indent + 1);
          return inner ? `${pad}${k}:\n${inner}` : `${pad}${k}: {}`;
        }
        return `${pad}${k}: ${scl(v)}`;
      })
      .join('\n');
  }

  const docs = [];
  for (const node of nodes.values()) {
    if (node.kind === 'ControlPlaneComponent') continue; // internal-only kind
    const apiVersion = node.apiVersion || 'v1';
    const meta = { name: node.metadata?.name || node.id };
    if (node.metadata?.namespace) meta.namespace = node.metadata.namespace;
    if (node.metadata?.labels && Object.keys(node.metadata.labels).length)
      meta.labels = node.metadata.labels;
    const manifest = { apiVersion, kind: node.kind, metadata: meta };
    if (node.spec && typeof node.spec === 'object' && Object.keys(node.spec).length)
      manifest.spec = node.spec;
    docs.push('---\n' + obj2yaml(manifest, 0));
  }

  const yaml = docs.join('\n\n') + '\n';
  const blob = new Blob([yaml], { type: 'text/yaml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'cluster-export.yaml';
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('btn-export')?.addEventListener('click', () => {
  exportYAML(store.nodes);
});

// ── Guided mode ───────────────────────────────────────────────────────────

let _guidedMode  = false;
let _guidedQueue = [];  // { label, step, total }

const gpPanel       = document.getElementById('guided-panel');
const gpProgressTxt = document.getElementById('gp-progress-text');
const gpProgressFil = document.getElementById('gp-progress-fill');
const gpKindBadge   = document.getElementById('gp-kind-badge');
const gpStepLabel   = document.getElementById('gp-step-label');
const gpDescription = document.getElementById('gp-description');
const gpNext        = document.getElementById('gp-next');
const gpSkip        = document.getElementById('gp-skip');
const gpClose       = document.getElementById('gp-close');
const btnGuidedMode = document.getElementById('btn-guided-mode');

// Descriptions for each K8s kind and common kubectl/helm commands
const GUIDED_KIND_INFO = {
  Deployment:             'A Deployment manages a ReplicaSet to keep a specified number of Pod replicas running. It handles rolling updates and rollbacks automatically.',
  ReplicaSet:             'A ReplicaSet ensures a stable set of replica Pods is running at any given time. Usually managed by a Deployment rather than created directly.',
  Pod:                    'A Pod is the smallest deployable unit in Kubernetes — one or more containers sharing network and storage, scheduled onto a Node.',
  Service:                'A Service provides a stable DNS name and IP address to reach a set of Pods, load-balancing traffic across them. Types: ClusterIP, NodePort, LoadBalancer.',
  Ingress:                'An Ingress exposes HTTP/HTTPS routes from outside the cluster to Services inside. Requires an Ingress controller (e.g. nginx) to be installed.',
  ConfigMap:              'A ConfigMap stores non-sensitive key-value configuration data that Pods can consume as environment variables or mounted files.',
  Secret:                 'A Secret stores sensitive data (passwords, tokens, keys) encoded as base64. Pods consume them as env vars or volume mounts.',
  Namespace:              'A Namespace is a virtual cluster within Kubernetes, providing scope for names and allowing teams to share a cluster with resource isolation.',
  StatefulSet:            'A StatefulSet manages Pods that need stable network identity and persistent storage — ideal for databases like PostgreSQL or Kafka.',
  DaemonSet:              'A DaemonSet ensures one copy of a Pod runs on every (or selected) Node — perfect for log collectors, monitoring agents, or CNI plugins.',
  PersistentVolumeClaim:  'A PVC is a request for storage. Kubernetes binds it to a matching PersistentVolume, abstracting the underlying storage implementation.',
  PersistentVolume:       'A PV is a piece of cluster-level storage provisioned by an admin or dynamically by a StorageClass. It outlives the Pods that use it.',
  HorizontalPodAutoscaler:'An HPA automatically scales the number of Pod replicas based on observed CPU utilization or custom metrics.',
  CronJob:                'A CronJob runs a Job on a schedule defined by a cron expression — great for batch tasks, backups, or cleanup routines.',
  Job:                    'A Job creates one or more Pods and ensures a specified number of them successfully terminate, then the Job is complete.',
  ServiceAccount:         'A ServiceAccount provides an identity for Pods to authenticate against the Kubernetes API or external services.',
  Role:                   'A Role grants a set of permissions within a Namespace. Combined with a RoleBinding to apply to a user or ServiceAccount.',
  ClusterRole:            'A ClusterRole grants permissions across the entire cluster (or non-namespaced resources). Used with ClusterRoleBindings.',
  RoleBinding:            'A RoleBinding attaches a Role to a subject (user, group, or ServiceAccount) within a specific Namespace.',
  ClusterRoleBinding:     'A ClusterRoleBinding attaches a ClusterRole to a subject cluster-wide — granting permissions in all namespaces.',
  CustomResource:         'A CustomResource (CR) is an instance of a CustomResourceDefinition (CRD) — extending Kubernetes with operator-managed objects.',
  Node:                   'A Node is a worker machine in Kubernetes (VM or physical). The kubelet on each Node manages Pods and reports to the control plane.',
  ControlPlaneComponent:  'Control plane components (API server, etcd, scheduler, controller-manager) manage the cluster state and orchestrate workloads.',
};

const GUIDED_CMD_INFO = {
  'kubectl apply':     'Applies a YAML manifest to the cluster — creating or updating resources declared in the file.',
  'kubectl create':    'Creates a Kubernetes resource from a manifest or inline flags.',
  'kubectl delete':    'Deletes one or more resources from the cluster.',
  'kubectl get':       'Lists resources and their current status.',
  'kubectl describe':  'Shows detailed information about a specific resource including events.',
  'kubectl scale':     'Changes the number of replicas for a Deployment, ReplicaSet, or StatefulSet.',
  'kubectl rollout':   'Manages rollout of Deployments — status, history, undo, pause, resume.',
  'kubectl expose':    'Creates a Service to expose a Deployment, Pod, or ReplicaSet.',
  'helm install':      'Installs a Helm chart into the cluster, creating all the resources defined in the chart templates.',
  'helm upgrade':      'Upgrades an existing Helm release to a new chart version or with new values.',
  'helm uninstall':    'Removes a Helm release and all its resources from the cluster.',
  'kubeadm init':      'Initializes a Kubernetes control plane node using kubeadm — sets up the API server, etcd, and other components.',
  'kubeadm join':      'Joins a Node to an existing Kubernetes cluster managed by kubeadm.',
  'kubectl taint':     'Adds or removes a taint on a Node to repel certain Pods unless they have a matching Toleration.',
  'kubectl label':     'Adds or modifies labels on resources — used for selection by Services, selectors, and scheduling.',
  'kubectl annotate':  'Adds or modifies annotations on resources — arbitrary metadata for tooling.',
  'kubectl patch':     'Applies a partial update to a resource using strategic merge, JSON merge, or JSON patch.',
  'kubectl exec':      'Runs a command inside a running container — useful for debugging.',
  'kubectl logs':      'Fetches logs from a container in a Pod.',
  'kubectl port-forward': 'Forwards one or more local ports to a Pod — useful for local debugging.',
};

function parseStepLabel(label) {
  // "+ Kind/name" → resource creation
  const addMatch = label.match(/^\+\s+(\w+)\/(.+)/);
  if (addMatch) {
    return { type: 'resource', kind: addMatch[1], name: addMatch[2].trim() };
  }
  // "$ command args..." → kubectl/helm command
  const cmdMatch = label.match(/^\$\s+(.+)/);
  if (cmdMatch) {
    const cmdLine = cmdMatch[1].trim();
    for (const prefix of Object.keys(GUIDED_CMD_INFO)) {
      if (cmdLine.startsWith(prefix)) {
        return { type: 'command', cmd: prefix, full: cmdLine };
      }
    }
    return { type: 'command', cmd: null, full: cmdLine };
  }
  // "✓ done" messages
  if (label.includes('✓')) return { type: 'ok', label };
  // Indented sub-steps
  if (label.startsWith('  ')) return { type: 'sub', label };
  return { type: 'info', label };
}

function queueGuidedStep(label, step, total) {
  _guidedQueue.push({ label, step, total });
  // If panel is not yet visible (first step) or no pending step is showing, show immediately
  if (gpPanel && gpPanel.style.display === 'none') {
    renderGuidedStep();
  } else if (gpNext && gpNext.disabled) {
    // "Next" was waiting for new steps — auto-advance
    gpNext.disabled = false;
  }
}

function renderGuidedStep() {
  if (!gpPanel || _guidedQueue.length === 0) {
    if (gpPanel) gpPanel.style.display = 'none';
    return;
  }

  const { label, step, total } = _guidedQueue[0];  // peek, not shift

  const parsed = parseStepLabel(label);

  // Progress
  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  if (gpProgressTxt) gpProgressTxt.textContent = `Step ${step} / ${total}`;
  if (gpProgressFil) gpProgressFil.style.width = `${pct}%`;

  // Kind badge
  let kindText = '';
  let description = '';
  if (parsed.type === 'resource') {
    kindText = parsed.kind;
    description = GUIDED_KIND_INFO[parsed.kind] || `A Kubernetes ${parsed.kind} resource.`;
  } else if (parsed.type === 'command') {
    kindText = 'command';
    description = parsed.cmd ? GUIDED_CMD_INFO[parsed.cmd] : 'Running a cluster management command.';
  } else if (parsed.type === 'ok') {
    kindText = 'done';
    description = 'This step completed successfully.';
  } else {
    kindText = 'info';
    description = 'Configuring or preparing the cluster.';
  }

  if (gpKindBadge) gpKindBadge.textContent = kindText.toUpperCase();
  if (gpStepLabel) gpStepLabel.textContent = label;
  if (gpDescription) gpDescription.textContent = description;

  // Disable Next if queue only has 1 item left (waiting for more steps)
  if (gpNext) gpNext.disabled = _guidedQueue.length <= 1;

  gpPanel.style.display = '';
}

function advanceGuidedStep() {
  if (_guidedQueue.length > 0) _guidedQueue.shift();
  if (_guidedQueue.length === 0) {
    if (gpPanel) gpPanel.style.display = 'none';
  } else {
    renderGuidedStep();
  }
}

function clearGuidedQueue() {
  _guidedQueue = [];
  if (gpPanel) gpPanel.style.display = 'none';
}

function setGuidedMode(enabled) {
  _guidedMode = enabled;
  if (btnGuidedMode) {
    btnGuidedMode.classList.toggle('active', enabled);
    btnGuidedMode.title = enabled ? 'Guided mode ON — click to disable' : 'Toggle guided educational mode (G)';
  }
  if (!enabled) clearGuidedQueue();
}

gpNext?.addEventListener('click', advanceGuidedStep);
gpSkip?.addEventListener('click', clearGuidedQueue);
gpClose?.addEventListener('click', () => setGuidedMode(false));

btnGuidedMode?.addEventListener('click', () => setGuidedMode(!_guidedMode));

// ── Global keyboard shortcuts ──────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName?.toLowerCase();
  const inInput = tag === 'input' || tag === 'textarea' || tag === 'select';

  // ? — open shortcuts (never inside an input)
  if (!inInput && e.key === '?' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openShortcuts();
    return;
  }

  // G — toggle guided mode
  if (!inInput && (e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setGuidedMode(!_guidedMode);
    return;
  }

  // [ — toggle sidebar
  if (!inInput && e.key === '[' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setSidebarVisible(!_sidebarVisible);
    return;
  }

  // ] — toggle detail panel
  if (!inInput && e.key === ']' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setPanelVisible(!_panelVisible);
    return;
  }

  // Ctrl/Cmd + F — search
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    // Only intercept if terminal is not open
    const termOverlay = document.getElementById('terminal-overlay');
    if (termOverlay?.classList.contains('visible')) return;
    e.preventDefault();
    openSearch();
    return;
  }

  // Ctrl/Cmd + N — create resource
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    const termOverlay = document.getElementById('terminal-overlay');
    if (termOverlay?.classList.contains('visible')) return;
    e.preventDefault();
    controls.openCreateModal();
    return;
  }

  // Ctrl/Cmd + E — export YAML
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    exportYAML(store.nodes);
    return;
  }

  // Ctrl/Cmd + T — toggle theme
  if ((e.ctrlKey || e.metaKey) && e.key === 't') {
    e.preventDefault();
    document.getElementById('btn-theme')?.click();
    return;
  }

  // Escape — close modals / search / deselect
  if (e.key === 'Escape') {
    if (shortcutsModal?.style.display !== 'none') { closeShortcuts(); return; }
    if (searchBar?.classList.contains('visible')) { closeSearch(); return; }
    if (document.getElementById('resource-modal')?.style.display !== 'none') {
      document.getElementById('resource-modal').style.display = 'none';
      return;
    }
    // Deselect node
    if (store.selectedNodeID) {
      graph.markSelected(store.selectedNodeID, false);
      store.deselect();
    }
    return;
  }
});

