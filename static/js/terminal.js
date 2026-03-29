// terminal.js — DOOM-style drop-down kubectl/helm terminal
// Toggle with ` (backtick) or ~ key. Escape to close.

import { api } from './api.js';

export class Terminal {
  constructor({ store }) {
    this._store = store;
    this._history = [];
    this._histIdx  = -1;
    this._el = null;
    this._input = null;
    this._output = null;
    this._open = false;
  }

  // ---- Public API ----

  mount() {
    const overlay = document.getElementById('terminal-overlay');
    if (!overlay) return;
    this._el     = overlay;
    this._input  = document.getElementById('terminal-input');
    this._output = document.getElementById('terminal-output');

    this._input.addEventListener('keydown', (e) => this._onKey(e));

    document.addEventListener('keydown', (e) => {
      if (e.key === '`' || e.key === '~') {
        // Don't hijack if user is typing in another input
        if (document.activeElement !== this._input) {
          e.preventDefault();
          this.toggle();
        }
      }
      if (e.key === 'Escape' && this._open) {
        this.close();
      }
    });

    this._println('k8sVisualizer terminal  —  type `help` for available commands', 'term-muted');
    this._println('', '');
  }

  toggle() { this._open ? this.close() : this.open(); }

  open() {
    this._open = true;
    this._el.classList.add('open');
    this._input?.focus();
  }

  close() {
    this._open = false;
    this._el.classList.remove('open');
    this._input?.blur();
  }

  // ---- Key handling ----

  _onKey(e) {
    if (e.key === 'Enter') {
      const cmd = this._input.value.trim();
      this._input.value = '';
      if (!cmd) return;
      this._history.unshift(cmd);
      if (this._history.length > 100) this._history.pop();
      this._histIdx = -1;
      this._println(`$ ${cmd}`, 'term-cmd');
      this._dispatch(cmd);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this._histIdx < this._history.length - 1) {
        this._histIdx++;
        this._input.value = this._history[this._histIdx] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this._histIdx > 0) {
        this._histIdx--;
        this._input.value = this._history[this._histIdx] || '';
      } else {
        this._histIdx = -1;
        this._input.value = '';
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this._autocomplete();
    }
  }

  // ---- Command dispatch ----

  _dispatch(raw) {
    const parts = raw.trim().split(/\s+/);
    const cmd = parts[0];
    try {
      switch (cmd) {
        case 'kubectl': this._kubectl(parts.slice(1)); break;
        case 'helm':    this._helm(parts.slice(1));    break;
        case 'help':    this._help();                  break;
        case 'clear':   this._clear();                 break;
        case 'history': this._showHistory();           break;
        default:
          this._println(`command not found: ${cmd}  (try 'help')`, 'term-error');
      }
    } catch (err) {
      this._println(`Error: ${err.message}`, 'term-error');
    }
  }

  // ---- kubectl ----

  _kubectl(args) {
    const sub = args[0];
    switch (sub) {
      case 'get':      this._kubectlGet(args.slice(1));      break;
      case 'describe': this._kubectlDescribe(args.slice(1)); break;
      case 'delete':   this._kubectlDelete(args.slice(1));   break;
      case 'scale':    this._kubectlScale(args.slice(1));    break;
      case 'logs':     this._kubectlLogs(args.slice(1));     break;
      default:
        this._println(`kubectl: unknown subcommand '${sub}'`, 'term-error');
        this._println(`  supported: get, describe, delete, scale, logs`, 'term-muted');
    }
  }

