// panel.js — Detail panel renderer

import { api } from './api.js';

// Educational descriptions shown in the detail panel
const KIND_DESCRIPTIONS = {
  Deployment:    'Manages a set of identical Pods. Handles rolling updates, rollbacks, and scaling. Owns a ReplicaSet which in turn owns the Pods.',
  ReplicaSet:    'Ensures a specified number of Pod replicas are running at all times. Normally managed by a Deployment — rarely used directly.',
  Pod:           'The smallest deployable unit in Kubernetes. Runs one or more containers that share network and storage. Ephemeral by design.',
  Service:       'A stable network endpoint (IP + DNS name) that load-balances traffic to matching Pods using label selectors. Survives Pod restarts.',
  Ingress:       'Defines HTTP/HTTPS routing rules. Routes external traffic to Services inside the cluster. Requires an Ingress Controller to function.',
  ConfigMap:     'Stores non-secret configuration as key-value pairs or files. Mounted into Pods as environment variables or volumes.',
  Secret:        'Stores sensitive data (passwords, tokens, certificates) as base64-encoded values. Should be encrypted at rest in production.',
  PersistentVolumeClaim: 'A request for storage from a developer. Binds to a PersistentVolume. Pod uses the PVC to get durable storage that outlives the Pod.',
  PersistentVolume:      'A piece of storage in the cluster provisioned by an admin or dynamically. Independent of any Pod lifecycle.',
  StatefulSet:   'Like a Deployment but for stateful apps (databases, queues). Each Pod gets a stable network ID and its own PVC. Ordered startup/shutdown.',
  DaemonSet:     'Ensures exactly one Pod runs on every (or selected) Node. Used for node-level agents: log collectors, monitoring, network plugins.',
  HorizontalPodAutoscaler: 'Watches CPU/memory metrics (or custom metrics) and automatically adjusts the replica count of a Deployment or StatefulSet.',
  CronJob:       'Runs Jobs on a repeating schedule using cron syntax (e.g. "0 3 * * *" = 3am daily). Each run creates a new Job object.',
  Job:           'Creates one or more Pods and tracks their completion. Useful for batch tasks, migrations, or one-off scripts.',
  Namespace:     'A virtual cluster within the cluster. Provides scope for names and can have resource quotas and RBAC policies applied per namespace.',
  ControlPlaneComponent: 'A core component of the Kubernetes control plane that manages the state and operation of the cluster.',
  CustomResource: 'An instance of a Custom Resource Definition (CRD) installed by an operator. Operators extend the Kubernetes API with new resource types and watch for these CRs to reconcile them into standard Kubernetes objects (StatefulSets, Services, etc.).',
  Node: 'A worker machine in the cluster (VM or bare-metal). The kubelet runs on every Node and reports to the control plane. kube-proxy maintains network rules. Pods are scheduled here.',
  ServiceAccount: 'An identity for processes running in a Pod. The token is auto-mounted at /var/run/secrets/kubernetes.io/serviceaccount/token and used to authenticate requests to kube-apiserver.',
  Role: 'Namespace-scoped permission set. Defines allowed verbs (get, list, create…) on API resources within a single namespace.',
  ClusterRole: 'Cluster-wide permission set. Like Role but works across all namespaces — used by node agents, operators, and controllers.',
  RoleBinding: 'Grants a Role (or ClusterRole) to a ServiceAccount within one namespace. The WHO → WHAT binding that RBAC enforces.',
  ClusterRoleBinding: 'Grants a ClusterRole cluster-wide. Typically used for operators and system components that need cross-namespace access.',
  HorizontalPodAutoscaler: 'Watches CPU/memory metrics via metrics-server and adjusts the replica count of a Deployment or StatefulSet. Scale-up is fast; scale-down waits for a stabilization window (default 5 min) to avoid flapping.',
  NetworkPolicy: 'Restricts pod-to-pod communication using label selectors. By default all pods can talk to all pods — a NetworkPolicy opts selected pods into isolation. Ingress rules control incoming traffic; egress rules control outgoing traffic.',
  ResourceQuota: 'Caps total resource consumption per namespace (CPU, memory, pod count, PVC count, etc.). When a pod request exceeds the quota, it is rejected with a "exceeded quota" error — the pod never enters Pending.',
};

const COMPONENT_DESCRIPTIONS = {
  'coredns':           'DNS server for the cluster. Resolves service names (e.g. my-svc.default.svc.cluster.local) to their ClusterIP addresses.',
  'kube-proxy':        'Runs on every node. Maintains iptables/ipvs rules so that Service ClusterIPs route correctly to backend Pods.',
  'kube-apiserver':    'The "brain" of the cluster. Every command, controller, and node talks to this API server. It is the only component that communicates with etcd.',
  'etcd':              'Distributed key-value store. The single source of truth for all cluster state (nodes, pods, configs). If etcd is down, the cluster is effectively frozen.',
  'kube-scheduler':    'The matchmaker. It watches for new Pods with no assigned Node and selects the best Node for them to run on based on resources and constraints.',
  'redpanda': 'A Redpanda Custom Resource (CR). The user creates this object to declare "I want a Redpanda cluster." The redpanda-operator watches for it via Informer and reconciles it — creating the StatefulSet, Services, ConfigMaps, and Secrets that make up the actual cluster.',
  'kube-controller-manager': 'The control loop center. A single binary running 40+ controllers (Deployment, ReplicaSet, DaemonSet, Job, Node, Namespace, PV, HPA, etc.) that continuously reconcile actual cluster state toward the desired state. Communicates exclusively through the API server via Informers.',
  'cloud-controller-manager': 'Runs cloud-provider-specific controllers (Node, Route, LoadBalancer) decoupled from the core controller-manager. Bridges Kubernetes with cloud provider APIs (AWS, GCP, Azure). Watches the API server via Informers just like kube-controller-manager.',
  'prometheus':        'Time-series metrics database. Scrapes /metrics endpoints from Pods and stores them for alerting and dashboards.',
};

