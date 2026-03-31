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
      case 'top':      this._kubectlTop(args.slice(1));      break;
      case 'rollout':  this._kubectlRollout(args.slice(1));  break;
      case 'exec':     this._kubectlExec(args.slice(1));     break;
      case 'cordon':   this._kubectlCordon(args.slice(1), true);  break;
      case 'uncordon': this._kubectlCordon(args.slice(1), false); break;
      case 'label':    this._kubectlLabel(args.slice(1));    break;
      case 'annotate': this._kubectlAnnotate(args.slice(1)); break;
      case 'taint':    this._kubectlTaint(args.slice(1));    break;
      default:
        this._println(`kubectl: unknown subcommand '${sub}'`, 'term-error');
        this._println(`  supported: get, describe, delete, scale, logs, top, rollout, exec, cordon, uncordon, label, annotate, taint`, 'term-muted');
    }
  }

  // kubectl get <resource> [-n <ns>] [-A]
  _kubectlGet(args) {
    const { kind: rawKind, ns, all } = this._parseGetArgs(args);
    if (!rawKind) {
      this._println('Usage: kubectl get <pods|svc|deployments|statefulsets|daemonsets|configmaps|secrets|pvc|pv|nodes|namespaces|all>', 'term-error');
      return;
    }

    // Parse -o yaml / -o json / --output=yaml / --output=json
    const outFlagIdx = args.findIndex(a => a === '-o' || a === '--output');
    let outputFormat = null;
    if (outFlagIdx !== -1 && args[outFlagIdx + 1]) {
      outputFormat = args[outFlagIdx + 1]; // 'yaml' or 'json'
    } else {
      const oEq = args.find(a => a.startsWith('-o=') || a.startsWith('--output='));
      if (oEq) outputFormat = oEq.split('=')[1];
    }

    if (outputFormat) {
      // Find specific resource name: positional args not starting with '-', not the resource type itself
      const positional = args.filter((a, i) => {
        if (a.startsWith('-')) return false;
        if (i > 0 && (args[i-1] === '-n' || args[i-1] === '--namespace' || args[i-1] === '-o' || args[i-1] === '--output')) return false;
        return true;
      });
      const resourceName = positional[1]; // positional[0] is the resource type
      if (resourceName) {
        const node = this._findNode(resourceName, ns);
        if (!node) {
          this._println(`Error from server (NotFound): "${resourceName}" not found`, 'term-error');
          return;
        }
        if (outputFormat === 'json') {
          const obj = this._nodeToYaml(node);
          const lines = JSON.stringify(obj, null, 2).split('\n');
          for (const l of lines) this._println(l, 'term-muted');
        } else {
          const obj = this._nodeToYaml(node);
          const yamlStr = this._toYamlStr(obj).trimStart();
          for (const l of yamlStr.split('\n')) this._println(l, 'term-muted');
        }
        return;
      }
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

    // Handle events specially before kind lookup
    if (rawKind === 'events' || rawKind === 'event') {
      const storeNodes = Array.from(this._store.nodes.values());
      const events = [];

      for (const n of storeNodes) {
        if (ns && n.metadata?.namespace !== ns) continue;
        const objName = n.metadata?.name || n.id;
        if (n.kind === 'Pod') {
          if (n.simPhase === 'Running') {
            events.push({ type: 'Normal',  obj: `pod/${objName}`,        reason: 'Started',          msg: 'Started container' });
          } else if (n.simPhase === 'CrashLoopBackOff') {
            events.push({ type: 'Warning', obj: `pod/${objName}`,        reason: 'BackOff',           msg: 'Back-off restarting failed container' });
          } else if (n.simPhase === 'ImagePullBackOff') {
            events.push({ type: 'Warning', obj: `pod/${objName}`,        reason: 'Failed',            msg: 'Failed to pull image: not found' });
          } else if (n.simPhase === 'Pending') {
            events.push({ type: 'Normal',  obj: `pod/${objName}`,        reason: 'Scheduled',         msg: 'Successfully assigned to node' });
          }
        } else if (n.kind === 'Node') {
          const notReady = n.annotations?.['node.kubernetes.io/ready'] === 'false';
          if (notReady) {
            events.push({ type: 'Warning', obj: `node/${objName}`,       reason: 'NodeNotReady',      msg: 'Node became NotReady' });
          }
        } else if (n.kind === 'Deployment') {
          events.push({ type: 'Normal',    obj: `deployment/${objName}`, reason: 'ScalingReplicaSet', msg: 'Scaled replica set' });
        }
      }

      if (events.length === 0) {
        this._println('No events found.', 'term-muted');
        return;
      }

      this._println(
        this._pad('TYPE', 10) + this._pad('REASON', 22) + this._pad('OBJECT', 36) + 'MESSAGE',
        'term-header'
      );
      for (const ev of events.slice(-20)) {
        const cls = ev.type === 'Warning' ? 'term-error' : 'term-prompt';
        this._println(
          this._pad(ev.type, 10) + this._pad(ev.reason, 22) + this._pad(ev.obj, 36) + ev.msg,
          cls
        );
      }
      return;
    }

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
    const nsPfx = showAllNs ? 18 : 0;

    // Helper: prefix line with namespace column if -A
    const nsCol = (n) => showAllNs ? this._pad(n.metadata?.namespace || '', nsPfx) : '';

    if (kind === 'Pod' || kind === 'ControlPlaneComponent') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 36) + this._pad('READY', 8) + this._pad('STATUS', 22) + this._pad('RESTARTS', 10) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const ready = this._podReady(n);
        const status = n.simPhase || spec.phase || (n.kind === 'ControlPlaneComponent' ? 'Running' : 'Unknown');
        const restarts = String(spec.restartCount || 0);
        const cls = status === 'Running' ? 'term-prompt'
                  : status === 'Pending' || status === 'ContainerCreating' ? 'term-warn'
                  : (status === 'Failed' || status === 'CrashLoopBackOff' || status === 'OOMKilled' || status === 'ImagePullBackOff') ? 'term-error'
                  : 'term-line';
        this._println(nsCol(n) + this._pad(name, 36) + this._pad(ready, 8) + this._pad(status, 22) + this._pad(restarts, 10) + this._age(n), cls);
      }
      return;
    }

    if (kind === 'Deployment') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 34) + this._pad('READY', 10) + this._pad('UP-TO-DATE', 12) + this._pad('AVAILABLE', 12) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {}; let status = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        try { status = JSON.parse(n.status || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const desired = spec.replicas ?? 1;
        const ready = `${status.readyReplicas ?? desired}/${desired}`;
        const upToDate = String(status.updatedReplicas ?? desired);
        const available = String(status.availableReplicas ?? desired);
        this._println(nsCol(n) + this._pad(name, 34) + this._pad(ready, 10) + this._pad(upToDate, 12) + this._pad(available, 12) + this._age(n), 'term-prompt');
      }
      return;
    }

    if (kind === 'StatefulSet') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 34) + this._pad('READY', 10) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {}; let status = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        try { status = JSON.parse(n.status || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const desired = spec.replicas ?? 1;
        const ready = `${status.readyReplicas ?? desired}/${desired}`;
        this._println(nsCol(n) + this._pad(name, 34) + this._pad(ready, 10) + this._age(n), 'term-prompt');
      }
      return;
    }

    if (kind === 'DaemonSet') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 34) + this._pad('DESIRED', 9) + this._pad('CURRENT', 9) + this._pad('READY', 7) + this._pad('NODE SELECTOR', 20) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {}; let status = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        try { status = JSON.parse(n.status || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const desired = String(status.desiredNumberScheduled ?? spec.replicas ?? 1);
        const current = String(status.currentNumberScheduled ?? desired);
        const ready   = String(status.numberReady ?? desired);
        const sel = spec.nodeSelector ? Object.entries(spec.nodeSelector).map(([k,v]) => `${k}=${v}`).join(',') : '<none>';
        this._println(nsCol(n) + this._pad(name, 34) + this._pad(desired, 9) + this._pad(current, 9) + this._pad(ready, 7) + this._pad(sel, 20) + this._age(n), 'term-prompt');
      }
      return;
    }

    if (kind === 'Service') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 30) + this._pad('TYPE', 14) + this._pad('CLUSTER-IP', 16) + this._pad('EXTERNAL-IP', 14) + this._pad('PORT(S)', 14) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const type = spec.type || 'ClusterIP';
        const clusterIP = spec.clusterIP || '<none>';
        const externalIP = spec.externalIP || (type === 'LoadBalancer' ? '<pending>' : '<none>');
        const ports = spec.ports?.map(p => `${p.port}${p.protocol ? '/' + p.protocol : ''}`).join(',') || '';
        this._println(nsCol(n) + this._pad(name, 30) + this._pad(type, 14) + this._pad(clusterIP, 16) + this._pad(externalIP, 14) + this._pad(ports, 14) + this._age(n), 'term-prompt');
      }
      return;
    }

    if (kind === 'Node') {
      this._println(
        this._pad('NAME', 30) + this._pad('STATUS', 12) + this._pad('ROLES', 14) + this._pad('AGE', 6) + 'VERSION',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const notReady = n.annotations?.['node.kubernetes.io/ready'] === 'false';
        const status = notReady ? 'NotReady' : 'Ready';
        const roles = spec.roles || (n.metadata?.labels?.['node-role.kubernetes.io/control-plane'] ? 'control-plane' : 'worker');
        const version = spec.version || 'v1.30.0';
        const cls = notReady ? 'term-error' : 'term-prompt';
        this._println(this._pad(name, 30) + this._pad(status, 12) + this._pad(roles, 14) + this._pad(this._age(n), 6) + version, cls);
      }
      return;
    }

    if (kind === 'PersistentVolumeClaim') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 30) + this._pad('STATUS', 10) + this._pad('VOLUME', 22) + this._pad('CAPACITY', 10) + this._pad('ACCESS MODES', 14) + this._pad('STORAGECLASS', 16) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const status = spec.phase || n.simPhase || 'Unknown';
        const volume = spec.volumeName || '';
        const capacity = spec.capacity || spec.requests?.storage || '';
        const accessModes = (spec.accessModes || []).join(',') || 'RWO';
        const storageClass = spec.storageClassName || '';
        const cls = status === 'Bound' ? 'term-prompt' : status === 'Pending' ? 'term-warn' : 'term-line';
        this._println(nsCol(n) + this._pad(name, 30) + this._pad(status, 10) + this._pad(volume, 22) + this._pad(capacity, 10) + this._pad(accessModes, 14) + this._pad(storageClass, 16) + this._age(n), cls);
      }
      return;
    }

    if (kind === 'ConfigMap' || kind === 'Secret') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 36) + this._pad('DATA', 8) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const dataCount = String(spec.dataCount ?? (spec.data ? Object.keys(spec.data).length : 0));
        this._println(nsCol(n) + this._pad(name, 36) + this._pad(dataCount, 8) + this._age(n), 'term-prompt');
      }
      return;
    }

    if (kind === 'Job') {
      this._println(
        (showAllNs ? this._pad('NAMESPACE', nsPfx) : '') +
        this._pad('NAME', 34) + this._pad('COMPLETIONS', 14) + this._pad('DURATION', 10) + 'AGE',
        'term-header'
      );
      for (const n of nodes) {
        let spec = {}; let status = {};
        try { spec = JSON.parse(n.spec || '{}'); } catch {}
        try { status = JSON.parse(n.status || '{}'); } catch {}
        const name = n.metadata?.name || n.id || '';
        const completions = `${status.succeeded ?? 0}/${spec.completions ?? 1}`;
        const duration = status.duration || '1m';
        this._println(nsCol(n) + this._pad(name, 34) + this._pad(completions, 14) + this._pad(duration, 10) + this._age(n), 'term-prompt');
      }
      return;
    }

    // Generic fallback: NAME [READY] STATUS AGE
    const isPod = kind === 'Pod';
    const rows = nodes.map(n => {
      const name   = n.metadata?.name || n.id || '';
      const ns     = n.metadata?.namespace || '';
      const status = this._nodeStatus(n);
      const ready  = isPod ? this._podReady(n) : null;
      return { name, ns, status, ready, _node: n };
    });

    const w = {
      ns:   showAllNs ? Math.max(9,  ...rows.map(r => r.ns.length))   + 2 : 0,
      name:            Math.max(4,   ...rows.map(r => r.name.length))  + 2,
      ready: isPod   ? Math.max(5,   ...rows.map(r => r.ready.length)) + 2 : 0,
      status:          Math.max(6,   ...rows.map(r => r.status.length))+ 2,
    };

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
      line += this._age(r._node);

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

  // kubectl delete <kind> <name> [-n <ns>]
  // kubectl delete namespace <name>  — deletes all resources in the namespace
  _kubectlDelete(args) {
    const { resource, ns, name } = this._parseDescribeArgs(args);
    if (!name) {
      this._println('Usage: kubectl delete <kind> <name> [-n <ns>]', 'term-error');
      return;
    }
    if (resource === 'namespace' || resource === 'ns') {
      api.deleteNamespace(name)
        .then(() => this._println(`namespace "${name}" deleted`, 'term-prompt'))
        .catch(err => this._println(`Error: ${err.message}`, 'term-error'));
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
    const followFlag = args.includes('-f') || args.includes('--follow');
    const prevFlag   = args.includes('-p') || args.includes('--previous');
    const tailFlag   = args.find(a => a.startsWith('--tail='));
    const tailN      = tailFlag ? parseInt(tailFlag.split('=')[1], 10) : 20;

    // Strip flags to find pod name and optional -n namespace
    const cleaned = args.filter(a => !a.startsWith('-'));
    let podName = cleaned[0];
    const nsIdx = args.indexOf('-n');
    const ns = nsIdx !== -1 ? args[nsIdx + 1] : null;

    if (!podName) {
      this._println('Usage: kubectl logs <pod-name> [-n <namespace>] [-f] [-p] [--tail=N]', 'term-error');
      return;
    }

    const nodes = Array.from(this._store.nodes.values());
    const pod = nodes.find(n => {
      if (n.kind !== 'Pod' && n.kind !== 'ControlPlaneComponent') return false;
      if (n.metadata?.name !== podName) return false;
      if (ns && n.metadata?.namespace !== ns) return false;
      return true;
    });

    if (!pod) {
      this._println(`Error from server (NotFound): pods "${podName}" not found`, 'term-error');
      return;
    }

    const phase = pod.simPhase || 'Unknown';

    if (prevFlag) {
      this._println(`-- Previous container logs for ${podName} --`, 'term-muted');
    }

    const lines = this._simulatedLogs(pod, tailN, prevFlag);

    if (lines.length === 0) {
      if (phase === 'Pending' || phase === 'ContainerCreating') {
        this._println(`Error from server: container "${podName}" in pod "${podName}" is not running`, 'term-error');
      } else {
        this._println('(no logs)', 'term-muted');
      }
      return;
    }

    for (const line of lines) {
      const cls = line.includes('ERROR') || line.includes('FATAL') || line.includes('panic') ? 'term-error'
                : line.includes('WARN') ? 'term-warn'
                : 'term-line';
      this._println(line, cls);
    }

    if (followFlag) {
      this._println('', '');
      this._println(`(streaming — press Ctrl+C to stop)`, 'term-muted');
    }
  }

  _simulatedLogs(pod, tailN, isPrevious) {
    const name = pod.metadata?.name || '';
    const phase = pod.simPhase || '';
    const now = new Date();
    const ts = () => now.toISOString().replace('T', ' ').slice(0, 19);

    // Crash / previous container logs
    if (isPrevious || phase === 'CrashLoopBackOff') {
      return [
        `${ts()} INFO  Starting container...`,
        `${ts()} INFO  Loading configuration...`,
        `${ts()} ERROR Failed to connect to required service: connection refused`,
        `${ts()} FATAL panic: runtime error: invalid memory address or nil pointer dereference`,
        `${ts()} goroutine 1 [running]:`,
        `${ts()} main.main()`,
        `${ts()} \t/app/main.go:42 +0x1a4`,
        `${ts()} exit status 1`,
      ].slice(-tailN);
    }

    if (phase === 'Pending' || phase === 'ContainerCreating') return [];

    if (phase === 'OOMKilled') {
      return [
        `${ts()} INFO  Service started`,
        `${ts()} WARN  Memory usage approaching limit: 980Mi/1Gi`,
        `${ts()} WARN  Memory usage critical: 1020Mi/1Gi`,
        `${ts()} ERROR Out of memory: Kill process — memory limit exceeded`,
        `${ts()} Killed`,
      ].slice(-tailN);
    }

    // Identify log type by pod name / labels
    const n = name.toLowerCase();

    if (n.startsWith('redpanda-') && !n.includes('operator') && !n.includes('post')) {
      const ordinal = n.replace('redpanda-', '') || '0';
      return [
        `${ts()} INFO  Welcome to Redpanda! - v24.3.1`,
        `${ts()} INFO  (pid 1) Bootstrapping cluster configuration`,
        `${ts()} INFO  Starting Redpanda storage services`,
        `${ts()} INFO  storage - log - I0 - opened log segment: {offset_base: 0}`,
        `${ts()} INFO  raft - [group_id:0, {broker: ${ordinal}}] - becoming follower`,
        `${ts()} INFO  raft - [group_id:0] - appending 1 entries`,
        `${ts()} INFO  raft - [group_id:0] - elected leader`,
        `${ts()} INFO  kafka - server started listening on 0.0.0.0:9092`,
        `${ts()} INFO  admin - server started listening on 0.0.0.0:9644`,
        `${ts()} INFO  pandaproxy - server started listening on 0.0.0.0:8082`,
        `${ts()} INFO  schema_registry - server started listening on 0.0.0.0:8081`,
        `${ts()} INFO  cluster is ready`,
      ].slice(-tailN);
    }

    if (n.includes('operator') || n.includes('controller')) {
      return [
        `${ts()} INFO  Starting controller manager`,
        `${ts()} INFO  Starting EventSource  {"controller": "redpanda"}`,
        `${ts()} INFO  Starting Controller   {"controller": "redpanda"}`,
        `${ts()} INFO  Starting workers      {"controller": "redpanda", "worker count": 1}`,
        `${ts()} INFO  Reconciling Redpanda  {"namespace": "redpanda", "name": "redpanda"}`,
        `${ts()} INFO  StatefulSet already exists, updating {"name": "redpanda"}`,
        `${ts()} INFO  Reconciled Redpanda cluster successfully`,
      ].slice(-tailN);
    }

    if (n.includes('coredns')) {
      return [
        `${ts()} [INFO] plugin/reload: Running configuration SHA512 = abc123`,
        `${ts()} CoreDNS-1.11.1`,
        `${ts()} linux/amd64, go1.21.0, 1b0d0f5`,
        `${ts()} [INFO] 10.96.0.1:40782 - "A IN kubernetes.default.svc.cluster.local. udp 54 true 512" NOERROR qr,aa,rd 106 0.000123s`,
        `${ts()} [INFO] 10.96.0.1:52134 - "AAAA IN redpanda-0.redpanda.redpanda.svc.cluster.local. udp 58 true 512" NOERROR qr,aa,rd 151 0.000087s`,
      ].slice(-tailN);
    }

    if (n.includes('kube-proxy')) {
      return [
        `${ts()} I  Using ipvs Proxier.`,
        `${ts()} I  Created new ipvs service with persistent flag`,
        `${ts()} I  Syncing ipvs Proxier rules`,
        `${ts()} I  syncProxyRules took 12.345ms`,
      ].slice(-tailN);
    }

    if (n.includes('etcd')) {
      return [
        `${ts()} etcdserver: starting server... [version: 3.5.11]`,
        `${ts()} etcdserver: name = master`,
        `${ts()} embed: serving client traffic insecurely; this is strongly discouraged!`,
        `${ts()} etcdserver: published {Name:master ClientURLs:[http://127.0.0.1:2379]}`,
        `${ts()} embed: ready to serve client requests`,
      ].slice(-tailN);
    }

    if (n.includes('kube-apiserver') || n.includes('apiserver')) {
      return [
        `${ts()} I  Serving securely on [::]:6443`,
        `${ts()} I  Serving insecurely on [::]:8080`,
        `${ts()} I  Caches are synced for controller manager`,
        `${ts()} I  GET /api/v1/namespaces/redpanda/pods 200 4.321ms`,
        `${ts()} I  WATCH /apis/apps/v1/statefulsets 200 streaming`,
      ].slice(-tailN);
    }

    if (n.includes('scheduler')) {
      return [
        `${ts()} I  Starting kube-scheduler`,
        `${ts()} I  Serving securely on [::]:10259`,
        `${ts()} I  Attempting to acquire leader lease kube-system/kube-scheduler...`,
        `${ts()} I  Successfully acquired lease kube-system/kube-scheduler`,
        `${ts()} I  "Successfully bound pod to node" pod="redpanda/redpanda-0" node="worker-1"`,
      ].slice(-tailN);
    }

    if (n.includes('flannel') || n.includes('calico') || n.includes('cilium')) {
      return [
        `${ts()} INFO  Starting flannel daemon`,
        `${ts()} INFO  Installing network plugin`,
        `${ts()} INFO  Found network config - Backend type: vxlan`,
        `${ts()} INFO  Wrote subnet file to /run/flannel/subnet.env`,
        `${ts()} INFO  Running backend.`,
      ].slice(-tailN);
    }

    if (n.includes('post-install') || n.includes('job')) {
      return [
        `${ts()} INFO  Connecting to Redpanda Admin API: redpanda-0.redpanda.redpanda.svc.cluster.local:9644`,
        `${ts()} INFO  Setting cluster config: kafka_enable_authorization=true`,
        `${ts()} INFO  Setting cluster config: auto_create_topics_enabled=false`,
        `${ts()} INFO  Cluster configuration applied successfully`,
        `${ts()} INFO  Job complete`,
      ].slice(-tailN);
    }

    // Generic fallback
    return [
      `${ts()} INFO  Container started`,
      `${ts()} INFO  Initializing application`,
      `${ts()} INFO  Configuration loaded`,
      `${ts()} INFO  Service ready`,
      `${ts()} INFO  Listening on :8080`,
    ].slice(-tailN);
  }

  // kubectl top pods [-n <ns>] / kubectl top nodes
  _kubectlTop(args) {
    const resource = args[0];
    if (!resource) {
      this._println('Usage: kubectl top (pods|nodes) [-n <ns>]', 'term-error');
      return;
    }
    const ns = this._parseNs(args);
    const nodes = Array.from(this._store.nodes.values());

    if (resource === 'pods' || resource === 'pod') {
      const pods = nodes.filter(n => {
        if (n.kind !== 'Pod') return false;
        if (ns && n.metadata?.namespace !== ns) return false;
        return n.simPhase === 'Running';
      });
      if (pods.length === 0) {
        this._println('No running pods found.', 'term-muted');
        return;
      }
      this._println(this._pad('NAME', 36) + this._pad('CPU(cores)', 14) + 'MEMORY(bytes)', 'term-header');
      for (const pod of pods) {
        let spec = {};
        try { spec = JSON.parse(pod.spec || '{}'); } catch {}
        const isSystem = pod.metadata?.namespace === 'kube-system';
        const cpu = isSystem
          ? (10 + Math.floor(Math.random() * 40)) + 'm'
          : (20 + Math.floor(Math.random() * 200)) + 'm';
        const mem = isSystem
          ? (20 + Math.floor(Math.random() * 60)) + 'Mi'
          : (64 + Math.floor(Math.random() * 256)) + 'Mi';
        const name = pod.metadata?.name || pod.id;
        this._println(this._pad(name, 36) + this._pad(cpu, 14) + mem, 'term-prompt');
      }
    } else if (resource === 'nodes' || resource === 'node') {
      const nodeResources = nodes.filter(n => n.kind === 'Node');
      if (nodeResources.length === 0) {
        this._println('No nodes found.', 'term-muted');
        return;
      }
      this._println(this._pad('NAME', 30) + this._pad('CPU(cores)', 14) + this._pad('CPU%', 8) + this._pad('MEMORY(bytes)', 16) + 'MEMORY%', 'term-header');
      for (const n of nodeResources) {
        const cpu = (100 + Math.floor(Math.random() * 400)) + 'm';
        const cpuPct = (5 + Math.floor(Math.random() * 40)) + '%';
        const mem = (500 + Math.floor(Math.random() * 1500)) + 'Mi';
        const memPct = (20 + Math.floor(Math.random() * 50)) + '%';
        const name = n.metadata?.name || n.id;
        this._println(this._pad(name, 30) + this._pad(cpu, 14) + this._pad(cpuPct, 8) + this._pad(mem, 16) + memPct, 'term-prompt');
      }
    } else {
      this._println(`error: unknown resource type "${resource}"`, 'term-error');
    }
  }

  _kubectlRollout(args) {
    const sub = args[0];
    const ns = this._parseNs(args);
    const target = args[1] || '';
    const slash = target.indexOf('/');
    const resourceName = slash >= 0 ? target.slice(slash + 1) : target;

    if (sub === 'status') {
      if (!resourceName) {
        this._println('Usage: kubectl rollout status deployment/<name> [-n <ns>]', 'term-error');
        return;
      }
      const node = this._findNode(resourceName, ns);
      if (!node) {
        this._println(`Error from server (NotFound): "${resourceName}" not found`, 'term-error');
        return;
      }
      if (node.kind !== 'Deployment' && node.kind !== 'StatefulSet') {
        this._println(`error: "${node.kind}" is not a rollout target`, 'term-error');
        return;
      }
      let spec = {};
      let status = {};
      try { spec = JSON.parse(node.spec || '{}'); } catch {}
      try { status = JSON.parse(node.status || '{}'); } catch {}
      const desired = spec.replicas ?? 1;
      const ready = status.readyReplicas ?? desired;
      if (ready >= desired) {
        this._println(`deployment "${resourceName}" successfully rolled out`, 'term-prompt');
      } else {
        this._println(`Waiting for deployment "${resourceName}" rollout to finish: ${ready} of ${desired} updated replicas are available...`, 'term-line');
      }
    } else if (sub === 'history') {
      if (!resourceName) {
        this._println('Usage: kubectl rollout history deployment/<name> [-n <ns>]', 'term-error');
        return;
      }
      const node = this._findNode(resourceName, ns);
      if (!node) {
        this._println(`Error from server (NotFound): "${resourceName}" not found`, 'term-error');
        return;
      }
      this._println(`deployment.apps/${resourceName}`, 'term-line');
      this._println('REVISION  CHANGE-CAUSE', 'term-header');
      this._println('1         <none>  (initial deploy)', 'term-muted');
      this._println('2         <none>  (current)', 'term-prompt');
    } else if (sub === 'restart') {
      if (!resourceName) {
        this._println('Usage: kubectl rollout restart deployment/<name> [-n <ns>]', 'term-error');
        return;
      }
      this._println(`deployment.apps/${resourceName} restarted`, 'term-prompt');
    } else if (sub === 'undo') {
      const subArgs = args.slice(1);
      const undoTarget = subArgs[0] || '';
      let undoName = undoTarget.includes('/') ? undoTarget.split('/')[1] : undoTarget;
      if (!undoName) {
        this._println('Usage: kubectl rollout undo deployment/<name> [-n <ns>]', 'term-error');
      } else {
        const nsIdx2 = subArgs.indexOf('-n');
        const ns2 = nsIdx2 !== -1 ? subArgs[nsIdx2 + 1] : null;
        const allNodes = Array.from(this._store.nodes.values());
        const deploy = allNodes.find(n =>
          (n.kind === 'Deployment' || n.kind === 'StatefulSet') &&
          n.metadata?.name === undoName &&
          (!ns2 || n.metadata?.namespace === ns2)
        );
        if (!deploy) {
          this._println(`Error from server (NotFound): deployments.apps "${undoName}" not found`, 'term-error');
        } else {
          this._println(`deployment.apps/${undoName} rolled back`, 'term-prompt');
          this._println(`Waiting for deployment "${undoName}" rollout to finish: 0 out of 1 new replicas have been updated...`, 'term-muted');
          setTimeout(() => {
            this._println(`Waiting for deployment "${undoName}" rollout to finish: 1 old replicas are pending termination...`, 'term-muted');
          }, 1000);
          setTimeout(() => {
            this._println(`deployment "${undoName}" successfully rolled out`, 'term-prompt');
          }, 2000);
        }
      }
    } else {
      this._println(`kubectl rollout: unknown subcommand "${sub}"`, 'term-error');
      this._println('  supported: status, history, restart, undo', 'term-muted');
    }
  }

  _kubectlExec(args) {
    const ns = this._parseNs(args);
    // kubectl exec <pod> -- <command>
    const ddash = args.indexOf('--');
    const podName = args[0];
    const cmd = ddash >= 0 ? args.slice(ddash + 1).join(' ') : '';

    if (!podName || podName.startsWith('-')) {
      this._println('Usage: kubectl exec <pod> [-n <ns>] -- <command>', 'term-error');
      return;
    }
    const pod = this._findNode(podName, ns);
    if (!pod) {
      this._println(`Error from server (NotFound): pods "${podName}" not found`, 'term-error');
      return;
    }
    if (pod.kind !== 'Pod') {
      this._println(`error: "${podName}" is not a pod`, 'term-error');
      return;
    }
    if (pod.simPhase !== 'Running') {
      this._println(`error: cannot exec into a container in a non-running pod; current phase is ${pod.simPhase}`, 'term-error');
      return;
    }
    if (!cmd) {
      this._println('error: you must specify at least one command for the container', 'term-error');
      return;
    }
    // Simulate common commands
    const ns2 = pod.metadata?.namespace || 'default';
    if (cmd === 'env' || cmd === 'printenv') {
      this._println('KUBERNETES_SERVICE_HOST=10.96.0.1', 'term-muted');
      this._println('KUBERNETES_SERVICE_PORT=443', 'term-muted');
      this._println(`HOSTNAME=${podName}`, 'term-muted');
      this._println(`POD_NAMESPACE=${ns2}`, 'term-muted');
    } else if (cmd.startsWith('cat /etc/hosts')) {
      this._println(`127.0.0.1   localhost`, 'term-muted');
      this._println(`::1         localhost`, 'term-muted');
      this._println(`10.244.0.5  ${podName}.${ns2}.pod.cluster.local`, 'term-muted');
    } else if (cmd === 'hostname') {
      this._println(podName, 'term-muted');
    } else if (cmd.startsWith('curl') || cmd.startsWith('wget')) {
      this._println('Simulated: HTTP/1.1 200 OK', 'term-prompt');
    } else if (cmd === 'ps aux' || cmd === 'ps') {
      this._println('PID   USER     COMMAND', 'term-header');
      this._println('1     root     /bin/sh -c /app/start.sh', 'term-muted');
      this._println('42    app      /app/server --port=8080', 'term-muted');
    } else if (cmd.startsWith('ls')) {
      this._println('app  bin  etc  home  lib  proc  sys  tmp  usr  var', 'term-muted');
    } else {
      this._println(`[simulated] ${cmd}`, 'term-muted');
      this._println('(exec output simulated — connect a real cluster for live exec)', 'term-muted');
    }
  }

  _kubectlCordon(args, cordon) {
    const nodeName = args.find(a => !a.startsWith('-'));
    if (!nodeName) {
      this._println(`Usage: kubectl ${cordon ? 'cordon' : 'uncordon'} <node>`, 'term-error');
      return;
    }
    const nodes = Array.from(this._store.nodes.values());
    const node = nodes.find(n => n.kind === 'Node' && n.metadata?.name === nodeName);
    if (!node) {
      this._println(`Error from server (NotFound): nodes "${nodeName}" not found`, 'term-error');
      return;
    }
    if (!node.metadata) node.metadata = {};
    if (!node.metadata.annotations) node.metadata.annotations = {};
    if (cordon) {
      node.metadata.annotations['node.kubernetes.io/unschedulable'] = 'true';
      node.spec = node.spec ? node.spec : '{}';
      try {
        const s = JSON.parse(node.spec);
        s.unschedulable = true;
        node.spec = JSON.stringify(s);
      } catch {}
      this._println(`node/${nodeName} cordoned`, 'term-prompt');
    } else {
      delete node.metadata.annotations['node.kubernetes.io/unschedulable'];
      try {
        const s = JSON.parse(node.spec || '{}');
        delete s.unschedulable;
        node.spec = JSON.stringify(s);
      } catch {}
      this._println(`node/${nodeName} uncordoned`, 'term-prompt');
    }
  }

  _kubectlLabel(args) {
    // kubectl label <resource> <name> key=value [key-] [-n ns]
    const nsIdx = args.indexOf('-n');
    const ns = nsIdx !== -1 ? args[nsIdx + 1] : null;
    const cleaned = args.filter((a, i) => !a.startsWith('-') && args[i-1] !== '-n');
    const resourceType = cleaned[0];
    const resourceName = cleaned[1];
    const labelArgs = cleaned.slice(2);

    if (!resourceType || !resourceName || labelArgs.length === 0) {
      this._println('Usage: kubectl label <resource> <name> key=value [key-] [-n <ns>]', 'term-error');
      return;
    }

    const kindMap = { pod: 'Pod', pods: 'Pod', deploy: 'Deployment', deployments: 'Deployment',
      node: 'Node', nodes: 'Node', svc: 'Service', services: 'Service',
      sts: 'StatefulSet', statefulsets: 'StatefulSet' };
    const kind = kindMap[resourceType.toLowerCase()];

    const nodes = Array.from(this._store.nodes.values());
    const target = nodes.find(n => {
      if (kind && n.kind !== kind) return false;
      if (n.metadata?.name !== resourceName) return false;
      if (ns && n.metadata?.namespace !== ns) return false;
      return true;
    });

    if (!target) {
      this._println(`Error from server (NotFound): "${resourceName}" not found`, 'term-error');
      return;
    }

    if (!target.metadata.labels) target.metadata.labels = {};

    for (const arg of labelArgs) {
      if (arg.endsWith('-')) {
        const key = arg.slice(0, -1);
        delete target.metadata.labels[key];
      } else if (arg.includes('=')) {
        const [k, v] = arg.split('=');
        target.metadata.labels[k] = v;
      }
    }

    this._println(`${resourceType.replace(/s$/, '')}/${resourceName} labeled`, 'term-prompt');
  }

  _kubectlAnnotate(args) {
    const nsIdx = args.indexOf('-n');
    const ns = nsIdx !== -1 ? args[nsIdx + 1] : null;
    const cleaned = args.filter((a, i) => !a.startsWith('-') && args[i-1] !== '-n');
    const resourceType = cleaned[0];
    const resourceName = cleaned[1];
    const annoArgs = cleaned.slice(2);

    if (!resourceType || !resourceName || annoArgs.length === 0) {
      this._println('Usage: kubectl annotate <resource> <name> key=value [key-] [-n <ns>]', 'term-error');
      return;
    }

    const kindMap = { pod: 'Pod', pods: 'Pod', deploy: 'Deployment', node: 'Node', nodes: 'Node' };
    const kind = kindMap[resourceType.toLowerCase()];

    const nodes = Array.from(this._store.nodes.values());
    const target = nodes.find(n => {
      if (kind && n.kind !== kind) return false;
      if (n.metadata?.name !== resourceName) return false;
      if (ns && n.metadata?.namespace !== ns) return false;
      return true;
    });

    if (!target) {
      this._println(`Error from server (NotFound): "${resourceName}" not found`, 'term-error');
      return;
    }

    if (!target.metadata.annotations) target.metadata.annotations = {};

    for (const arg of annoArgs) {
      if (arg.endsWith('-')) {
        delete target.metadata.annotations[arg.slice(0, -1)];
      } else if (arg.includes('=')) {
        const [k, v] = arg.split('=');
        target.metadata.annotations[k] = v;
      }
    }

    this._println(`${resourceType.replace(/s$/, '')}/${resourceName} annotated`, 'term-prompt');
  }

  _kubectlTaint(args) {
    // kubectl taint node <name> key=value:Effect [key:Effect-]
    const nodeName = args.find(a => !a.startsWith('-') && a !== 'node' && a !== 'nodes');
    if (!nodeName) {
      this._println('Usage: kubectl taint node <name> key=value:Effect', 'term-error');
      return;
    }
    const taintArgs = args.filter(a => !a.startsWith('-') && a !== nodeName && a !== 'node' && a !== 'nodes');
    if (taintArgs.length === 0) {
      this._println('Usage: kubectl taint node <name> key=value:Effect [key:Effect-]', 'term-error');
      return;
    }
    const nodes = Array.from(this._store.nodes.values());
    const node = nodes.find(n => n.kind === 'Node' && n.metadata?.name === nodeName);
    if (!node) {
      this._println(`Error from server (NotFound): nodes "${nodeName}" not found`, 'term-error');
      return;
    }
    for (const t of taintArgs) {
      if (t.endsWith('-')) {
        this._println(`node/${nodeName} untainted`, 'term-prompt');
      } else {
        this._println(`node/${nodeName} tainted`, 'term-prompt');
      }
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

    const hasOperator = nodes.some(n => n.id === 'deploy-redpanda-operator');
    const hasRedpanda = nodes.some(n => n.metadata?.namespace === 'redpanda' && n.kind === 'StatefulSet');

    if (!nsFlag || nsFlag === 'redpanda') {
      if (hasOperator) releases.push({ name: 'redpanda-operator', ns: 'redpanda', chart: 'redpanda/operator', status: 'deployed' });
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
    if (release !== 'redpanda' && release !== 'redpanda-operator') {
      this._println(`Error: release "${release}" not found`, 'term-error');
      return;
    }
    const markerID = release === 'redpanda-operator' ? 'deploy-redpanda-operator' : 'sts-redpanda';
    if (!nodes.some(n => n.id === markerID)) {
      this._println(`Error: release "${release}" not found`, 'term-error');
      return;
    }
    const releaseIDs = release === 'redpanda-operator'
      ? ['deploy-redpanda-operator', 'rs-redpanda-operator', 'pod-redpanda-operator']
      : ['cr-redpanda', 'sts-redpanda', 'svc-redpanda-headless', 'svc-redpanda-external',
         'cm-redpanda', 'secret-redpanda-users', 'pod-redpanda-0', 'pod-redpanda-1', 'pod-redpanda-2'];
    const count = releaseIDs.filter(id => nodes.some(n => n.id === id)).length;
    this._println(`NAME: ${release}`, 'term-line');
    this._println(`NAMESPACE: redpanda`, 'term-line');
    this._println(`STATUS: deployed`, 'term-prompt');
    this._println(`RESOURCES: ${count} objects`, 'term-line');
  }

  // ---- help ----

  _help() {
    const cmds = [
      ['kubectl get', 'pods|svc|deployments|statefulsets|pvc|pv|events|all [-n <ns>] [-A] [-o yaml|json]'],
      ['kubectl describe', '<kind> <name> [-n <ns>]'],
      ['kubectl delete', '<kind> <name> [-n <ns>]  |  namespace <name>'],
      ['kubectl scale', '(sts|deployment)/<name> --replicas=N [-n <ns>]'],
      ['kubectl logs', '<pod> [-n <ns>] [-f] [-p] [--tail=N]  — stream container logs'],
      ['kubectl top', '(pods|nodes) [-n <ns>]'],
      ['kubectl rollout', 'status|history|restart|undo <deployment/name>'],
      ['kubectl exec', '<pod> [-n <ns>] -- <command>'],
      ['kubectl cordon', '<node>  — mark node as unschedulable'],
      ['kubectl uncordon', '<node>  — mark node as schedulable'],
      ['kubectl label', '<resource> <name> key=value [key-] [-n <ns>]'],
      ['kubectl annotate', '<resource> <name> key=value [key-] [-n <ns>]'],
      ['kubectl taint', 'node <name> key=value:Effect [key:Effect-]'],
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

  _nodeToYaml(node) {
    let spec = {};
    try { spec = JSON.parse(node.spec || '{}'); } catch {}
    let status = {};
    try { status = JSON.parse(node.status || '{}'); } catch {}
    const obj = {
      apiVersion: node.apiVersion || 'v1',
      kind: node.kind,
      metadata: {
        name: node.metadata?.name,
        namespace: node.metadata?.namespace,
        labels: node.metadata?.labels,
        annotations: node.metadata?.annotations,
        creationTimestamp: node.metadata?.creationTimestamp,
        uid: node.metadata?.uid,
      },
      spec,
      status,
    };
    const clean = (o) => {
      if (typeof o !== 'object' || o === null) return o;
      if (Array.isArray(o)) return o.map(clean);
      return Object.fromEntries(
        Object.entries(o)
          .filter(([,v]) => v !== undefined && v !== null && v !== '')
          .map(([k,v]) => [k, clean(v)])
      );
    };
    return clean(obj);
  }

  _toYamlStr(obj, indent = 0) {
    const pad = '  '.repeat(indent);
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj === 'boolean') return String(obj);
    if (typeof obj === 'number') return String(obj);
    if (typeof obj === 'string') {
      if (obj.includes('\n')) return `|\n${obj.split('\n').map(l => pad + '  ' + l).join('\n')}`;
      if (obj.match(/[:{}\[\],#&*?|<>=!%@`]/)) return JSON.stringify(obj);
      return obj;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      return obj.map(v => `\n${pad}- ${this._toYamlStr(v, indent + 1)}`).join('');
    }
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => {
      const val = this._toYamlStr(v, indent + 1);
      if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0) {
        return `\n${pad}${k}:${val}`;
      }
      if (Array.isArray(v) && v.length > 0) {
        return `\n${pad}${k}:${val}`;
      }
      return `\n${pad}${k}: ${val}`;
    }).join('');
  }

  _age(node) {
    const ts = node.metadata?.creationTimestamp;
    if (!ts) return '?';
    const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (secs < 60)  return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
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