  // kubectl get <resource> [-n <ns>] [-A]
  _kubectlGet(args) {
    const { kind: rawKind, ns, all } = this._parseGetArgs(args);
    if (!rawKind) {
      this._println('Usage: kubectl get <pods|svc|deployments|statefulsets|daemonsets|configmaps|secrets|pvc|pv|nodes|namespaces|all>', 'term-error');
      return;
    }

    // ControlPlaneComponent nodes are static pods in real clusters (kubeadm)
    // Include them when the user queries pods so the behaviour matches reality.
    const CP_KIND = 'ControlPlaneComponent';

    const kindMap = {
      pod: 'Pod', pods: 'Pod',
      svc: 'Service', service: 'Service', services: 'Service',
      deploy: 'Deployment', deployment: 'Deployment', deployments: 'Deployment',
      sts: 'StatefulSet', statefulset: 'StatefulSet', statefulsets: 'StatefulSet',
      ds: 'DaemonSet', daemonset: 'DaemonSet', daemonsets: 'DaemonSet',
      rs: 'ReplicaSet', replicaset: 'ReplicaSet', replicasets: 'ReplicaSet',
      cm: 'ConfigMap', configmap: 'ConfigMap', configmaps: 'ConfigMap',
      secret: 'Secret', secrets: 'Secret',
      pvc: 'PersistentVolumeClaim', persistentvolumeclaim: 'PersistentVolumeClaim', persistentvolumeclaims: 'PersistentVolumeClaim',
      pv: 'PersistentVolume', persistentvolume: 'PersistentVolume', persistentvolumes: 'PersistentVolume',
      node: 'Node', nodes: 'Node',
      sa: 'ServiceAccount', serviceaccount: 'ServiceAccount', serviceaccounts: 'ServiceAccount',
      role: 'Role', roles: 'Role',
      clusterrole: 'ClusterRole', clusterroles: 'ClusterRole',
      rolebinding: 'RoleBinding', rolebindings: 'RoleBinding',
      clusterrolebinding: 'ClusterRoleBinding', clusterrolebindings: 'ClusterRoleBinding',
      hpa: 'HorizontalPodAutoscaler', horizontalpodautoscaler: 'HorizontalPodAutoscaler', horizontalpodautoscalers: 'HorizontalPodAutoscaler',
      ns: 'Namespace', namespace: 'Namespace', namespaces: 'Namespace',
      ingress: 'Ingress', ingresses: 'Ingress',
    };

    const targetKind = kindMap[rawKind.toLowerCase()];
    const isAll = rawKind.toLowerCase() === 'all' || rawKind === 'all';

    let nodes = Array.from(this._store.nodes.values());

    if (isAll) {
      if (!all && ns) nodes = nodes.filter(n => n.metadata?.namespace === ns);
      else if (!all) nodes = nodes.filter(n => n.metadata?.namespace && n.metadata?.namespace !== '');
    } else if (targetKind) {
      if (targetKind === 'Pod') {
        // Include ControlPlaneComponent nodes — they are static pods in kube-system
        nodes = nodes.filter(n => n.kind === 'Pod' || n.kind === CP_KIND);
      } else {
        nodes = nodes.filter(n => n.kind === targetKind);
      }
      const clusterScoped = ['PersistentVolume', 'Node', 'Namespace', 'ClusterRole', 'ClusterRoleBinding'];
      if (!clusterScoped.includes(targetKind)) {
        if (all) {
          // show all namespaces — no filter
        } else if (ns) {
          nodes = nodes.filter(n => n.metadata?.namespace === ns);
        }
      }
    } else {
      this._println(`error: the server doesn't have a resource type "${rawKind}"`, 'term-error');
      return;
    }

    if (nodes.length === 0) {
      this._println(`No resources found${ns ? ' in namespace ' + ns : ''}.`, 'term-muted');
      return;
    }

    this._printTable(targetKind || 'Resource', nodes, all, ns);
  }

  _printTable(kind, nodes, showAllNs, filterNs) {
    const isPod = kind === 'Pod';

    // Build row data first so we can compute column widths from content
    const rows = nodes.map(n => {
      const name   = n.metadata?.name || n.id || '';
      const ns     = n.metadata?.namespace || '';
      const status = this._nodeStatus(n);
      const ready  = isPod ? this._podReady(n) : null;
      return { name, ns, status, ready };
    });

    // Dynamic column widths: max(header, longest value) + 2 gap
    const w = {
      ns:   showAllNs ? Math.max(9,  ...rows.map(r => r.ns.length))   + 2 : 0,
      name:            Math.max(4,   ...rows.map(r => r.name.length))  + 2,
      ready: isPod   ? Math.max(5,   ...rows.map(r => r.ready.length)) + 2 : 0,
      status:          Math.max(6,   ...rows.map(r => r.status.length))+ 2,
    };

    // Build header — real kubectl order: [NAMESPACE] NAME [READY] STATUS RESTARTS AGE
    let header = '';
    if (showAllNs) header += this._pad('NAMESPACE', w.ns);
    header += this._pad('NAME', w.name);
    if (isPod)     header += this._pad('READY', w.ready) + this._pad('STATUS', w.status) + this._pad('RESTARTS', 10);
    else           header += this._pad('STATUS', w.status);
    header += 'AGE';
    this._println(header, 'term-header');

    for (const r of rows) {
      let line = '';
      if (showAllNs) line += this._pad(r.ns, w.ns);
      line += this._pad(r.name, w.name);
      if (isPod)     line += this._pad(r.ready, w.ready) + this._pad(r.status, w.status) + this._pad('0', 10);
      else           line += this._pad(r.status, w.status);
      line += '1d';

      const cls = r.status === 'Running' || r.status === 'Bound' || r.status === 'Active' ? 'term-prompt'
                : r.status === 'Pending' || r.status === 'Released'                        ? 'term-warn'
                : r.status === 'Failed'  || r.status === 'Terminating'                     ? 'term-error'
                : 'term-line';
      this._println(line, cls);
    }
  }