export class DetailPanel {
  constructor({ titleEl, contentEl, emptyEl, store }) {
    this._title = titleEl;
    this._content = contentEl;
    this._empty = emptyEl;
    this._store = store;
    this._currentNode = null;
    this._onScale = null;
    this._onEdit = null;
    this._onSimulateTraffic = null;
  }

  onScale(cb) { this._onScale = cb; }
  onSimulateTraffic(cb) { this._onSimulateTraffic = cb; }
  onEdit(cb) { this._onEdit = cb; }

  show(node) {
    this._currentNode = node;
    this._title.textContent = node.metadata?.name || node.name || node.id;

    // Add / update header action buttons
    const header = this._title.parentElement;

    // Edit button
    let editBtn = document.getElementById('detail-edit-btn');
    if (!editBtn) {
      editBtn = document.createElement('button');
      editBtn.id = 'detail-edit-btn';
      editBtn.className = 'btn';
      editBtn.style.cssText = 'font-size:11px;padding:3px 9px;margin-left:auto;flex-shrink:0';
      editBtn.textContent = '✎ Edit';
      header.appendChild(editBtn);
    }
    editBtn.style.marginLeft = 'auto';
    editBtn.onclick = () => { if (this._onEdit) this._onEdit(this._currentNode); };

    // Traffic button — shown for Services and Ingresses (entry points for traffic)
    let trafficBtn = document.getElementById('detail-traffic-btn');
    if (!trafficBtn) {
      trafficBtn = document.createElement('button');
      trafficBtn.id = 'detail-traffic-btn';
      trafficBtn.className = 'btn';
      trafficBtn.style.cssText = 'font-size:11px;padding:3px 9px;flex-shrink:0';
      header.appendChild(trafficBtn);
    }
    const trafficKinds = new Set(['Service', 'Ingress', 'Pod']);
    if (trafficKinds.has(node.kind)) {
      trafficBtn.style.display = '';
      trafficBtn.textContent = '▶ Traffic';
      trafficBtn.onclick = () => { if (this._onSimulateTraffic) this._onSimulateTraffic(this._currentNode); };
    } else {
      trafficBtn.style.display = 'none';
    }

    this._empty.style.display = 'none';
    this._content.style.display = 'block';
    this._content.innerHTML = '';
    this._render(node);
  }

  update(node) {
    if (this._currentNode && this._currentNode.id === node.id) this.show(node);
  }

  hide() {
    this._currentNode = null;
    this._title.textContent = 'Details';
    document.getElementById('detail-edit-btn')?.remove();
    document.getElementById('detail-traffic-btn')?.remove();
    this._empty.style.display = '';
    this._content.style.display = 'none';
  }

