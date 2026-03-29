// controls.js — wires toolbar, namespace pills, kind filters, zoom buttons

import { api } from './api.js';

export class Controls {
  constructor({ store, graph, simulation, interaction }) {
    this._store = store;
    this._graph = graph;
    this._sim = simulation;
    this._interaction = interaction;
    this._editingNode = null;
  }

  async init() {
    this._bindVersionPicker();
    this._bindToolbar();
    this._bindZoomButtons();
    this._bindCreateModal();
    this._refreshNamespacePills();
    this._refreshKindFilters();
    this._refreshStats();

    // Re-render namespace pills + stats when store changes
    this._store.subscribe((type) => {
      if (type === 'snapshot' || type === 'node') {
        this._refreshNamespacePills();
        this._refreshKindFilters();
        this._refreshStats();
      }
      if (type === 'snapshot') {
        this._refreshStats();
      }
    });
  }

  _bindVersionPicker() {
    const sel = document.getElementById('version-select');
    if (!sel) return;

    // Populate versions
    api.listVersions().then(versions => {
      sel.innerHTML = '';
      for (const v of versions) {
        const opt = document.createElement('option');
        opt.value = v.version;
        opt.textContent = `K8s ${v.version}${v.isDefault ? ' ✓' : ''}`;
        if (v.isDefault) opt.selected = true;
        sel.appendChild(opt);
      }
      // Sync to current active version
      if (this._store.version) sel.value = this._store.version;
    }).catch(console.error);

    // Store version sync
    this._store.subscribe((type) => {
      if ((type === 'snapshot') && this._store.version) {
        sel.value = this._store.version;
      }
    });

    sel.addEventListener('change', async () => {
      const ver = sel.value;
      try {
        await api.setVersion(ver);
        // The server will push a version.changed SSE event with full snapshot
      } catch (e) {
        console.error('Failed to set version:', e);
        sel.value = this._store.version; // revert
      }
    });
  }