  _podReady(n) {
    const phase = n.simPhase || '';
    if (phase === 'Running')              return '1/1';
    if (phase === 'Terminating')          return '1/1';
    if (phase === 'Succeeded')            return '0/1';
    if (phase === 'Failed')               return '0/1';
    if (n.kind === 'ControlPlaneComponent') return '1/1';
    return '0/1';
  }

  _nodeStatus(n) {
    if (n.simPhase) return n.simPhase;
    try {
      const s = JSON.parse(n.status || '{}');
      if (s.phase) return s.phase;
    } catch {}
    if (n.kind === 'ControlPlaneComponent') return 'Running';
    if (n.kind === 'Node') return 'Ready';
    if (n.kind === 'ServiceAccount') return 'Active';
    if (n.kind === 'Role' || n.kind === 'ClusterRole') return 'Active';
    if (n.kind === 'RoleBinding' || n.kind === 'ClusterRoleBinding') return 'Active';
    if (n.kind === 'Namespace') return 'Active';
    if (n.kind === 'Service' || n.kind === 'ConfigMap' || n.kind === 'Secret') return 'Active';
    if (n.kind === 'Deployment' || n.kind === 'StatefulSet' || n.kind === 'DaemonSet') {
      try {
        const spec = JSON.parse(n.spec || '{}');
        return `${spec.replicas ?? 1}/${spec.replicas ?? 1}`;
      } catch {}
    }
    return 'Unknown';
  }

  // kubectl describe pod <name> [-n <ns>]
  _kubectlDescribe(args) {
    const { resource: rawRes, ns, name } = this._parseDescribeArgs(args);
    if (!rawRes || !name) {
      this._println('Usage: kubectl describe <pod|svc|deployment|sts|pvc> <name> [-n <ns>]', 'term-error');
      return;
    }

    const node = this._findNode(name, ns);
    if (!node) {
      this._println(`Error from server (NotFound): "${name}" not found`, 'term-error');
      return;
    }

    this._println(`Name:       ${node.metadata?.name || ''}`, 'term-line');
    this._println(`Namespace:  ${node.metadata?.namespace || '<cluster-scoped>'}`, 'term-line');
    this._println(`Kind:       ${node.kind}`, 'term-line');
    if (node.metadata?.labels && Object.keys(node.metadata.labels).length) {
      this._println(`Labels:     ${Object.entries(node.metadata.labels).map(([k,v]) => `${k}=${v}`).join(', ')}`, 'term-line');
    }
    const status = this._nodeStatus(node);
    this._println(`Status:     ${status}`, 'term-line');

    try {
      const spec = JSON.parse(node.spec || '{}');
      if (spec.replicas !== undefined) this._println(`Replicas:   ${spec.replicas}`, 'term-line');
      if (spec.type) this._println(`Type:       ${spec.type}`, 'term-line');
      if (spec.clusterIP) this._println(`ClusterIP:  ${spec.clusterIP}`, 'term-line');
      if (spec.ports?.length) {
        this._println(`Ports:      ${spec.ports.map(p => `${p.port}/${p.protocol||'TCP'}`).join(', ')}`, 'term-line');
      }
      if (spec.capacity) this._println(`Capacity:   ${spec.capacity}`, 'term-line');
      if (spec.requests) this._println(`Requests:   ${spec.requests}`, 'term-line');
      if (spec.initContainers?.length) {
        this._println(`Init Containers:`, 'term-header');
        for (const c of spec.initContainers) {
          this._println(`  ${c.name}: ${c.image || ''}`, 'term-line');
        }
      }
      if (spec.containers?.length) {
        this._println(`Containers:`, 'term-header');
        for (const c of spec.containers) {
          this._println(`  ${c.name}: ${c.image || ''}${c.ports?.length ? '  ports: ' + c.ports.join(',') : ''}`, 'term-line');
        }
      }
    } catch {}

    // Show edges
    const edges = this._store.edges ? Array.from(this._store.edges.values()) : [];
    const related = edges.filter(e => e.source === node.id || e.target === node.id);
    if (related.length) {
      this._println(`Relationships:`, 'term-header');
      for (const e of related) {
        const other = e.source === node.id ? e.target : e.source;
        const dir   = e.source === node.id ? '→' : '←';
        this._println(`  [${e.type}] ${dir} ${other}`, 'term-muted');
      }
    }
  }