  _render(node) {
    const c = this._content;

    // Kind + namespace badges
    const meta = node.metadata || {};
    const name = meta.name || node.name || node.id;
    const kindBadge = `<span class="kind-badge kind-${node.kind} kind-default">${node.kind}</span>`;
    const apiVersion = `<code style="font-size:11px;color:var(--text-muted)">${node.apiVersion || ''}</code>`;
    c.innerHTML += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">${kindBadge} ${apiVersion}</div>`;

    // Educational description
    const compDesc = COMPONENT_DESCRIPTIONS[name] || COMPONENT_DESCRIPTIONS[name.split('-').slice(0,2).join('-')];
    const kindDesc = KIND_DESCRIPTIONS[node.kind] || '';
    const desc = compDesc || kindDesc;
    if (desc) {
      c.innerHTML += `<div class="node-description">${compDesc ? `<strong>${name}</strong> — ` : ''}${desc}</div>`;
    }

    // Version deprecation callout
    if (node._deprecated) {
      c.innerHTML += `<div class="version-callout deprecated"><div class="callout-title">⚠ Deprecated API</div>${node._deprecatedNote || ''}</div>`;
    }

    // Phase badge for pods
    if (node.kind === 'Pod' || node.simPhase) {
      const phase = node.simPhase || 'Unknown';
      c.innerHTML += `<div style="margin-bottom:10px"><span class="phase-badge phase-${phase}">${phaseDot(phase)} ${phase}</span></div>`;
    }

    // Core metadata table
    const rows = [
      ['Name',      name],
      ['Namespace', meta.namespace || '(cluster-scoped)'],
      ['Created',   meta.creationTimestamp ? new Date(meta.creationTimestamp).toLocaleString() : '—'],
      ['ID',        node.id],
    ];
    c.innerHTML += section('Metadata', metaTable(rows));

    // Provenance / Lineage ("Who Created Me?")
    try {
      if (this._store && this._store.edges) {
        const ownerEdges = Array.from(this._store.edges.values()).filter(e => e && e.target === node.id && e.type === 'owns');
        if (ownerEdges.length > 0) {
          const ownersHtml = ownerEdges.map(e => {
            const parent = this._store.nodes.get(e.source);
            if (!parent) return '';
            const parentName = parent.metadata?.name || parent.name || parent.id;
            return `I was created by <strong>${escapeHTML(parent.kind)}</strong> <code>${escapeHTML(parentName)}</code>.`;
          }).join('<br>');
          if (ownersHtml) {
            c.innerHTML += section('Provenance', `<div class="node-description" style="margin:0; font-size:12px">${ownersHtml}</div>`);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to render provenance:', err);
    }

    // Labels
    if (meta.labels && Object.keys(meta.labels).length > 0) {
      const pills = Object.entries(meta.labels)
        .map(([k, v]) => `<span class="label-pill">${k}=${v}</span>`).join('');
      c.innerHTML += section('Labels', `<div class="labels-list">${pills}</div>`);
    }

    // CRD-backed resources: fetch live schema and render field descriptions.
    const crdKinds = ['Redpanda', 'RedpandaTopic', 'RedpandaUser', 'RedpandaSchema'];
    if (crdKinds.includes(node.kind)) {
      this._renderCRDSchema(node, c);
    }

    // Redpanda CR: three-layer config breakdown (always shown alongside schema).
    if (node.id === 'cr-redpanda') {
      c.innerHTML += this._renderRedpandaConfigLayers();
    }

    // Kind-specific actions
    this._renderActions(node, c);

    // Spec viewer (collapsible)
    if (node.spec) {
      const specStr = JSON.stringify(node.spec, null, 2);
      c.innerHTML += section('Spec', `<div class="spec-viewer">${escapeHTML(specStr)}</div>`);
    }

    // kubectl command preview
    this._renderKubectl(node, c);

    // Re-bind action buttons (innerHTML wipes event listeners)
    this._bindActions(node, c);
  }

  _renderActions(node, c) {
    switch (node.kind) {
      case 'Deployment':
      case 'StatefulSet': {
        const spec = node.spec || {};
        const replicas = spec.replicas ?? 1;
        c.innerHTML += section('Replicas', `
          <div class="replica-stepper">
            <button class="btn" id="btn-scale-down">−</button>
            <span id="replica-count">${replicas}</span>
            <button class="btn" id="btn-scale-up">+</button>
          </div>
          <div style="font-size:10px;color:var(--text-muted)">Click +/− to simulate scaling</div>
        `);
        if (node.kind === 'StatefulSet' && node.id === 'sts-redpanda') {
          c.innerHTML += section('Rolling Update',
            `<div class="panel-actions">
              <button class="btn" id="btn-rolling-update" title="Upgrade Redpanda v24.3.1 → v24.3.2 pod by pod (reverse ordinal order)">▶ Upgrade v24.3.1 → v24.3.2</button>
            </div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
              Pods restart 2→1→0 (highest ordinal first) to safely migrate Raft leadership before each restart.
            </div>`
          );
        }
        break;
      }

      case 'Pod': {
        // Educational failure callout when pod is in a failure state
        const failureInfo = {
          CrashLoopBackOff: {
            title: 'CrashLoopBackOff',
            msg: 'Container keeps crashing and Kubernetes restarts it with exponential backoff (10s→20s→40s→80s…). The pod will never become Ready until the crash is fixed.',
            fix: 'kubectl logs &lt;pod&gt; --previous -n &lt;ns&gt;',
            color: 'var(--danger)',
          },
          ImagePullBackOff: {
            title: 'ImagePullBackOff',
            msg: 'Kubernetes cannot pull the container image. The tag may not exist, the registry may be unreachable, or imagePullSecrets may be missing.',
            fix: 'kubectl describe pod &lt;pod&gt; -n &lt;ns&gt; | grep -A5 Events:',
            color: 'var(--warning)',
          },
          OOMKilled: {
            title: 'OOMKilled',
            msg: 'Container used more RAM than its resources.limits.memory allows. The kernel OOM killer terminated it. It will restart, but will OOMKill again unless you raise the limit.',
            fix: 'helm upgrade … --set resources.limits.memory=4Gi',
            color: 'var(--danger)',
          },
          ContainerCreating: {
            title: 'ContainerCreating',
            msg: 'Kubernetes is setting up the container: pulling the image, mounting volumes, and configuring the network namespace. This is normal during startup.',
            fix: null,
            color: 'var(--warning)',
          },
        };
        const fi = failureInfo[node.simPhase];
        if (fi) {
          c.innerHTML += `<div class="failure-callout" style="border-left-color:${fi.color}">
            <div class="failure-callout-title" style="color:${fi.color}">⚠ ${fi.title}</div>
            <div class="failure-callout-msg">${fi.msg}</div>
            ${fi.fix ? `<div class="failure-callout-fix"><code>${fi.fix}</code></div>` : ''}
          </div>`;
        }

        // Container structure
        const podSpec = node.spec || {};
        const initCtrs = podSpec.initContainers || [];
        const mainCtrs = podSpec.containers || [];
        if (initCtrs.length > 0 || mainCtrs.length > 0) {
          const rows = [
            ...initCtrs.map(ct => containerRow(ct)),
            ...mainCtrs.map(ct => containerRow(ct)),
          ].join('');
          c.innerHTML += section('Containers', `<div class="container-list">${rows}</div>`);
        }

        const phases = ['Pending','Running','Failed','Succeeded','Terminating'];
        const btns = phases.map(ph =>
          `<button class="btn" data-phase="${ph}" id="btn-phase-${ph}" style="${ph === node.simPhase ? 'border-color:var(--accent)' : ''}">${ph}</button>`
        ).join('');
        c.innerHTML += section('Force Phase', `<div class="panel-actions">${btns}</div>`);

        // Failure simulation buttons — only for Running pods
        if (node.simPhase === 'Running') {
          c.innerHTML += section('Simulate Failure',
            `<div class="panel-actions">
              <button class="btn btn-failure" id="btn-crash-loop" title="Simulate container crashing in a loop with exponential backoff">CrashLoopBackOff</button>
              <button class="btn btn-failure" id="btn-image-pull-backoff" title="Simulate a bad image tag causing pull failures">ImagePullBackOff</button>
              <button class="btn btn-failure" id="btn-oom-killed" title="Simulate container exceeding memory limit and being killed">OOMKilled</button>
              <button class="btn btn-failure" id="btn-liveness-probe" title="Simulate 3 consecutive liveness probe failures (failureThreshold=3) — container restarts">Liveness Probe</button>
            </div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
              Learn how to diagnose and recover from common Pod failures.
            </div>`
          );
        }
        break;
      }

      case 'Ingress': {
        const spec = node.spec || {};
        const rules = spec.rules || [];
        if (rules.length > 0) {
          const ruleList = rules.map(r =>
            `<tr><td>${r.host || '*'}</td><td>${r.path || '/'}</td><td>${r.serviceID || '?'}</td></tr>`
          ).join('');
          c.innerHTML += section('Routing Rules', `<table class="meta-table"><thead><tr><th>Host</th><th>Path</th><th>Service</th></tr></thead><tbody>${ruleList}</tbody></table>`);
        }
        c.innerHTML += section('Traffic Simulation',
          `<div class="panel-actions">
            <button class="btn" id="btn-simulate-traffic" title="Animate request flow: Ingress → Service → Pod">▶ Simulate Request</button>
          </div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
            Pulses the Ingress→Service→Pod edges to show the HTTP request path.
          </div>`
        );
        break;
      }

      case 'NetworkPolicy': {
        const spec = node.spec || {};
        const podSel = spec.podSelector || {};
        const types = (spec.policyTypes || []).join(', ') || 'Ingress';
        const selStr = Object.entries(podSel).length > 0
          ? Object.entries(podSel).map(([k,v]) => `${k}=${v}`).join(', ')
          : '(all pods in namespace)';
        const ingressRules = spec.ingress || [];
        const egressRules  = spec.egress  || [];

        let rulesHtml = `<div class="netpol-row"><span class="netpol-key">Selects pods</span><span class="netpol-val">${escapeHTML(selStr)}</span></div>`;
        rulesHtml += `<div class="netpol-row"><span class="netpol-key">Policy types</span><span class="netpol-val">${escapeHTML(types)}</span></div>`;

        if (ingressRules.length > 0) {
          const fromSources = ingressRules.flatMap(r => r.from || [])
            .map(p => {
              if (p.namespaceSelector) return `ns:${JSON.stringify(p.namespaceSelector)}`;
              if (p.podSelector)       return `pod:${JSON.stringify(p.podSelector)}`;
              return 'any';
            });
          rulesHtml += `<div class="netpol-row"><span class="netpol-key">Ingress from</span><span class="netpol-val">${fromSources.length ? escapeHTML(fromSources.join(', ')) : '(allow all sources)'}</span></div>`;
        } else if (types.includes('Ingress')) {
          rulesHtml += `<div class="netpol-row netpol-deny"><span class="netpol-key">Ingress</span><span class="netpol-val">⛔ default deny — no ingress rules means all inbound traffic is blocked</span></div>`;
        }

        if (egressRules.length > 0) {
          const toDestinations = egressRules.flatMap(r => r.to || [])
            .map(p => {
              if (p.namespaceSelector) return `ns:${JSON.stringify(p.namespaceSelector)}`;
              if (p.podSelector)       return `pod:${JSON.stringify(p.podSelector)}`;
              return 'any';
            });
          rulesHtml += `<div class="netpol-row"><span class="netpol-key">Egress to</span><span class="netpol-val">${toDestinations.length ? escapeHTML(toDestinations.join(', ')) : '(allow all destinations)'}</span></div>`;
        } else if (types.includes('Egress')) {
          rulesHtml += `<div class="netpol-row netpol-deny"><span class="netpol-key">Egress</span><span class="netpol-val">⛔ default deny — no egress rules means all outbound traffic is blocked</span></div>`;
        }

        c.innerHTML += section('Policy Rules', `<div class="netpol-table">${rulesHtml}</div>`);

        c.innerHTML += `<div class="node-description" style="border-left:3px solid var(--warning);padding-left:10px;margin-top:8px">
          <strong>Key insight:</strong> A NetworkPolicy only restricts pods that match its <code>podSelector</code>.
          Pods <em>without</em> any NetworkPolicy selecting them remain fully open.
          To enforce namespace isolation, create a default-deny policy first.
        </div>`;
        break;
      }

      case 'ResourceQuota': {
        const status = node.status || {};
        const hard = status.hard || node.spec?.hard || {};
        const used = status.used || {};
        if (Object.keys(hard).length > 0) {
          const rows = Object.entries(hard).map(([k, v]) => {
            const u = used[k] || '0';
            return `<tr><td>${escapeHTML(k)}</td><td>${escapeHTML(u)}</td><td>${escapeHTML(String(v))}</td></tr>`;
          }).join('');
          c.innerHTML += section('Quota Usage', `
            <table class="meta-table">
              <thead><tr><th>Resource</th><th>Used</th><th>Hard Limit</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`);
        }
        break;
      }

      case 'Node': {
        const status  = node.status || {};
        const nodeSpec = node.spec   || {};
        const conditions = status.conditions || [];
        const ready = conditions.includes('Ready');
        const notReady = conditions.includes('NotReady');
        const condBadge = notReady
          ? `<span class="phase-badge phase-Failed">NotReady</span>`
          : (ready ? `<span class="phase-badge phase-Running">Ready</span>` : `<span class="phase-badge phase-Pending">Unknown</span>`);

        c.innerHTML += section('Node Status', `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">${condBadge}</div>
          <table class="meta-table"><tbody>
            <tr><td>Capacity</td><td>${escapeHTML(nodeSpec.capacity || '—')}</td></tr>
            <tr><td>OS</td><td>${escapeHTML(nodeSpec.osImage || '—')}</td></tr>
            <tr><td>Kubelet</td><td>${escapeHTML(nodeSpec.kubeletVersion || '—')}</td></tr>
            <tr><td>Roles</td><td>${escapeHTML((nodeSpec.roles || []).join(', ') || '—')}</td></tr>
          </tbody></table>`);

        // Node failure injection (only if Ready)
        if (ready) {
          c.innerHTML += section('Simulate Failure',
            `<div class="panel-actions">
              <button class="btn btn-failure" id="btn-node-not-ready" title="Simulate the kubelet stopping — node goes NotReady, pods evicted">Node NotReady</button>
            </div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
              Simulates network partition or hardware failure — teaches node eviction and pod rescheduling.
            </div>`);
        }
        break;
      }

      case 'PersistentVolumeClaim': {
        const status = node.status || {};
        const phase = status.phase || 'Pending';
        const isBound = phase === 'Bound';
        c.innerHTML += section('Binding',
          `<div style="margin-bottom:6px"><span class="phase-badge phase-${isBound ? 'Running' : 'Pending'}">${phase}</span></div>` +
          (!isBound
            ? `<div class="panel-actions"><button class="btn btn-primary" id="btn-bind-pvc">Auto-bind PV</button></div>`
            : `<div class="panel-actions">
                 <button class="btn" id="btn-unbind-pvc" title="Removes claimRef from PV — PVC goes back to Pending">Unbind PVC</button>
               </div>
               <div style="font-size:10px;color:var(--text-muted);margin-top:4px">
                 Simulates <code>kubectl patch pv ... claimRef=null</code>.<br>
                 PVC → Pending · PV → Released.
               </div>`)
        );
        break;
      }
    }

    // Delete button for all resources
    c.innerHTML += `<div class="panel-actions" style="margin-top:8px">
      <button class="btn btn-danger" id="btn-delete-resource">Delete</button>
    </div>`;
  }

  _bindActions(node, c) {
    // Scale up/down
    const scaleUp = c.querySelector('#btn-scale-up');
    const scaleDown = c.querySelector('#btn-scale-down');
    const countEl = c.querySelector('#replica-count');
    if (scaleUp && scaleDown && countEl) {
      const getCount = () => parseInt(countEl.textContent, 10) || 1;
      scaleUp.addEventListener('click', async () => {
        const n = getCount() + 1;
        countEl.textContent = n;
        try { await api.scale(node.id, n); } catch (e) { console.error(e); }
        if (this._onScale) this._onScale(node.id, n);
      });
      scaleDown.addEventListener('click', async () => {
        const n = Math.max(0, getCount() - 1);
        countEl.textContent = n;
        try { await api.scale(node.id, n); } catch (e) { console.error(e); }
        if (this._onScale) this._onScale(node.id, n);
      });
    }

    // Phase buttons
    for (const btn of c.querySelectorAll('[data-phase]')) {
      btn.addEventListener('click', async () => {
        const phase = btn.dataset.phase;
        try { await api.setPodPhase(node.id, phase); } catch (e) { console.error(e); }
      });
    }

    // Delete
    const delBtn = c.querySelector('#btn-delete-resource');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete ${node.kind} "${node.metadata?.name || node.id}"?`)) return;
        try { await api.deleteResource(node.id); } catch (e) { console.error(e); }
      });
    }

    // Bind PVC
    const bindBtn = c.querySelector('#btn-bind-pvc');
    if (bindBtn) {
      bindBtn.addEventListener('click', async () => {
        const pvID = prompt('Enter PV node ID to bind to:');
        if (!pvID) return;
        try { await api.bindPVC(node.id, pvID.trim()); } catch (e) { alert('Error: ' + e.message); }
      });
    }

    // Unbind PVC
    const unbindBtn = c.querySelector('#btn-unbind-pvc');
    if (unbindBtn) {
      unbindBtn.addEventListener('click', async () => {
        if (!confirm(`Unbind PVC "${node.metadata?.name || node.id}"?\n\nThis removes the claimRef from the PV and returns the PVC to Pending.`)) return;
        try { await api.unbindPVC(node.id); } catch (e) { alert('Error: ' + e.message); }
      });
    }

    // Traffic simulation button (Ingress)
    const trafficBtn = c.querySelector('#btn-simulate-traffic');
    if (trafficBtn && this._onSimulateTraffic) {
      trafficBtn.addEventListener('click', () => {
        this._onSimulateTraffic(node.id);
        trafficBtn.textContent = '⏳ Simulating…';
        setTimeout(() => { trafficBtn.textContent = '▶ Simulate Request'; }, 4200);
      });
    }

    // Failure simulation buttons
    const crashBtn  = c.querySelector('#btn-crash-loop');
    const ipboBtn   = c.querySelector('#btn-image-pull-backoff');
    const oomBtn    = c.querySelector('#btn-oom-killed');
    if (crashBtn) {
      crashBtn.addEventListener('click', async () => {
        try { await api.simulateFailure('crash-loop', node.id); } catch (e) { console.error(e); }
      });
    }
    if (ipboBtn) {
      ipboBtn.addEventListener('click', async () => {
        try { await api.simulateFailure('image-pull-backoff', node.id); } catch (e) { console.error(e); }
      });
    }
    if (oomBtn) {
      oomBtn.addEventListener('click', async () => {
        try { await api.simulateFailure('oom-killed', node.id); } catch (e) { console.error(e); }
      });
    }

    // Rolling update
    const rollBtn = c.querySelector('#btn-rolling-update');
    if (rollBtn) {
      rollBtn.addEventListener('click', async () => {
        try { await api.rollingUpdate(); } catch (e) { console.error(e); }
      });
    }

    // Liveness probe failure
    const livenessBtn = c.querySelector('#btn-liveness-probe');
    if (livenessBtn) {
      livenessBtn.addEventListener('click', async () => {
        try { await api.simulateFailure('liveness-probe', node.id); } catch (e) { console.error(e); }
      });
    }

    // Node NotReady failure
    const nodeNotReadyBtn = c.querySelector('#btn-node-not-ready');
    if (nodeNotReadyBtn) {
      nodeNotReadyBtn.addEventListener('click', async () => {
        try { await api.simulateFailure('node-not-ready', node.id); } catch (e) { console.error(e); }
      });
    }

    // kubectl copy buttons
    for (const btn of c.querySelectorAll('.kubectl-copy-btn')) {
      btn.addEventListener('click', () => {
        navigator.clipboard?.writeText(btn.dataset.cmd).then(() => {
          const orig = btn.textContent;
          btn.textContent = '✓';
          btn.style.color = 'var(--success)';
          setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1400);
        }).catch(() => {});
      });
    }
  }

  _renderKubectl(node, c) {
    const meta = node.metadata || {};
    const name = meta.name || node.name || node.id || '';
    const ns   = meta.namespace;
    const k    = (node.kind || 'resource').toLowerCase()
      .replace('horizontalpodautoscaler', 'hpa')
      .replace('persistentvolumeclaim', 'pvc')
      .replace('persistentvolume', 'pv')
      .replace('serviceaccount', 'sa')
      .replace('clusterrolebinding', 'clusterrolebinding')
      .replace('rolebinding', 'rolebinding')
      .replace('clusterrole', 'clusterrole')
      .replace('networkpolicy', 'networkpolicy')
      .replace('resourcequota', 'resourcequota')
      .replace('controlplanecomponent', 'pod');

    const clusterScoped = new Set(['Namespace','Node','ClusterRole','ClusterRoleBinding','PersistentVolume']);
    const nf = clusterScoped.has(node.kind) ? '' : (ns ? ` -n ${ns}` : '');

    const cmds = [
      { label: 'get',      cmd: `kubectl get ${k} ${name}${nf}` },
      { label: 'describe', cmd: `kubectl describe ${k} ${name}${nf}` },
      { label: 'delete',   cmd: `kubectl delete ${k} ${name}${nf}` },
    ];

    if (node.kind === 'Pod') {
      cmds.push({ label: 'logs',  cmd: `kubectl logs ${name}${nf}` });
      cmds.push({ label: 'exec',  cmd: `kubectl exec -it ${name}${nf} -- /bin/sh` });
      cmds.push({ label: 'prev',  cmd: `kubectl logs ${name}${nf} --previous` });
    }
    if (node.kind === 'Deployment') {
      cmds.push({ label: 'rollout', cmd: `kubectl rollout status deploy/${name}${nf}` });
      cmds.push({ label: 'history', cmd: `kubectl rollout history deploy/${name}${nf}` });
      cmds.push({ label: 'undo',    cmd: `kubectl rollout undo deploy/${name}${nf}` });
    }
    if (node.kind === 'StatefulSet') {
      cmds.push({ label: 'rollout', cmd: `kubectl rollout status sts/${name}${nf}` });
    }
    if (node.kind === 'Service') {
      const port = node.spec?.ports?.[0]?.port || 80;
      cmds.push({ label: 'port-fwd', cmd: `kubectl port-forward svc/${name} 8080:${port}${nf}` });
    }
    if (node.kind === 'Node') {
      cmds.push({ label: 'top',    cmd: `kubectl top node ${name}` });
      cmds.push({ label: 'drain',  cmd: `kubectl drain ${name} --ignore-daemonsets --delete-emptydir-data` });
      cmds.push({ label: 'cordon', cmd: `kubectl cordon ${name}` });
    }
    if (node.kind === 'NetworkPolicy') {
      cmds.push({ label: 'yaml', cmd: `kubectl get networkpolicy ${name}${nf} -o yaml` });
    }

    const rows = cmds.map(({ label, cmd }) => `
      <div class="kubectl-cmd-row">
        <span class="kubectl-label">${escapeHTML(label)}</span>
        <code class="kubectl-cmd">${escapeHTML(cmd)}</code>
        <button class="kubectl-copy-btn" data-cmd="${escapeHTML(cmd)}" title="Copy to clipboard">⎘</button>
      </div>`).join('');

    c.innerHTML += section('kubectl', `<div class="kubectl-list">${rows}</div>`);
  }

  // Fetches the CRD schema for the node's kind and injects a "Spec Fields"
  // section into the panel. Runs async so the panel renders immediately and
  // the schema section appears once the fetch completes.
  async _renderCRDSchema(node, container) {
    const placeholder = document.createElement('div');
    placeholder.className = 'panel-section';
    placeholder.innerHTML = `<div class="panel-section-title">Spec Fields</div>
      <div style="font-size:11px;color:var(--text-muted);padding:4px 0">Loading schema…</div>`;
    container.appendChild(placeholder);

    let schemaData;
    try {
      schemaData = await api.fetchSchema(node.kind);
    } catch {
      placeholder.innerHTML = `<div class="panel-section-title">Spec Fields</div>
        <div style="font-size:11px;color:var(--text-muted);padding:4px 0">Schema unavailable</div>`;
      return;
    }

    // Parse the current spec so we can show live values next to descriptions.
    let currentSpec = {};
    try {
      const raw = typeof node.spec === 'string' ? JSON.parse(node.spec) : (node.spec || {});
      currentSpec = raw;
    } catch { /* ignore parse errors */ }

    const rowStyle = `display:flex;gap:6px;padding:4px 0;border-bottom:1px solid var(--border,#313244);align-items:flex-start`;
    const pathStyle = `color:var(--blue,#89b4fa);min-width:0;flex:1;font-family:var(--mono);font-size:10px;word-break:break-all`;
    const descStyle = `color:var(--text-muted);font-size:10px;flex:2;line-height:1.4`;
    const valStyle  = `color:var(--green,#a6e3a1);font-family:var(--mono);font-size:10px;flex-shrink:0;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`;
    const badgeStyle = (color) => `display:inline-block;font-size:9px;padding:1px 4px;border-radius:3px;margin-left:4px;background:${color}20;color:${color};border:1px solid ${color}40`;

    const getNestedValue = (obj, dotPath) => {
      // Strip leading "spec." since currentSpec is already the spec object.
      const parts = dotPath.replace(/^spec\./, '').split('.');
      let cur = obj;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[p];
      }
      return cur;
    };

    const rows = schemaData.fields.map(f => {
      const live = getNestedValue(currentSpec, f.path);
      const liveStr = live !== undefined ? String(JSON.stringify(live)).replace(/^"|"$/g, '') : '';
      const typeBadge = f.type ? `<span style="${badgeStyle('#cba6f7')}">${escapeHTML(f.type)}</span>` : '';
      const reqBadge  = f.required ? `<span style="${badgeStyle('#f38ba8')}">required</span>` : '';
      const defNote   = f.default ? `<span style="color:var(--text-muted);font-size:9px"> · default: ${escapeHTML(f.default)}</span>` : '';
      const enumNote  = f.enum?.length ? `<div style="font-size:9px;color:var(--text-muted);margin-top:2px">Options: ${f.enum.map(e => `<code style="background:var(--surface1,#1e1e2e);padding:0 3px;border-radius:2px">${escapeHTML(e)}</code>`).join(' ')}</div>` : '';

      return `<div style="${rowStyle}">
        <div style="${pathStyle}">${escapeHTML(f.path.replace(/^spec\./, ''))}${typeBadge}${reqBadge}</div>
        <div style="${descStyle}">${escapeHTML(f.description || '')}${defNote}${enumNote}</div>
        ${liveStr ? `<div style="${valStyle}" title="${escapeHTML(liveStr)}">${escapeHTML(liveStr)}</div>` : ''}
      </div>`;
    }).join('');

    const meta = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:6px">
      ${escapeHTML(schemaData.crd)} · operator ${escapeHTML(schemaData.operatorVersion)} · API ${escapeHTML(schemaData.apiVersion)}
      <a href="${escapeHTML(schemaData.sourceURL)}" target="_blank" rel="noopener"
         style="color:var(--blue,#89b4fa);margin-left:6px;font-size:9px">source ↗</a>
    </div>`;

    placeholder.innerHTML = `<div class="panel-section-title">Spec Fields</div>${meta}
      <div style="font-size:11px;line-height:1.6">${rows || '<em style="color:var(--text-muted)">No fields defined</em>'}</div>`;
  }

  _renderRedpandaConfigLayers() {
    const layerStyle = `
      font-size:11px;line-height:1.6;
    `;
    const headerStyle = `
      font-weight:600;font-size:11px;margin:8px 0 4px;
      padding:3px 6px;border-radius:3px;
    `;
    const rowStyle = `display:flex;gap:6px;padding:2px 0;border-bottom:1px solid var(--border,#313244)`;
    const keyStyle = `color:var(--text-muted);min-width:190px;font-family:var(--mono);font-size:10px;flex-shrink:0`;
    const valStyle = `color:var(--text-primary);font-family:var(--mono);font-size:10px`;
    const destStyle = `color:var(--success,#a6e3a1);font-size:10px;margin-left:auto;flex-shrink:0`;

    const row = (key, val, dest) =>
      `<div style="${rowStyle}">
        <span style="${keyStyle}">${escapeHTML(key)}</span>
        <span style="${valStyle}">${escapeHTML(val)}</span>
        <span style="${destStyle}">${escapeHTML(dest)}</span>
      </div>`;

    const layer1 = [
      ['statefulset.replicas',           '3',     '→ StatefulSet spec'],
      ['storage.persistentVolume.size',   '20Gi',  '→ PVC template'],
      ['resources.cpu.cores',             '1',     '→ requests/limits + --smp'],
      ['resources.memory.container.max',  '2.5Gi', '→ limits.memory + --memory'],
      ['statefulset.updateStrategy',      'RollingUpdate', '→ StatefulSet'],
      ['statefulset.podAntiAffinity.type','hard',  '→ affinity rules'],
    ].map(([k,v,d]) => row(k, v, d)).join('');

    const layer2 = [
      ['listeners.kafka.port',            '9093',  '→ redpanda.yaml'],
      ['listeners.admin.port',            '9644',  '→ redpanda.yaml'],
      ['listeners.rpc.port',              '33145', '→ redpanda.yaml'],
      ['listeners.http.port',             '8082',  '→ redpanda.yaml (pandaproxy)'],
      ['listeners.schemaRegistry.port',   '8081',  '→ redpanda.yaml'],
      ['auth.sasl.enabled',               'true',  '→ kafka_api[].auth_method'],
      ['tls.enabled',                     'true',  '→ kafka_api_tls[]'],
      ['external.type',                   'NodePort','→ Service + advertised addr'],
    ].map(([k,v,d]) => row(k, v, d)).join('');

    const layer3 = [
      ['config.tunable.log_segment_size_min',  '16777216',  '→ Admin API (live)'],
      ['config.tunable.log_segment_size_max',  '268435456', '→ Admin API (live)'],
      ['config.tunable.compacted_log_segment_size', '67108864', '→ Admin API (live)'],
      ['config.cluster.kafka_batch_max_bytes', '1048576',   '→ Admin API (live)'],
    ].map(([k,v,d]) => row(k, v, d)).join('');

    const note = (text) =>
      `<div style="font-size:10px;color:var(--text-muted);margin:4px 0 6px;font-style:italic">${text}</div>`;

    return section('Config Layers', `<div style="${layerStyle}">
      <div style="${headerStyle}background:rgba(137,180,250,0.12);color:var(--blue,#89b4fa)">
        Layer 1 — Kubernetes objects (StatefulSet · PVC · Service)
      </div>
      ${note('Changes here trigger a StatefulSet rollout or PVC resize.')}
      ${layer1}

      <div style="${headerStyle}background:rgba(166,227,161,0.10);color:var(--green,#a6e3a1);margin-top:10px">
        Layer 2 — redpanda.yaml (broker config — requires pod restart)
      </div>
      ${note('Helm renders this into the cm-redpanda ConfigMap, mounted at /etc/redpanda/. Broker reads it once on startup.')}
      ${layer2}

      <div style="${headerStyle}background:rgba(250,179,135,0.10);color:var(--peach,#fab387);margin-top:10px">
        Layer 3 — Admin API (config.cluster / config.tunable — live, no restart)
      </div>
      ${note('Applied by the post-install Job via PUT /v1/cluster_config. configWatcher sidecar re-applies on CR changes.')}
      ${layer3}
    </div>`);
  }
}

// --- Helpers ---

function section(title, html) {
  return `<div class="panel-section"><div class="panel-section-title">${title}</div>${html}</div>`;
}

function metaTable(rows) {
  const trs = rows.map(([k, v]) =>
    `<tr><td>${k}</td><td>${escapeHTML(String(v))}</td></tr>`
  ).join('');
  return `<table class="meta-table"><tbody>${trs}</tbody></table>`;
}

function phaseDot(phase) {
  const colors = {
    Running: '#4caf82', Pending: '#f5a623', Terminating: '#9e9e9e',
    Failed: '#e05252', Succeeded: '#7986cb',
    ContainerCreating: '#f5a623', CrashLoopBackOff: '#e05252',
    ImagePullBackOff: '#ff7043', OOMKilled: '#e05252',
  };
  const c = colors[phase] || '#8899b4';
  return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c}"></span>`;
}

function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function containerRow(ct) {
  const roleColors = { init: '#f5a623', main: '#4caf82', sidecar: '#7c4dff' };
  const color = roleColors[ct.role] || '#8899b4';
  const ports = ct.ports?.length ? ` <span style="color:var(--text-muted);font-size:9px">${ct.ports.join(', ')}</span>` : '';
  const img = ct.image ? `<div style="font-size:9px;color:var(--text-muted);margin-top:1px;font-family:var(--mono)">${escapeHTML(ct.image)}</div>` : '';
  return `<div class="container-row">
    <span class="container-role-badge" style="background:${color}20;color:${color};border-color:${color}40">${ct.role}</span>
    <div>
      <span style="font-size:12px;font-weight:600">${escapeHTML(ct.name)}</span>${ports}
      ${img}
    </div>
  </div>`;
}