  _bindToolbar() {
    document.getElementById('btn-reset')?.addEventListener('click', async () => {
      try { await api.reset(); } catch (e) { console.error(e); }
    });

    document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
      this._interaction.zoomToFit(this._sim.getPositions());
    });

    document.getElementById('btn-create')?.addEventListener('click', () => {
      this.openCreateModal();
    });

    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn) {
      // Restore saved theme
      const saved = localStorage.getItem('k8s-theme');
      if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        themeBtn.textContent = '🌙 Dark';
      }
      themeBtn.addEventListener('click', () => {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        if (isLight) {
          document.documentElement.removeAttribute('data-theme');
          themeBtn.textContent = '☀ Light';
          localStorage.setItem('k8s-theme', 'dark');
        } else {
          document.documentElement.setAttribute('data-theme', 'light');
          themeBtn.textContent = '🌙 Dark';
          localStorage.setItem('k8s-theme', 'light');
        }
      });
    }
  }

  _bindZoomButtons() {
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => this._interaction.zoomIn());
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => this._interaction.zoomOut());
    document.getElementById('btn-zoom-reset')?.addEventListener('click', () => this._interaction.resetZoom());
  }

  _bindCreateModal() {
    // Tab switching
    document.getElementById('tab-btn-form')?.addEventListener('click', () => this._switchModalTab('form'));
    document.getElementById('tab-btn-yaml')?.addEventListener('click', () => this._switchModalTab('yaml'));

    // Rebuild form when kind changes (create mode only)
    document.getElementById('resource-modal-kind')?.addEventListener('change', (e) => {
      this._buildFormForKind(e.target.value, null);
    });

    // Close on backdrop click
    document.getElementById('resource-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'resource-modal') this._closeModal();
    });

    document.getElementById('resource-modal-cancel')?.addEventListener('click', () => this._closeModal());

    document.getElementById('resource-modal-submit')?.addEventListener('click', async () => {
      const onYamlTab = document.getElementById('resource-modal-yaml').style.display !== 'none';
      const kind = this._editingNode
        ? this._editingNode.kind
        : (document.getElementById('resource-modal-kind').value || 'Deployment');

      let node;
      if (onYamlTab) {
        const yamlText = document.getElementById('resource-yaml-editor').value;
        try { node = parseYAML(yamlText); } catch (e) { alert('YAML parse error: ' + e.message); return; }
        if (!node.kind) node.kind = kind;
        if (!node.apiVersion) node.apiVersion = defaultAPIVersion(kind);
      } else {
        node = this._readFormData(kind);
      }

      if (!node.metadata?.name) { alert('Name is required'); return; }

      const submitBtn = document.getElementById('resource-modal-submit');
      const origLabel = submitBtn.textContent;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      try {
        if (this._editingNode) {
          await api.updateResource(this._editingNode.id, node);
        } else {
          await api.createResource(node);
        }
        this._closeModal();
      } catch (e) {
        alert('Error: ' + e.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = origLabel;
      }
    });

    // Build initial form
    this._buildFormForKind('Deployment', null);
  }

  _closeModal() {
    document.getElementById('resource-modal').style.display = 'none';
  }

  openCreateModal() {
    this._editingNode = null;
    document.getElementById('resource-modal-title').textContent = 'Create Resource';
    document.getElementById('resource-modal-submit').textContent = 'Create';
    document.getElementById('resource-modal-kind-row').style.display = '';
    const kind = document.getElementById('resource-modal-kind')?.value || 'Deployment';
    this._buildFormForKind(kind, null);
    this._switchModalTab('form');
    document.getElementById('resource-modal').style.display = 'flex';
  }

  openEditModal(node) {
    this._editingNode = node;
    const name = node.metadata?.name || node.id;
    document.getElementById('resource-modal-title').textContent = `Edit ${node.kind}: ${name}`;
    document.getElementById('resource-modal-submit').textContent = 'Save';
    document.getElementById('resource-modal-kind-row').style.display = 'none';
    this._buildFormForKind(node.kind, node);
    this._switchModalTab('form');
    document.getElementById('resource-modal').style.display = 'flex';
  }

  _switchModalTab(tab) {
    const formBody = document.getElementById('resource-modal-form');
    const yamlBody = document.getElementById('resource-modal-yaml');
    const formTab  = document.getElementById('tab-btn-form');
    const yamlTab  = document.getElementById('tab-btn-yaml');
    if (tab === 'yaml') {
      const kind = this._editingNode
        ? this._editingNode.kind
        : (document.getElementById('resource-modal-kind')?.value || 'Deployment');
      const node = this._readFormData(kind);
      document.getElementById('resource-yaml-editor').value = toYAML(node);
      formBody.style.display = 'none';
      yamlBody.style.display = '';
      formTab?.classList.remove('active');
      yamlTab?.classList.add('active');
    } else {
      formBody.style.display = '';
      yamlBody.style.display = 'none';
      formTab?.classList.add('active');
      yamlTab?.classList.remove('active');
    }
  }

  _buildFormForKind(kind, node) {
    const formBody = document.getElementById('resource-modal-form');
    if (!formBody) return;

    const meta = node?.metadata || {};
    const spec = node?.spec || {};
    const isClusterScoped = CLUSTER_SCOPED.has(kind);
    const labelsStr = Object.entries(meta.labels || {}).map(([k, v]) => `${k}=${v}`).join(', ');

    let html = `
      <div class="form-row">
        <label>Name</label>
        <input type="text" id="rm-name" placeholder="my-${kind.toLowerCase()}" value="${esc(meta.name || '')}">
      </div>`;

    if (!isClusterScoped) {
      html += `
      <div class="form-row">
        <label>Namespace</label>
        <input type="text" id="rm-namespace" placeholder="default" value="${esc(meta.namespace || 'default')}">
      </div>`;
    }

    html += `
      <div class="form-row">
        <label>Labels <span class="form-hint">key=value, comma-separated</span></label>
        <input type="text" id="rm-labels" placeholder="app=my-app, env=dev" value="${esc(labelsStr)}">
      </div>`;

    html += kindFormFields(kind, spec, node);
    formBody.innerHTML = html;
    bindFormDynamics(kind);
  }

  _readFormData(kind) {
    const name      = document.getElementById('rm-name')?.value.trim() || '';
    const namespace = document.getElementById('rm-namespace')?.value.trim() || 'default';
    const labelsRaw = document.getElementById('rm-labels')?.value.trim() || '';
    const labels    = parseLabels(labelsRaw);

    const meta = { name, namespace, labels };
    if (CLUSTER_SCOPED.has(kind)) delete meta.namespace;

    return {
      kind,
      apiVersion: defaultAPIVersion(kind),
      metadata: meta,
      spec: readSpecForKind(kind),
    };
  }

  _refreshNamespacePills() {
    const container = document.getElementById('ns-pills');
    if (!container) return;

    const namespaces = this._store.allNamespaces();
    const current = this._store.selectedNamespace;
    container.innerHTML = '';

    const allPill = document.createElement('button');
    allPill.className = `ns-pill all${current === '' ? ' active' : ''}`;
    allPill.dataset.ns = '';
    allPill.textContent = 'All';
    allPill.addEventListener('click', () => this._selectNamespace('', allPill));
    container.appendChild(allPill);

    for (const ns of namespaces) {
      const pill = document.createElement('button');
      pill.className = `ns-pill${current === ns ? ' active' : ''}`;
      pill.dataset.ns = ns;
      pill.textContent = ns;
      pill.addEventListener('click', () => this._selectNamespace(ns, pill));
      container.appendChild(pill);
    }
  }

  _selectNamespace(ns, pill) {
    this._store.selectedNamespace = ns;
    document.querySelectorAll('.ns-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    this._store._notify('snapshot'); // trigger re-render
  }

  _refreshKindFilters() {
    const container = document.getElementById('kind-filter-list');
    if (!container) return;
    const kinds = this._store.allKinds();
    const current = this._store.hiddenKinds;

    container.innerHTML = '';
    for (const kind of kinds) {
      const item = document.createElement('div');
      item.className = 'kind-filter-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.id = `kf-${kind}`;
      cb.checked = !current.has(kind);
      cb.addEventListener('change', () => {
        if (cb.checked) current.delete(kind);
        else current.add(kind);
        this._store._notify('snapshot');
      });
      const lbl = document.createElement('label');
      lbl.htmlFor = `kf-${kind}`;
      lbl.textContent = kind;
      item.appendChild(cb);
      item.appendChild(lbl);
      container.appendChild(item);
    }
  }

  _refreshStats() {
    const s = this._store.stats();
    document.getElementById('stat-nodes').textContent = s.nodes;
    document.getElementById('stat-edges').textContent = s.edges;
    document.getElementById('stat-pods').textContent  = s.pods;
    document.getElementById('stat-running').textContent = s.running;
  }
}