  // kubectl delete pod <name> [-n <ns>]
  _kubectlDelete(args) {
    const { ns, name } = this._parseDescribeArgs(args);
    if (!name) {
      this._println('Usage: kubectl delete <kind> <name> [-n <ns>]', 'term-error');
      return;
    }
    const node = this._findNode(name, ns);
    if (!node) {
      this._println(`Error from server (NotFound): "${name}" not found`, 'term-error');
      return;
    }
    const displayName = node.metadata?.name || name;
    api.deleteResource(node.id)
      .then(() => this._println(`${node.kind.toLowerCase()} "${displayName}" deleted`, 'term-prompt'))
      .catch(err => this._println(`Error: ${err.message}`, 'term-error'));
  }

  // kubectl scale sts/redpanda --replicas=3 [-n <ns>]
  _kubectlScale(args) {
    // kubectl scale sts/<name> --replicas=N [-n <ns>]
    // also: kubectl scale deployment/<name> --replicas=N
    const target = args[0] || '';
    const replicasArg = args.find(a => a.startsWith('--replicas='));
    if (!target || !replicasArg) {
      this._println('Usage: kubectl scale (sts|deployment)/<name> --replicas=<N> [-n <ns>]', 'term-error');
      return;
    }
    const replicas = parseInt(replicasArg.split('=')[1], 10);
    if (isNaN(replicas) || replicas < 0) {
      this._println('Error: replicas must be a non-negative integer', 'term-error');
      return;
    }
    const slash = target.indexOf('/');
    const resourceName = slash >= 0 ? target.slice(slash + 1) : target;
    const ns = this._parseNs(args);

    const node = this._findNode(resourceName, ns);
    if (!node) {
      this._println(`Error from server (NotFound): "${resourceName}" not found`, 'term-error');
      return;
    }
    if (node.kind !== 'StatefulSet' && node.kind !== 'Deployment') {
      this._println(`Error: "${node.kind}" does not support scaling`, 'term-error');
      return;
    }

    api.scale(node.id, replicas)
      .then(() => this._println(`${node.kind.toLowerCase()}.apps/${resourceName} scaled`, 'term-prompt'))
      .catch(err => this._println(`Error: ${err.message}`, 'term-error'));
  }

  // kubectl logs <pod> [-n <ns>] [-c <container>]
  _kubectlLogs(args) {
    const ns = this._parseNs(args);
    const name = args.find(a => !a.startsWith('-'));
    if (!name) {
      this._println('Usage: kubectl logs <pod-name> [-n <ns>]', 'term-error');
      return;
    }
    const node = this._findNode(name, ns);
    if (!node) {
      this._println(`Error from server (NotFound): pods "${name}" not found`, 'term-error');
      return;
    }
    if (node.kind !== 'Pod') {
      this._println(`Error: "${node.kind}" is not a Pod`, 'term-error');
      return;
    }
    // Simulated logs
    const podName = node.metadata?.name || name;
    const phase = node.simPhase || 'Unknown';
    try {
      const spec = JSON.parse(node.spec || '{}');
      const ctrs = [...(spec.initContainers || []), ...(spec.containers || [])];
      if (ctrs.length === 0) {
        this._println(`[simulated] no containers defined for pod "${podName}"`, 'term-muted');
        return;
      }
      const ctr = ctrs[ctrs.length - 1];
      this._println(`[${podName}/${ctr.name}] Simulated log output (pod phase: ${phase})`, 'term-muted');
      if (phase === 'Running') {
        this._println(`[${podName}/${ctr.name}] INFO  started`, 'term-line');
        this._println(`[${podName}/${ctr.name}] INFO  listening on :9092`, 'term-line');
      } else if (phase === 'Pending') {
        this._println(`[${podName}/${ctr.name}] WARN  waiting for PVC to bind`, 'term-warn');
      } else if (phase === 'Failed') {
        this._println(`[${podName}/${ctr.name}] ERROR container exited with code 1`, 'term-error');
      } else {
        this._println(`[${podName}/${ctr.name}] (no logs available)`, 'term-muted');
      }
    } catch {
      this._println(`(no logs)`, 'term-muted');
    }
  }