// ── Constants ──────────────────────────────────────────────────────────────

const CLUSTER_SCOPED = new Set(['PersistentVolume', 'ClusterRole', 'ClusterRoleBinding', 'Node']);

function defaultAPIVersion(kind) {
  const map = {
    Deployment: 'apps/v1', StatefulSet: 'apps/v1', DaemonSet: 'apps/v1', ReplicaSet: 'apps/v1',
    Pod: 'v1', Service: 'v1', ConfigMap: 'v1', Secret: 'v1', ServiceAccount: 'v1',
    PersistentVolumeClaim: 'v1', PersistentVolume: 'v1',
    Ingress: 'networking.k8s.io/v1',
    HorizontalPodAutoscaler: 'autoscaling/v2',
    Role: 'rbac.authorization.k8s.io/v1', ClusterRole: 'rbac.authorization.k8s.io/v1',
    RoleBinding: 'rbac.authorization.k8s.io/v1', ClusterRoleBinding: 'rbac.authorization.k8s.io/v1',
  };
  return map[kind] || 'v1';
}

// ── Kind-specific form HTML ─────────────────────────────────────────────────

function kindFormFields(kind, spec, node) {
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet': {
      const ctrs   = spec.template?.spec?.containers || spec.containers || [];
      const ctr    = ctrs[0] || {};
      const image  = ctr.image || '';
      const cport  = ctr.ports?.[0]?.containerPort || '';
      const cpuReq = ctr.resources?.requests?.cpu || '';
      const memReq = ctr.resources?.requests?.memory || '';
      const cpuLim = ctr.resources?.limits?.cpu || '';
      const memLim = ctr.resources?.limits?.memory || '';
      return `
        <div class="form-section-title">Container</div>
        <div class="form-row">
          <label>Image</label>
          <input type="text" id="rm-image" placeholder="nginx:latest" value="${esc(image)}">
        </div>
        <div class="form-row-2col">
          <div class="form-row">
            <label>Replicas</label>
            <input type="number" id="rm-replicas" min="0" placeholder="1" value="${esc(String(spec.replicas ?? 1))}">
          </div>
          <div class="form-row">
            <label>Container Port</label>
            <input type="number" id="rm-cport" placeholder="80" value="${esc(String(cport))}">
          </div>
        </div>
        <div class="form-section-title">Resources <span class="form-hint">(optional)</span></div>
        <div class="form-row-2col">
          <div class="form-row">
            <label>CPU Request</label>
            <input type="text" id="rm-cpu-req" placeholder="100m" value="${esc(cpuReq)}">
          </div>
          <div class="form-row">
            <label>CPU Limit</label>
            <input type="text" id="rm-cpu-lim" placeholder="500m" value="${esc(cpuLim)}">
          </div>
        </div>
        <div class="form-row-2col">
          <div class="form-row">
            <label>Memory Request</label>
            <input type="text" id="rm-mem-req" placeholder="128Mi" value="${esc(memReq)}">
          </div>
          <div class="form-row">
            <label>Memory Limit</label>
            <input type="text" id="rm-mem-lim" placeholder="512Mi" value="${esc(memLim)}">
          </div>
        </div>`;
    }

    case 'Service': {
      const svcType   = spec.type || 'ClusterIP';
      const ports     = spec.ports?.[0] || {};
      const selectorStr = Object.entries(spec.selector || {}).map(([k, v]) => `${k}=${v}`).join(', ');
      return `
        <div class="form-section-title">Service</div>
        <div class="form-row">
          <label>Type</label>
          <select id="rm-svc-type">
            ${['ClusterIP','NodePort','LoadBalancer','ExternalName'].map(t =>
              `<option${t === svcType ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-row-2col">
          <div class="form-row">
            <label>Port</label>
            <input type="number" id="rm-svc-port" placeholder="80" value="${esc(String(ports.port || ''))}">
          </div>
          <div class="form-row">
            <label>Target Port</label>
            <input type="number" id="rm-svc-tport" placeholder="8080" value="${esc(String(ports.targetPort || ''))}">
          </div>
        </div>
        <div class="form-row" id="rm-nodeport-row" style="${svcType === 'NodePort' ? '' : 'display:none'}">
          <label>Node Port <span class="form-hint">30000–32767</span></label>
          <input type="number" id="rm-nodeport" placeholder="30080" value="${esc(String(ports.nodePort || ''))}">
        </div>
        <div class="form-row">
          <label>Selector <span class="form-hint">key=value, comma-separated — pods this Service routes to</span></label>
          <input type="text" id="rm-selector" placeholder="app=my-app" value="${esc(selectorStr)}">
        </div>`;
    }

    case 'ConfigMap': {
      const dataStr = Object.entries(spec.data || node?.data || {}).map(([k, v]) => `${k}=${v}`).join('\n');
      return `
        <div class="form-section-title">Data</div>
        <div class="form-row">
          <label>Entries <span class="form-hint">one key=value per line</span></label>
          <textarea id="rm-cm-data" rows="7" placeholder="DATABASE_URL=postgres://localhost/mydb\nLOG_LEVEL=info\nMAX_CONN=10">${escHTML(dataStr)}</textarea>
        </div>`;
    }

    case 'Secret': {
      const secType = spec.type || 'Opaque';
      const dataStr = Object.entries(spec.data || node?.data || {}).map(([k, v]) => `${k}=${v}`).join('\n');
      return `
        <div class="form-section-title">Secret</div>
        <div class="form-row">
          <label>Type</label>
          <select id="rm-secret-type">
            ${['Opaque','kubernetes.io/dockerconfigjson','kubernetes.io/tls','kubernetes.io/service-account-token'].map(t =>
              `<option${t === secType ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>Data <span class="form-hint">key=value per line — values stored as plain text in simulator</span></label>
          <textarea id="rm-secret-data" rows="5" placeholder="username=admin\npassword=s3cr3t\napi-key=abc123">${escHTML(dataStr)}</textarea>
        </div>`;
    }

    case 'PersistentVolumeClaim': {
      const size = spec.resources?.requests?.storage || spec.requests || '1Gi';
      const mode = spec.accessModes?.[0] || 'ReadWriteOnce';
      const cls  = spec.storageClassName || '';
      return `
        <div class="form-section-title">Storage</div>
        <div class="form-row-2col">
          <div class="form-row">
            <label>Size</label>
            <input type="text" id="rm-pvc-size" placeholder="1Gi" value="${esc(String(size))}">
          </div>
          <div class="form-row">
            <label>Access Mode</label>
            <select id="rm-pvc-access">
              ${['ReadWriteOnce','ReadWriteMany','ReadOnlyMany'].map(m =>
                `<option${m === mode ? ' selected' : ''}>${m}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <label>Storage Class <span class="form-hint">leave blank for cluster default</span></label>
          <input type="text" id="rm-pvc-class" placeholder="standard" value="${esc(cls)}">
        </div>`;
    }

    case 'PersistentVolume': {
      const cap     = spec.capacity?.storage || String(spec.capacity || '1Gi');
      const mode    = spec.accessModes?.[0] || 'ReadWriteOnce';
      const reclaim = spec.persistentVolumeReclaimPolicy || spec.reclaimPolicy || 'Retain';
      const hp      = spec.hostPath?.path || '';
      return `
        <div class="form-section-title">Storage</div>
        <div class="form-row-2col">
          <div class="form-row">
            <label>Capacity</label>
            <input type="text" id="rm-pv-cap" placeholder="1Gi" value="${esc(cap)}">
          </div>
          <div class="form-row">
            <label>Access Mode</label>
            <select id="rm-pv-access">
              ${['ReadWriteOnce','ReadWriteMany','ReadOnlyMany'].map(m =>
                `<option${m === mode ? ' selected' : ''}>${m}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <label>Reclaim Policy</label>
          <select id="rm-pv-reclaim">
            ${['Retain','Recycle','Delete'].map(r =>
              `<option${r === reclaim ? ' selected' : ''}>${r}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>Host Path <span class="form-hint">optional — for local storage volumes</span></label>
          <input type="text" id="rm-pv-hostpath" placeholder="/data/my-volume" value="${esc(hp)}">
        </div>`;
    }

    case 'Ingress': {
      const rules   = spec.rules || [];
      const rule    = rules[0] || {};
      return `
        <div class="form-section-title">Routing Rule</div>
        <div class="form-row">
          <label>Host <span class="form-hint">leave blank to match all hosts</span></label>
          <input type="text" id="rm-ingress-host" placeholder="app.example.com" value="${esc(rule.host || '')}">
        </div>
        <div class="form-row-2col">
          <div class="form-row">
            <label>Path</label>
            <input type="text" id="rm-ingress-path" placeholder="/" value="${esc(rule.path || '/')}">
          </div>
          <div class="form-row">
            <label>Backend Port</label>
            <input type="number" id="rm-ingress-port" placeholder="80" value="${esc(String(rule.port || 80))}">
          </div>
        </div>
        <div class="form-row">
          <label>Backend Service <span class="form-hint">Service name to route traffic to</span></label>
          <input type="text" id="rm-ingress-svc" placeholder="my-service" value="${esc(rule.serviceID || '')}">
        </div>`;
    }

    case 'ServiceAccount':
      return ''; // Only common fields (name + namespace)

    default:
      return `<div style="font-size:12px;color:var(--text-muted);padding:8px 0">No additional fields for ${kind}. Use the YAML tab for full control.</div>`;
  }
}

// ── Read form → spec object ────────────────────────────────────────────────

function readSpecForKind(kind) {
  switch (kind) {
    case 'Deployment':
    case 'StatefulSet': {
      const image    = document.getElementById('rm-image')?.value.trim() || '';
      const cport    = parseInt(document.getElementById('rm-cport')?.value, 10) || 0;
      const replicas = parseInt(document.getElementById('rm-replicas')?.value, 10) ?? 1;
      const cpuReq   = document.getElementById('rm-cpu-req')?.value.trim();
      const cpuLim   = document.getElementById('rm-cpu-lim')?.value.trim();
      const memReq   = document.getElementById('rm-mem-req')?.value.trim();
      const memLim   = document.getElementById('rm-mem-lim')?.value.trim();
      const resources = {};
      if (cpuReq || memReq) {
        resources.requests = {};
        if (cpuReq) resources.requests.cpu = cpuReq;
        if (memReq) resources.requests.memory = memReq;
      }
      if (cpuLim || memLim) {
        resources.limits = {};
        if (cpuLim) resources.limits.cpu = cpuLim;
        if (memLim) resources.limits.memory = memLim;
      }
      const ctr = { name: 'app', image };
      if (cport) ctr.ports = [{ containerPort: cport }];
      if (Object.keys(resources).length) ctr.resources = resources;
      return {
        replicas,
        selector: { matchLabels: {} },
        template: { spec: { containers: [ctr] } },
      };
    }
    case 'Service': {
      const type     = document.getElementById('rm-svc-type')?.value || 'ClusterIP';
      const port     = parseInt(document.getElementById('rm-svc-port')?.value, 10) || 80;
      const tport    = parseInt(document.getElementById('rm-svc-tport')?.value, 10) || port;
      const nodePort = parseInt(document.getElementById('rm-nodeport')?.value, 10) || 0;
      const selRaw   = document.getElementById('rm-selector')?.value.trim() || '';
      const portObj  = { port, targetPort: tport, protocol: 'TCP' };
      if (type === 'NodePort' && nodePort) portObj.nodePort = nodePort;
      return { type, ports: [portObj], selector: parseLabels(selRaw) };
    }
    case 'ConfigMap': {
      const raw = document.getElementById('rm-cm-data')?.value || '';
      return { data: parseKVLines(raw) };
    }
    case 'Secret': {
      const type = document.getElementById('rm-secret-type')?.value || 'Opaque';
      const raw  = document.getElementById('rm-secret-data')?.value || '';
      return { type, data: parseKVLines(raw) };
    }
    case 'PersistentVolumeClaim': {
      const size = document.getElementById('rm-pvc-size')?.value.trim() || '1Gi';
      const mode = document.getElementById('rm-pvc-access')?.value || 'ReadWriteOnce';
      const cls  = document.getElementById('rm-pvc-class')?.value.trim();
      const spec = { accessModes: [mode], resources: { requests: { storage: size } } };
      if (cls) spec.storageClassName = cls;
      return spec;
    }
    case 'PersistentVolume': {
      const cap     = document.getElementById('rm-pv-cap')?.value.trim() || '1Gi';
      const mode    = document.getElementById('rm-pv-access')?.value || 'ReadWriteOnce';
      const reclaim = document.getElementById('rm-pv-reclaim')?.value || 'Retain';
      const hp      = document.getElementById('rm-pv-hostpath')?.value.trim();
      const spec    = { capacity: { storage: cap }, accessModes: [mode], persistentVolumeReclaimPolicy: reclaim };
      if (hp) spec.hostPath = { path: hp };
      return spec;
    }
    case 'Ingress': {
      const host  = document.getElementById('rm-ingress-host')?.value.trim() || '';
      const path  = document.getElementById('rm-ingress-path')?.value.trim() || '/';
      const svc   = document.getElementById('rm-ingress-svc')?.value.trim() || '';
      const iport = parseInt(document.getElementById('rm-ingress-port')?.value, 10) || 80;
      return { rules: [{ host, path, serviceID: svc, port: iport }] };
    }
    default:
      return {};
  }
}

// ── Dynamic form behaviors ─────────────────────────────────────────────────

function bindFormDynamics(kind) {
  if (kind === 'Service') {
    const svcType    = document.getElementById('rm-svc-type');
    const nodePortRow = document.getElementById('rm-nodeport-row');
    svcType?.addEventListener('change', () => {
      if (nodePortRow) nodePortRow.style.display = svcType.value === 'NodePort' ? '' : 'none';
    });
  }
}

// ── YAML serializer ────────────────────────────────────────────────────────

function toYAML(val, indent = 0) {
  if (val === null || val === undefined) return '';
  const pad = '  '.repeat(indent);

  if (Array.isArray(val)) {
    if (val.length === 0) return `${pad}[]`;
    const lines = [];
    for (const item of val) {
      if (item === null || item === undefined) { lines.push(`${pad}- null`); continue; }
      if (typeof item !== 'object') { lines.push(`${pad}- ${scalar(item)}`); continue; }
      const entries = Object.entries(item).filter(([, v]) => v !== null && v !== undefined);
      if (entries.length === 0) { lines.push(`${pad}- {}`); continue; }
      let first = true;
      for (const [k, v] of entries) {
        const pfx = first ? `${pad}- ` : `${pad}  `;
        first = false;
        if (Array.isArray(v)) {
          if (v.length === 0) { lines.push(`${pfx}${k}: []`); }
          else { lines.push(`${pfx}${k}:`); lines.push(toYAML(v, indent + 2)); }
        } else if (v !== null && typeof v === 'object') {
          const inner = toYAML(v, indent + 2);
          if (inner) { lines.push(`${pfx}${k}:`); lines.push(inner); }
          else lines.push(`${pfx}${k}: {}`);
        } else {
          lines.push(`${pfx}${k}: ${scalar(v)}`);
        }
      }
    }
    return lines.join('\n');
  }

  if (typeof val === 'object') {
    const lines = [];
    for (const [k, v] of Object.entries(val)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        if (v.length === 0) lines.push(`${pad}${k}: []`);
        else { lines.push(`${pad}${k}:`); lines.push(toYAML(v, indent + 1)); }
      } else if (typeof v === 'object') {
        const inner = toYAML(v, indent + 1);
        if (inner) { lines.push(`${pad}${k}:`); lines.push(inner); }
        else lines.push(`${pad}${k}: {}`);
      } else {
        lines.push(`${pad}${k}: ${scalar(v)}`);
      }
    }
    return lines.join('\n');
  }

  return scalar(val);
}

function scalar(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Quote strings that would be ambiguous in YAML
  if (s === '' || s === 'true' || s === 'false' || s === 'null' || /: /.test(s) ||
      s.startsWith('- ') || s.startsWith('{') || s.startsWith('[')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

// ── YAML parser (minimal, handles the YAML we generate) ──────────────────

function parseYAML(text) {
  const lines = text.split('\n');
  let pos = 0;

  function skipBlanks() {
    while (pos < lines.length && (!lines[pos].trim() || lines[pos].trim().startsWith('#'))) pos++;
  }

  function peekIndent() {
    const i = pos;
    skipBlanks();
    const ind = pos < lines.length ? lines[pos].search(/\S/) : -1;
    pos = i;
    return ind;
  }

  function parseBlock(baseIndent) {
    skipBlanks();
    if (pos >= lines.length) return {};
    const firstTrimmed = lines[pos].trim();
    if (firstTrimmed.startsWith('- ')) return parseSeq(baseIndent);
    return parseMap(baseIndent);
  }

  function parseMap(baseIndent) {
    const obj = {};
    while (pos < lines.length) {
      skipBlanks();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const ind  = line.search(/\S/);
      if (ind < baseIndent) break;
      const tr   = line.trim();
      if (tr.startsWith('- ')) break;
      const ci   = tr.indexOf(':');
      if (ci < 0) { pos++; continue; }
      const key  = tr.slice(0, ci).trim();
      const rest = tr.slice(ci + 1).trim();
      pos++;
      if (rest === '' || rest === '|' || rest === '>') {
        skipBlanks();
        if (pos < lines.length) {
          const childInd = lines[pos].search(/\S/);
          if (childInd > ind) {
            obj[key] = parseBlock(childInd);
          } else {
            obj[key] = {};
          }
        } else {
          obj[key] = {};
        }
      } else if (rest === '[]') {
        obj[key] = [];
      } else if (rest === '{}') {
        obj[key] = {};
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  function parseSeq(baseIndent) {
    const arr = [];
    while (pos < lines.length) {
      skipBlanks();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const ind  = line.search(/\S/);
      if (ind < baseIndent) break;
      const tr   = line.trim();
      if (!tr.startsWith('- ')) break;
      const rest = tr.slice(2).trim();
      const ci   = rest.indexOf(':');
      pos++;
      if (!rest || rest === '{}') {
        arr.push({});
      } else if (ci > 0 && !rest.startsWith('"') && !rest.startsWith("'")) {
        // Map item — first key inline
        const k = rest.slice(0, ci).trim();
        const v = rest.slice(ci + 1).trim();
        const obj = {};
        obj[k] = v ? parseScalar(v) : {};
        // Continuation keys at ind+2
        const contInd = ind + 2;
        while (pos < lines.length) {
          skipBlanks();
          if (pos >= lines.length) break;
          const cl = lines[pos];
          const ci2 = cl.search(/\S/);
          if (ci2 < contInd) break;
          if (cl.trim().startsWith('- ')) break;
          const ct = cl.trim();
          const cc = ct.indexOf(':');
          if (cc < 0) { pos++; continue; }
          const ck = ct.slice(0, cc).trim();
          const cv = ct.slice(cc + 1).trim();
          pos++;
          if (cv === '' || cv === '|' || cv === '>') {
            skipBlanks();
            if (pos < lines.length) {
              const ni = lines[pos].search(/\S/);
              if (ni > ci2) obj[ck] = parseBlock(ni);
              else obj[ck] = {};
            }
          } else if (cv === '[]') obj[ck] = [];
          else if (cv === '{}') obj[ck] = {};
          else obj[ck] = parseScalar(cv);
        }
        arr.push(obj);
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  function parseScalar(s) {
    if (!s || s === 'null' || s === '~') return null;
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\'/g, "'");
    }
    return s;
  }

  return parseBlock(0);
}

// ── Form helpers ───────────────────────────────────────────────────────────

function parseLabels(raw) {
  const out = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

function parseKVLines(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