  // ---- helm ----

  _helm(args) {
    const sub = args[0];
    switch (sub) {
      case 'list':      this._helmList(args.slice(1));      break;
      case 'install':   this._helmInstall(args.slice(1));   break;
      case 'uninstall': this._helmUninstall(args.slice(1)); break;
      case 'status':    this._helmStatus(args.slice(1));    break;
      default:
        this._println(`helm: unknown subcommand '${sub}'`, 'term-error');
        this._println(`  supported: list, install, uninstall, status`, 'term-muted');
    }
  }

  _helmList(args) {
    const nsFlag = this._parseNs(args);

    // Detect what's deployed based on nodes in the store
    const releases = [];
    const nodes = Array.from(this._store.nodes.values());

    const hasOperator = nodes.some(n => n.metadata?.namespace === 'redpanda-system');
    const hasRedpanda = nodes.some(n => n.metadata?.namespace === 'redpanda' && n.kind === 'StatefulSet');

    if (!nsFlag || nsFlag === 'redpanda-system') {
      if (hasOperator) releases.push({ name: 'redpanda-operator', ns: 'redpanda-system', chart: 'redpanda/operator', status: 'deployed' });
    }
    if (!nsFlag || nsFlag === 'redpanda') {
      if (hasRedpanda) releases.push({ name: 'redpanda', ns: 'redpanda', chart: 'redpanda/redpanda', status: 'deployed' });
    }

    if (releases.length === 0) {
      this._println('No releases found.', 'term-muted');
      return;
    }

    this._println(
      this._pad('NAME', 22) + this._pad('NAMESPACE', 18) + this._pad('STATUS', 12) + 'CHART',
      'term-header'
    );
    for (const r of releases) {
      this._println(this._pad(r.name, 22) + this._pad(r.ns, 18) + this._pad(r.status, 12) + r.chart, 'term-prompt');
    }
  }

  _helmInstall(args) {
    // helm install <release> <chart> [-n <ns>]
    const positional = args.filter(a => !a.startsWith('-'));
    const release = positional[0];
    const chart   = positional[1];
    if (!release || !chart) {
      this._println('Usage: helm install <release> <chart> [-n <ns>]', 'term-error');
      return;
    }

    const isRedpandaChart    = chart.includes('redpanda/redpanda') || chart === 'redpanda';
    const isOperatorChart    = chart.includes('redpanda/operator') || chart.includes('operator');

    if (isOperatorChart || isRedpandaChart) {
      this._println(`Installing ${chart} as release "${release}"…`, 'term-line');
      this._println(`Running scenario: redpanda-helm`, 'term-muted');
      api.runScenario('redpanda-helm')
        .catch(err => this._println(`Error: ${err.message}`, 'term-error'));
      this._println(`Release "${release}" install started (watch the graph and events panel)`, 'term-prompt');
    } else {
      this._println(`helm: chart "${chart}" not found in simulated repo`, 'term-error');
      this._println(`  available: redpanda/operator, redpanda/redpanda`, 'term-muted');
    }
  }

  _helmUninstall(args) {
    const release = args.find(a => !a.startsWith('-'));
    if (!release) {
      this._println('Usage: helm uninstall <release>', 'term-error');
      return;
    }
    if (release !== 'redpanda' && release !== 'redpanda-operator') {
      this._println(`Error: release "${release}" not found`, 'term-error');
      return;
    }
    api.uninstall(release)
      .then(() => this._println(`release "${release}" uninstalled`, 'term-prompt'))
      .catch(err => this._println(`Error: ${err.message}`, 'term-error'));
  }

  _helmStatus(args) {
    const release = args.find(a => !a.startsWith('-'));
    if (!release) {
      this._println('Usage: helm status <release>', 'term-error');
      return;
    }
    const nodes = Array.from(this._store.nodes.values());
    const nsMap = { 'redpanda-operator': 'redpanda-system', redpanda: 'redpanda' };
    const ns = nsMap[release];
    if (!ns) {
      this._println(`Error: release "${release}" not found`, 'term-error');
      return;
    }
    const count = nodes.filter(n => n.metadata?.namespace === ns).length;
    if (count === 0) {
      this._println(`Error: release "${release}" not found (no resources in namespace ${ns})`, 'term-error');
      return;
    }
    this._println(`NAME: ${release}`, 'term-line');
    this._println(`NAMESPACE: ${ns}`, 'term-line');
    this._println(`STATUS: deployed`, 'term-prompt');
    this._println(`RESOURCES: ${count} objects`, 'term-line');
  }

  // ---- help ----

  _help() {
    const cmds = [
      ['kubectl get', 'pods|svc|deployments|statefulsets|pvc|pv|all [-n <ns>] [-A]'],
      ['kubectl describe', '<kind> <name> [-n <ns>]'],
      ['kubectl delete', '<kind> <name> [-n <ns>]'],
      ['kubectl scale', '(sts|deployment)/<name> --replicas=N [-n <ns>]'],
      ['kubectl logs', '<pod> [-n <ns>]'],
      ['', ''],
      ['helm list', '[-n <ns>]'],
      ['helm install', '<release> <chart> [-n <ns>]'],
      ['helm uninstall', '<release>'],
      ['helm status', '<release>'],
      ['', ''],
      ['clear', 'Clear terminal output'],
      ['history', 'Show command history'],
      ['`, ~', 'Toggle terminal open/close'],
    ];
    this._println('Available commands:', 'term-header');
    for (const [cmd, desc] of cmds) {
      if (!cmd) { this._println('', ''); continue; }
      this._println(`  ${this._pad(cmd, 30)}${desc}`, 'term-line');
    }
  }

  // ---- helpers ----

  _parseGetArgs(args) {
    const kind = args.find(a => !a.startsWith('-')) || '';
    const ns   = this._parseNs(args);
    const all  = args.includes('-A') || args.includes('--all-namespaces');
    return { kind, ns, all };
  }

  _parseDescribeArgs(args) {
    const positional = args.filter(a => !a.startsWith('-'));
    const resource = positional[0] || '';
    const name     = positional[1] || '';
    const ns       = this._parseNs(args);
    return { resource, name, ns };
  }

  _parseNs(args) {
    const idx = args.findIndex(a => a === '-n' || a === '--namespace');
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
    const flag = args.find(a => a.startsWith('--namespace='));
    if (flag) return flag.split('=')[1];
    return '';
  }

  _findNode(name, ns) {
    for (const n of this._store.nodes.values()) {
      const nName = n.metadata?.name || '';
      const nNs   = n.metadata?.namespace || '';
      if (nName === name && (!ns || nNs === ns)) return n;
      if (n.id === name) return n;
    }
    return null;
  }

  _pad(str, len) {
    return (str || '').padEnd(len, ' ');
  }

  _println(text, cls) {
    if (!this._output) return;
    const div = document.createElement('div');
    div.className = `term-line${cls ? ' ' + cls : ''}`;
    div.textContent = text;
    this._output.appendChild(div);
    this._output.scrollTop = this._output.scrollHeight;
  }

  _clear() {
    if (this._output) this._output.innerHTML = '';
  }

  _showHistory() {
    if (this._history.length === 0) {
      this._println('(no history)', 'term-muted');
      return;
    }
    [...this._history].reverse().forEach((cmd, i) => {
      this._println(`  ${String(i + 1).padStart(3)}  ${cmd}`, 'term-line');
    });
  }

  _autocomplete() {
    const val = this._input?.value || '';
    const parts = val.split(/\s+/);
    if (parts.length === 1) {
      const cmds = ['kubectl', 'helm', 'help', 'clear', 'history'];
      const matches = cmds.filter(c => c.startsWith(val));
      if (matches.length === 1) this._input.value = matches[0] + ' ';
    }
  }
}
