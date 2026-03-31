// graph.js — SVGGraph: reconcile SVG DOM from store state

const NS = 'http://www.w3.org/2000/svg';
const NODE_R = 26; // base radius for shapes

// Per-kind full labels shown inside node
const KIND_ABBR = {
  ControlPlaneComponent: 'cp',
  CustomResource:        'cr',
  Deployment: 'deploy', ReplicaSet: 'rs', Pod: 'pod', Service: 'svc',
  Ingress: 'ingress', ConfigMap: 'cm', Secret: 'secret',
  PersistentVolumeClaim: 'pvc', PersistentVolume: 'pv',
  StatefulSet: 'sts', DaemonSet: 'ds', HorizontalPodAutoscaler: 'hpa',
  CronJob: 'cron', Job: 'job', Namespace: 'ns',
  // cert-manager CRD kinds
  Certificate: 'cert', Issuer: 'issuer', ClusterIssuer: 'cluster-issuer',
  // ArgoCD CRD kind
  Application: 'argo-app',
  // Redpanda operator CRD kinds
  RedpandaTopic:  'topic',
  RedpandaUser:   'user',
  RedpandaSchema: 'schema',
  HelmRelease:    'hr',
  HelmRepository: 'helmrepo',
  // RBAC
  ServiceAccount: 'sa', Role: 'role', ClusterRole: 'cr-role',
  RoleBinding: 'rb', ClusterRoleBinding: 'crb',
  // Infrastructure
  Node: 'node',
  // External access pseudo-nodes
  ExternalClient:    'internet',
  IngressController: 'ing-ctrl',
};

// Component descriptions shown in SVG title tooltips
const KIND_DESCRIPTIONS = {
  ControlPlaneComponent: 'A core Kubernetes control-plane component (kube-apiserver, etcd, kube-scheduler, kube-controller-manager). Runs as a static Pod on control-plane nodes, managed directly by the kubelet.',
  Deployment:    'Manages identical stateless Pods via a ReplicaSet. Supports rolling updates, rollbacks, and scaling. Each spec change creates a new ReplicaSet — enabling instant rollback.',
  ReplicaSet:    'Ensures a specified number of Pod replicas are running. Owned by a Deployment — rarely created directly. Replaces failed Pods automatically.',
  Pod:           'The smallest schedulable unit. One or more containers sharing a network namespace (IP + ports) and optionally volumes. Ephemeral — deleted and recreated, never restarted in-place.',
  Service:       'Stable ClusterIP + DNS name that load-balances traffic to matching Pods via label selector. Types: ClusterIP, NodePort, LoadBalancer, ExternalName.',
  Ingress:       'HTTP/HTTPS routing rules for external traffic. Routes by hostname or path prefix to backend Services. Requires an Ingress Controller (nginx, Traefik…) to function.',
  ConfigMap:     'Stores non-confidential config as key-value pairs or files. Injected into Pods as env vars or mounted volumes. Volume changes propagate within ~60s.',
  Secret:        'Stores sensitive data (passwords, tokens, TLS certs) as base64-encoded values. Enable Encryption at Rest in production — base64 is not encryption.',
  PersistentVolumeClaim: 'A request for durable storage. Binds 1:1 to a PersistentVolume. Data survives Pod deletion.',
  PersistentVolume: 'Durable storage provisioned by an admin or CSI driver. Bound to one PVC. Reclaim policy controls what happens on PVC deletion (Retain/Delete).',
  StatefulSet:   'Manages stateful apps needing stable identity per Pod: ordinal names (<name>-0, -1…), stable DNS via headless Service, and per-Pod PVCs. Pods start/stop in ordinal order (OrderedReady).',
  DaemonSet:     'Ensures one Pod runs on every Node (or selected Nodes). Auto-adds Pods as Nodes join. Used for log shippers, node monitors, and network plugins.',
  HorizontalPodAutoscaler: 'Scales Deployment or StatefulSet replicas based on CPU/memory or custom metrics. Scale-up is fast; scale-down has a stabilization window (default 5m) to prevent flapping.',
  CronJob:       'Runs Jobs on a cron schedule. Each trigger creates a new Job. concurrencyPolicy controls overlapping runs (Allow/Forbid/Replace).',
  Job:           'Creates Pods and tracks successful completions. Retries up to backoffLimit on failure. Used for batch tasks, migrations, and one-off scripts.',
  Namespace:     'Virtual partition within a cluster. Scopes resource names, RBAC, ResourceQuotas, and LimitRanges.',
  // cert-manager
  Certificate:   'cert-manager Certificate CR. Declares desired x.509 cert (DNS names, duration, Issuer). Controller provisions it and stores signed cert + key in a Secret.',
  Issuer:        'cert-manager Issuer (namespace-scoped). Configures a certificate authority backend: SelfSigned, CA (Secret), ACME (Let\'s Encrypt HTTP-01/DNS-01), Vault, or Venafi.',
  ClusterIssuer: 'cert-manager ClusterIssuer (cluster-scoped). Like Issuer but usable by Certificates in any namespace.',
  // ArgoCD
  Application:   'ArgoCD Application CR. Declares Git source + target cluster/namespace + sync policy. The application-controller continuously diffs live state against Git and syncs.',
  // Redpanda CRDs
  RedpandaTopic:  'Redpanda Topic CR. Operator reconciles the Kafka topic via rpk (partitions, replication factor, retention, config overrides).',
  RedpandaUser:   'Redpanda User CR. Operator syncs SASL user credentials and ACLs via the Admin API. Password from a Secret reference.',
  RedpandaSchema: 'Redpanda Schema CR. Operator registers Avro/Protobuf/JSON schemas in Schema Registry (:8081) with compatibility enforcement.',
  HelmRelease:    'FluxCD HelmRelease CR. Used by legacy Redpanda operator v0.x (useFlux=true). FluxCD helm-controller renders and applies the Helm chart.',
  HelmRepository: 'FluxCD HelmRepository CR. Points source-controller to a Helm chart repo. Used by legacy Redpanda operator v0.x.',
  // RBAC
  ServiceAccount: 'Identity for processes inside a Pod. Short-lived JWT token auto-mounted at /var/run/secrets/kubernetes.io/serviceaccount/token. Bind to Roles via RoleBindings.',
  Role:           'Namespace-scoped permissions. Defines allowed verbs (get, list, create…) on API resources within one namespace.',
  ClusterRole:    'Cluster-scoped permissions. Like Role but works across all namespaces — required for cluster-scoped resources and cross-namespace operators.',
  RoleBinding:    'Grants a Role to a ServiceAccount (or user/group) within one namespace.',
  ClusterRoleBinding: 'Grants a ClusterRole cluster-wide. Used for operators and system components needing cross-namespace access.',
  // Infrastructure
  Node:           'Worker machine running kubelet, kube-proxy, and container runtime. Pods are scheduled here. Cordon stops new scheduling without evicting existing Pods.',
  // External access pseudo-nodes (simulator-only)
  ExternalClient:    'Pseudo-node representing an external client or the public internet. Wired to LoadBalancer/NodePort Services and to the Ingress Controller to show how traffic enters the cluster.',
  IngressController: 'Pseudo-node representing the Ingress Controller (e.g. ingress-nginx). Receives HTTP/S traffic from outside the cluster, evaluates Ingress routing rules, and forwards to the target Service.',
  // Storage / Policy
  StorageClass:   'Defines storage type and CSI provisioner for dynamic PV provisioning. The default StorageClass is used when a PVC omits storageClassName.',
  LimitRange:     'Sets per-container default resource requests/limits and min/max bounds. Required for ResourceQuota CPU/memory enforcement.',
  NetworkPolicy:  'Restricts pod-to-pod traffic using label selectors. Requires a CNI that enforces policies (Calico, Cilium). Without one, policies have no effect.',
  ResourceQuota:  'Caps total resource consumption per namespace (CPU, memory, pod count, etc.). Requests exceeding quota are rejected with 403.',
};

// Specific component descriptions for well-known names
const COMPONENT_DESCRIPTIONS = {
  'coredns':           'Cluster DNS. Resolves service names (my-svc.ns.svc.cluster.local → ClusterIP) and Pod records. Forwards unknown domains upstream. Runs as 2 replicas in kube-system.',
  'kube-proxy':        'DaemonSet on every Node. Programs iptables/ipvs rules so Service ClusterIPs route to backend Pod IPs. Sets kernel forwarding rules — does not proxy traffic itself.',
  'kube-scheduler':    'Assigns unscheduled Pods to Nodes. Filters ineligible Nodes, scores eligible ones (resources, affinity, taints), and writes the chosen Node name to the Pod.',
  'kube-controller-manager': 'Single binary running 40+ reconciliation controllers: Deployment, ReplicaSet, DaemonSet, StatefulSet, Job, Node, PV binding, HPA, EndpointSlice, and more.',
  'etcd':              'Distributed key-value store (Raft). The sole persistent state store — only kube-apiserver reads/writes it. Loss of quorum freezes the cluster.',
  'kube-apiserver':    'Cluster front door. All kubectl, controller, and kubelet calls go through here. Performs authn, authz, and admission control before persisting to etcd.',
  'cloud-controller-manager': 'Cloud-provider controllers (Node, Route, LoadBalancer) decoupled from kube-controller-manager. Provisions cloud LBs for LoadBalancer Services and manages Node lifecycle.',
  'cert-manager':      'cert-manager controller. Watches Certificate CRs and provisions x.509 certs via Issuer/ClusterIssuer backends. Stores cert + key in a Secret. Auto-renews before expiry.',
  'cert-manager-webhook': 'Admission webhook that validates/mutates cert-manager CRDs on every create/update. Must be reachable — if down, cert-manager CR operations fail.',
  'cert-manager-cainjector': 'Injects CA bundles into ValidatingWebhookConfiguration and MutatingWebhookConfiguration so kube-apiserver trusts webhook TLS certificates.',
  'argocd-server':     'ArgoCD API server and web UI. Handles authentication, RBAC, and app management (sync, diff, rollback). Used by the argocd CLI and browser UI.',
  'argocd-application': 'ArgoCD application-controller. Reconciles Git desired state with live cluster state. Reports Sync and Health status, triggers syncs.',
  'argocd-repo':       'ArgoCD repo-server. Clones Git repos, renders manifests (Helm, Kustomize, plain YAML), returns objects to the application-controller.',
  'redpanda':          'Top-level Redpanda CR. Operator reconciles it into a StatefulSet, Services, ConfigMaps, and Secrets forming the Redpanda broker cluster.',
  'prometheus':        'Scrapes /metrics endpoints and stores time-series data (TSDB). PromQL for queries and alerting. Paired with Alertmanager and Grafana.',
};

// Edge type → arrowhead marker id
const EDGE_MARKERS = {
  owns: 'arrow-owns', selects: 'arrow-selects', mounts: 'arrow-mounts',
  bound: 'arrow-bound', routes: 'arrow-routes', scales: 'arrow-scales',
  headless: 'arrow-headless', watches: 'arrow-watches', stores: 'arrow-stores',
  uses: 'arrow-uses', binds: 'arrow-binds', subject: 'arrow-subject',
  'scheduled-on': 'arrow-scheduled-on',
};

const EDGE_COLORS = {
  owns: '#4a5a7a', selects: '#7c4dff', mounts: '#26c6da',
  bound: '#a1887f', routes: '#ff7043', scales: '#f06292',
  headless: '#3d5afe',
  // Control plane relationship types (sourced from kubernetes/cmd/)
  watches: '#26a69a', // teal — Informer/ListWatch connection to kube-apiserver
  stores:  '#ef5350', // red  — kube-apiserver persists state to etcd
  // RBAC
  uses:    '#80cbc4', // mint  — Pod uses ServiceAccount
  binds:   '#ce93d8', // lavender — RoleBinding grants Role
  subject: '#ba68c8', // purple — RoleBinding subject (ServiceAccount)
  // Scheduling
  'scheduled-on': '#78909c', // steel-grey — Pod scheduled onto Node
};

// Human-readable tooltip for each edge type (shown on hover)
const EDGE_DESCRIPTIONS = {
  owns:     'owns — the parent created this resource and manages its lifecycle. Deleting the parent cascades (e.g. Deployment → ReplicaSet → Pods).',
  selects:  'selects — Service or NetworkPolicy targets these Pods via label selector. kube-proxy keeps Endpoints current as Pods come and go.',
  mounts:   'mounts — Pod uses this ConfigMap, Secret, or PVC as a volume mount or env-var injection.',
  bound:    'bound — PVC is bound 1:1 to this PersistentVolume. Once bound, the volume is exclusively reserved for this claim.',
  routes:   'routes — Ingress forwards HTTP/S requests to this Service based on hostname or path rules.',
  scales:   'scales — HPA reads metrics and adjusts the replica count of this Deployment or StatefulSet.',
  headless: 'headless — StatefulSet uses this headless Service (clusterIP: None) to give each Pod a stable DNS name: <pod>.<svc>.<ns>.svc.cluster.local.',
  watches:  'watches — connects to kube-apiserver via Informer/ListWatch to receive a live stream of create/update/delete events without polling.',
  stores:   'stores — kube-apiserver is the ONLY component that reads and writes cluster state here. All others talk to the API server, never directly to etcd.',
  uses:     'uses — Pod authenticates to kube-apiserver using this ServiceAccount token (auto-mounted at /var/run/secrets/kubernetes.io/serviceaccount/token).',
  binds:    'binds — RoleBinding grants this Role/ClusterRole\'s permissions to its listed subjects (ServiceAccounts, users, groups).',
  subject:  'subject — this ServiceAccount (or user/group) is listed as a subject of the RoleBinding and receives the bound Role\'s permissions.',
  'scheduled-on': 'scheduled-on — kube-scheduler selected this Node for the Pod. The kubelet on that Node is responsible for starting and managing the container(s).',
};

// Namespace zone visual config
const NS_ZONES = {
  'kube-system': {
    label: 'kube-system',
    fill:   'rgba(30, 60, 140, 0.07)',
    stroke: 'rgba(79, 142, 247, 0.35)',
    labelFill: 'rgba(79, 142, 247, 0.75)',
  },
  'default': {
    label: 'default  ·  Application',
    fill:   'rgba(26, 74, 46, 0.10)',
    stroke: 'rgba(76, 175, 130, 0.50)',
    labelFill: 'rgba(76, 175, 130, 0.85)',
  },
  'monitoring': {
    label: 'monitoring  ·  Observability',
    fill:   'rgba(74, 40, 0, 0.10)',
    stroke: 'rgba(255, 112, 67, 0.50)',
    labelFill: 'rgba(255, 112, 67, 0.85)',
  },
  'cert-manager': {
    label: 'cert-manager  ·  TLS / PKI',
    fill:   'rgba(0, 80, 40, 0.08)',
    stroke: 'rgba(76, 175, 80, 0.40)',
    labelFill: 'rgba(76, 175, 80, 0.80)',
  },
  'redpanda-system': {
    label: 'redpanda-system  ·  Operator',
    fill:   'rgba(80, 20, 0, 0.08)',
    stroke: 'rgba(229, 57, 53, 0.35)',
    labelFill: 'rgba(229, 57, 53, 0.75)',
  },
  'redpanda': {
    label: 'redpanda  ·  Streaming',
    fill:   'rgba(60, 10, 80, 0.08)',
    stroke: 'rgba(171, 71, 188, 0.40)',
    labelFill: 'rgba(171, 71, 188, 0.80)',
  },
  // ArgoCD
  'argocd': {
    label: 'argocd  ·  GitOps',
    fill:   'rgba(20, 40, 100, 0.08)',
    stroke: 'rgba(100, 130, 220, 0.40)',
    labelFill: 'rgba(100, 130, 220, 0.80)',
  },
  'guestbook': {
    label: 'guestbook  ·  GitOps Demo',
    fill:   'rgba(0, 60, 20, 0.08)',
    stroke: 'rgba(76, 175, 80, 0.35)',
    labelFill: 'rgba(76, 175, 80, 0.75)',
  },
  // CNI namespaces
  'kube-flannel': {
    label: 'kube-flannel  ·  CNI',
    fill:   'rgba(0, 60, 80, 0.08)',
    stroke: 'rgba(0, 188, 212, 0.35)',
    labelFill: 'rgba(0, 188, 212, 0.75)',
  },
  'calico-system': {
    label: 'calico-system  ·  CNI',
    fill:   'rgba(80, 40, 0, 0.08)',
    stroke: 'rgba(255, 152, 0, 0.40)',
    labelFill: 'rgba(255, 152, 0, 0.80)',
  },
  'tigera-operator': {
    label: 'tigera-operator  ·  CNI Operator',
    fill:   'rgba(80, 30, 0, 0.07)',
    stroke: 'rgba(230, 120, 0, 0.35)',
    labelFill: 'rgba(230, 120, 0, 0.75)',
  },
  'webapp': {
    label: 'webapp  ·  HPA Demo',
    fill:   'rgba(0, 50, 80, 0.08)',
    stroke: 'rgba(41, 182, 246, 0.40)',
    labelFill: 'rgba(41, 182, 246, 0.80)',
  },
};

function nsZoneConfig(ns) {
  return NS_ZONES[ns] || {
    label: ns,
    fill:   'rgba(60, 60, 80, 0.08)',
    stroke: 'rgba(150, 150, 180, 0.40)',
    labelFill: 'rgba(180, 180, 200, 0.80)',
  };
}

export class SVGGraph {
  constructor(svgEl) {
    this._svg = svgEl;
    this._viewport = svgEl.querySelector('#viewport');
    this._zonesLayer = svgEl.querySelector('#zones-layer');
    this._edgesLayer = svgEl.querySelector('#edges-layer');
    this._nodesLayer = svgEl.querySelector('#nodes-layer');
    this._defs = svgEl.querySelector('#svg-defs');

    this._nodeEls = new Map();   // id → SVGGElement
    this._edgeEls = new Map();   // id → SVGPathElement
    this._zoneEls = new Map();   // namespace|'__cp__' → SVGGElement
    this._positions = {};        // id → {x,y}
    this._nsIndex = new Map();   // id → namespace string
    this._kindIndex = new Map(); // id → kind string
    this._nameIndex = new Map(); // id → display name
    this._onNodeClick = null;
    this._onNodeHover = null;
    this._zoneTick = 0;
    this._filterText = '';

    // Focus mode: when set, dims all nodes/edges not adjacent to this node ID
    this._focusNodeId = null;

    // Zone drag state
    this._nsOffsets = new Map();     // ns → { dx, dy } — mirrors layout offsets
    this._nsDrag = null;             // { ns, startX, startY, baseOffX, baseOffY }
    this._onNsOffsetChange = null;

    // Edge type visibility filter
    this._hiddenEdgeTypes = new Set();

    this._initDefs();
    this._initZoneDrag();
    this._initEdgeTooltip();
  }

  onNodeClick(cb) { this._onNodeClick = cb; }

  // Register callback fired when cursor enters/leaves a node: (nodeId|null, clientX, clientY)
  onNodeHover(cb) { this._onNodeHover = cb; }

  // Register callback fired when user drags a namespace zone: (ns, dx, dy)
  onNsOffsetChange(cb) { this._onNsOffsetChange = cb; }

  // Filter nodes by text — matching nodes brighten, non-matching fade out
  setFilter(text) {
    this._filterText = (text || '').trim().toLowerCase();
    this._applyFilter();
  }

  _applyFilter() {
    const text = this._filterText;
    let matchCount = 0;
    for (const [id, el] of this._nodeEls) {
      if (!text) {
        el.classList.remove('filter-match', 'filter-dim');
      } else {
        const name = (this._nameIndex.get(id) || '').toLowerCase();
        const kind = (this._kindIndex.get(id) || '').toLowerCase();
        const ns   = (this._nsIndex.get(id)   || '').toLowerCase();
        const matches = name.includes(text) || kind.includes(text) || ns.includes(text);
        el.classList.toggle('filter-match', matches);
        el.classList.toggle('filter-dim', !matches);
        if (matches) matchCount++;
      }
    }
    return matchCount;
  }

  getFilterMatchCount() {
    if (!this._filterText) return null;
    let count = 0;
    for (const [, el] of this._nodeEls) if (el.classList.contains('filter-match')) count++;
    return count;
  }

  // Reconcile the SVG DOM with the given node/edge arrays
  render(nodes, edges) {
    // Namespace-kind nodes are shown only as zone boxes — skip the node circles
    nodes = nodes.filter(n => n.kind !== 'Namespace');

    // Update namespace, kind, and name indexes
    this._nsIndex.clear();
    this._kindIndex.clear();
    this._nameIndex.clear();
    for (const n of nodes) {
      this._nsIndex.set(n.id, n.metadata?.namespace || '');
      this._kindIndex.set(n.id, n.kind);
      this._nameIndex.set(n.id, n.metadata?.name || n.id);
    }

    // Remove stale nodes
    const wantNodeIDs = new Set(nodes.map(n => n.id));
    for (const [id, el] of this._nodeEls) {
      if (!wantNodeIDs.has(id)) { el.remove(); this._nodeEls.delete(id); }
    }

    // Add / update nodes
    for (const node of nodes) {
      if (this._nodeEls.has(node.id)) {
        this._updateNodeAppearance(node, this._nodeEls.get(node.id));
      } else {
        const el = this._createNodeEl(node);
        this._nodesLayer.appendChild(el);
        this._nodeEls.set(node.id, el);
      }
    }

    // Remove stale edges
    const wantEdgeIDs = new Set(edges.map(e => e.id));
    for (const [id, el] of this._edgeEls) {
      if (!wantEdgeIDs.has(id)) { el.remove(); this._edgeEls.delete(id); }
    }

    // Add new edges
    for (const edge of edges) {
      if (!this._edgeEls.has(edge.id)) {
        const el = this._createEdgeEl(edge);
        this._edgesLayer.appendChild(el);
        this._edgeEls.set(edge.id, el);
      }
    }

    // Apply current positions
    this.applyPositions(this._positions);

    // Reapply focus after any render so new elements get the right dim state
    if (this._focusNodeId) this._applyFocus();
  }

  // Called by force simulation each tick with updated positions
  applyPositions(positions) {
    this._positions = positions;
    for (const [id, el] of this._nodeEls) {
      const pos = positions[id];
      if (pos) el.setAttribute('transform', `translate(${pos.x},${pos.y})`);
    }
    // Update edge paths
    for (const [id, el] of this._edgeEls) {
      const edge = el._edge;
      if (!edge) continue;
      const src = positions[edge.source];
      const tgt = positions[edge.target];
      if (src && tgt) {
        const d = edgePath(src, tgt, NODE_R);
        if (el._visiblePath) {
          // el is a <g> wrapping visible path + hit path
          el._visiblePath.setAttribute('d', d);
          el._hitPath.setAttribute('d', d);
        } else {
          el.setAttribute('d', d);
        }
        // Reposition edge label at the midpoint of the bezier arc
        if (el._labelEl) {
          const dx = tgt.x - src.x, dy = tgt.y - src.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const lx = (src.x + tgt.x) / 2 - (dy / dist) * 14;
          const ly = (src.y + tgt.y) / 2 + (dx / dist) * 14;
          el._labelEl.setAttribute('x', lx);
          el._labelEl.setAttribute('y', ly);
        }
      }
      // Apply edge type visibility
      el.style.display = this._hiddenEdgeTypes.has(edge.type) ? 'none' : '';
    }
    // Update zones every 6 ticks (throttle for performance)
    this._zoneTick++;
    if (this._zoneTick % 6 === 0) this._renderZones(positions);
  }

  // Show or hide edges of a given type
  setEdgeTypeVisible(type, visible) {
    if (!visible) this._hiddenEdgeTypes.add(type);
    else this._hiddenEdgeTypes.delete(type);
    // Re-apply visibility to existing edges immediately
    for (const [, el] of this._edgeEls) {
      const edge = el._edge;
      if (!edge) continue;
      el.style.display = this._hiddenEdgeTypes.has(edge.type) ? 'none' : '';
    }
  }

  /**
   * Focus mode: highlight a node and its 1-hop neighbors; dim everything else.
   * Pass null to clear focus and return to the normal full view.
   */
  setFocusNode(nodeId) {
    this._focusNodeId = nodeId || null;
    this._applyFocus();
  }

  _applyFocus() {
    const nodeId = this._focusNodeId;

    // Clear all focus classes
    for (const [, el] of this._nodeEls) {
      el.classList.remove('focus-dim');
    }
    for (const [, el] of this._edgeEls) {
      el.classList.remove('focus-dim');
    }

    if (!nodeId) return;

    // Build 1-hop neighborhood: the focused node + all direct neighbors
    const neighborhood = new Set([nodeId]);
    const relevantEdges = new Set();

    for (const [edgeId, el] of this._edgeEls) {
      const edge = el._edge;
      if (!edge) continue;
      if (edge.source === nodeId || edge.target === nodeId) {
        neighborhood.add(edge.source);
        neighborhood.add(edge.target);
        relevantEdges.add(edgeId);
      }
    }

    // Dim nodes outside the neighborhood
    for (const [id, el] of this._nodeEls) {
      if (!neighborhood.has(id)) el.classList.add('focus-dim');
    }

    // Dim edges that don't connect neighborhood nodes
    for (const [edgeId, el] of this._edgeEls) {
      if (!relevantEdges.has(edgeId)) el.classList.add('focus-dim');
    }
  }

  markSelected(id, selected) {
    const el = this._nodeEls.get(id);
    if (!el) return;
    if (selected) el.classList.add('selected');
    else el.classList.remove('selected');
  }

  markPinned(id, pinned) {
    const el = this._nodeEls.get(id);
    if (!el) return;
    if (pinned) {
      el.classList.add('pinned');
      el.title = 'Pinned — double-click to release';
    } else {
      el.classList.remove('pinned');
      el.removeAttribute('title');
    }
  }

  // Apply viewport transform (pan/zoom)
  setViewTransform(tx, ty, scale) {
    this._viewport.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
  }

  getBounds() {
    return this._svg.getBoundingClientRect();
  }

  /**
   * Returns the center of a rendered node in canvas-relative pixel coordinates,
   * or null if the node is not currently rendered.
   * Used by TrafficSim to position animated pulse dots.
   */
  getNodeCenter(nodeId) {
    const el = this._nodeEls.get(nodeId);
    if (!el) return null;
    const canvas = this._svg.closest('#canvas');
    if (!canvas) return null;
    const cr = canvas.getBoundingClientRect();
    const nr = el.getBoundingClientRect();
    return {
      x: nr.left + nr.width  / 2 - cr.left,
      y: nr.top  + nr.height / 2 - cr.top,
    };
  }

  // --- Private ---

  _createNodeEl(node) {
    const g = svgEl('g', { class: `node node-${node.kind}` });
    if (node.simPhase) g.classList.add(`phase-${node.simPhase}`);
    const spec = node.spec ? (typeof node.spec === 'string' ? JSON.parse(node.spec) : node.spec) : {};
    if (spec.type) g.classList.add(`type-${spec.type}`);

    // Tooltip (native browser title)
    const name = node.metadata?.name || node.name || '';
    const ns   = node.metadata?.namespace || '';
    const compDesc = COMPONENT_DESCRIPTIONS[name] || COMPONENT_DESCRIPTIONS[name.split('-')[0]];
    const kindDesc = KIND_DESCRIPTIONS[node.kind] || '';
    const titleParts = [
      `${node.kind}: ${name}`,
      ns ? `namespace: ${ns}` : '',
      compDesc || kindDesc,
    ].filter(Boolean);
    const title = svgEl('title');
    title.textContent = titleParts.join('\n');
    g.appendChild(title);

    // Shape
    const shape = kindShape(node.kind);
    shape.classList.add('node-shape');
    g.appendChild(shape);

    // Kind abbreviation inside shape
    const badge = svgEl('text', { class: 'node-kind-badge', x: 0, y: 1 });
    badge.textContent = KIND_ABBR[node.kind] || node.kind.slice(0, 3).toLowerCase();
    g.appendChild(badge);

    // Resource name below shape
    const label = svgEl('text', { class: 'node-label', x: 0, y: NODE_R + 6 });
    label.textContent = truncate(name, 16);
    g.appendChild(label);

    // Service type sub-label (ClusterIP / NodePort / LoadBalancer / Headless)
    if (node.kind === 'Service') {
      const svcType = spec.clusterIP === 'None' ? 'Headless' : (spec.type || 'ClusterIP');
      const typeLabel = svgEl('text', { class: 'node-svc-type', x: 0, y: NODE_R + 19 });
      typeLabel.textContent = svcType;
      g.appendChild(typeLabel);
    }

    // Phase dot (for pods / simulated resources)
    if (node.kind === 'Pod' || node.simPhase) {
      const dot = svgEl('circle', {
        class: `phase-dot ${node.simPhase || ''}`,
        cx: NODE_R - 6, cy: -(NODE_R - 6),
      });
      g.appendChild(dot);
    }

    // Hover events for the custom floating tooltip
    g.addEventListener('pointerenter', (e) => {
      if (this._onNodeHover) this._onNodeHover(g._nodeID, e.clientX, e.clientY);
    });
    g.addEventListener('pointermove', (e) => {
      if (this._onNodeHover) this._onNodeHover(g._nodeID, e.clientX, e.clientY);
    });
    g.addEventListener('pointerleave', () => {
      if (this._onNodeHover) this._onNodeHover(null, 0, 0);
    });

    g._nodeID = node.id;
    return g;
  }

  _updateNodeAppearance(node, el) {
    el.className.baseVal = `node node-${node.kind}`;
    if (node.simPhase) el.classList.add(`phase-${node.simPhase}`);
    const spec = node.spec ? (typeof node.spec === 'string' ? JSON.parse(node.spec) : node.spec) : {};
    if (spec.type) el.classList.add(`type-${spec.type}`);

    const dot = el.querySelector('.phase-dot');
    if (dot) dot.className.baseVal = `phase-dot ${node.simPhase || ''}`;

    const label = el.querySelector('.node-label');
    if (label) label.textContent = truncate(node.metadata?.name || node.name || '', 16);

    const svcTypeLabel = el.querySelector('.node-svc-type');
    if (svcTypeLabel) {
      const svcType = spec.clusterIP === 'None' ? 'Headless' : (spec.type || 'ClusterIP');
      svcTypeLabel.textContent = svcType;
    }
  }

  _initEdgeTooltip() {
    const tip = document.createElement('div');
    tip.id = 'edge-tooltip';
    document.body.appendChild(tip);
    this._edgeTip = tip;
  }

  _showEdgeTip(edgeType, x, y) {
    const desc = EDGE_DESCRIPTIONS[edgeType] || edgeType;
    // Format: first word capitalised as the "type" header, rest as body
    // desc format is "typename — explanation text"
    const dashIdx = desc.indexOf(' — ');
    let html;
    if (dashIdx !== -1) {
      const typeName = desc.slice(0, dashIdx);
      const explanation = desc.slice(dashIdx + 3);
      const formatted = typeName.charAt(0).toUpperCase() + typeName.slice(1);
      html = `<strong>${formatted}</strong><br>${explanation}`;
    } else {
      const formatted = edgeType.charAt(0).toUpperCase() + edgeType.slice(1);
      html = `<strong>${formatted}</strong><br>${desc}`;
    }
    this._edgeTip.innerHTML = html;

    // Position near cursor, clamped to viewport
    const W = window.innerWidth;
    const H = window.innerHeight;
    const tipW = 340;
    const tipH = 60; // approximate
    let left = x + 14;
    let top  = y - 10;
    if (left + tipW > W - 8) left = x - tipW - 14;
    if (top + tipH > H - 8) top = H - tipH - 8;
    if (top < 8) top = 8;
    this._edgeTip.style.left = `${left}px`;
    this._edgeTip.style.top  = `${top}px`;
    this._edgeTip.classList.add('visible');
  }

  _hideEdgeTip() {
    this._edgeTip.classList.remove('visible');
  }

  _createEdgeEl(edge) {
    const color = EDGE_COLORS[edge.type] || '#4a5a7a';
    const markerID = EDGE_MARKERS[edge.type] || 'arrow-owns';

    // Wrap visible path + hit area in a <g> so both share the same event surface
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'edge-group');
    g.style.cursor = 'default';

    // Hit area — wide transparent path for easier hover targeting
    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('fill', 'none');
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '12');
    hit.setAttribute('class', 'edge-hit');

    // Visible path
    const path = svgEl('path', {
      class: `edge edge-${edge.type}`,
      stroke: color,
      'marker-end': `url(#${markerID})`,
      fill: 'none',
    });

    // Native browser title for accessibility / fallback
    const srcName = this._nameIndex.get(edge.source) || edge.source;
    const tgtName = this._nameIndex.get(edge.target) || edge.target;
    const desc = EDGE_DESCRIPTIONS[edge.type] || edge.type;
    const title = svgEl('title');
    title.textContent = `${srcName}  →  ${tgtName}\n${desc}`;
    path.appendChild(title);

    g.appendChild(hit);
    g.appendChild(path);

    // Optional edge label (e.g. "signs", "provisions", "ca", "tls")
    if (edge.label) {
      const lbl = svgEl('text', { class: 'edge-label' });
      lbl.textContent = edge.label;
      g.appendChild(lbl);
      g._labelEl = lbl;
    }

    // Store edge reference on the group for applyPositions
    g._edge = edge;
    // Also keep a direct reference to the visible path and hit path for position updates
    g._visiblePath = path;
    g._hitPath = hit;

    // Custom floating tooltip events
    g.addEventListener('mousemove', (e) => {
      this._showEdgeTip(edge.type, e.clientX, e.clientY);
    });
    g.addEventListener('mouseleave', () => {
      this._hideEdgeTip();
    });

    return g;
  }

  _renderZones(positions) {
    const PAD = 90;
    const LABEL_H = 32;

    // Compute per-namespace bounding boxes, excluding ControlPlaneComponent nodes
    // (they get their own dedicated zone below)
    const bounds = new Map(); // ns → {minX,minY,maxX,maxY}
    for (const [id, ns] of this._nsIndex) {
      if (!ns) continue;
      if (this._kindIndex.get(id) === 'ControlPlaneComponent') continue;
      const pos = positions[id];
      if (!pos) continue;
      if (!bounds.has(ns)) bounds.set(ns, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      const b = bounds.get(ns);
      b.minX = Math.min(b.minX, pos.x);
      b.minY = Math.min(b.minY, pos.y);
      b.maxX = Math.max(b.maxX, pos.x);
      b.maxY = Math.max(b.maxY, pos.y);
    }

    // Dedicated Control Plane zone for ControlPlaneComponent nodes
    const cpKey = '__cp__';
    const cpBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    let isManaged = false;
    let providerName = '';
    for (const [id, kind] of this._kindIndex) {
      if (kind !== 'ControlPlaneComponent') continue;
      const pos = positions[id];
      if (!pos) continue;
      if (id === 'cp-managed') {
         isManaged = true;
         providerName = this._nameIndex.get(id) || 'Cloud Provider';
      }
      cpBounds.minX = Math.min(cpBounds.minX, pos.x);
      cpBounds.minY = Math.min(cpBounds.minY, pos.y);
      cpBounds.maxX = Math.max(cpBounds.maxX, pos.x);
      cpBounds.maxY = Math.max(cpBounds.maxY, pos.y);
    }
    if (isFinite(cpBounds.minX)) bounds.set(cpKey, cpBounds);

    // Remove zones for namespaces no longer present
    for (const [ns, el] of this._zoneEls) {
      if (!bounds.has(ns)) { el.remove(); this._zoneEls.delete(ns); }
    }

    const CP_ZONE_CFG = {
      label: isManaged ? providerName : 'kube-system (Static Pods)',
      fill:   isManaged ? 'rgba(20, 100, 50, 0.13)' : 'rgba(20, 50, 130, 0.13)',
      stroke: isManaged ? 'rgba(50, 200, 100, 0.65)' : 'rgba(79, 142, 247, 0.65)',
      labelFill: isManaged ? 'rgba(50, 200, 100, 0.95)' : 'rgba(79, 142, 247, 0.95)',
    };

    for (const [ns, b] of bounds) {
      if (!isFinite(b.minX)) continue;
      const cfg = ns === cpKey ? CP_ZONE_CFG : nsZoneConfig(ns);
      const x = b.minX - PAD;
      const y = b.minY - PAD - LABEL_H;
      const w = (b.maxX - b.minX) + PAD * 2;
      const h = (b.maxY - b.minY) + PAD * 2 + LABEL_H;

      if (!this._zoneEls.has(ns)) {
        const g = svgEl('g', { class: 'ns-zone' });
        g.style.cursor = 'grab';
        g.appendChild(svgEl('rect', { class: 'ns-zone-rect', rx: 14, ry: 14 }));
        const lbl = svgEl('text', { class: 'ns-zone-label' });
        lbl.textContent = cfg.label;
        g.appendChild(lbl);

        // Zone drag: capture the zone key via closure
        const zoneNs = ns;
        g.addEventListener('pointerdown', (e) => {
          // If the click landed on a node shape (which floats above), ignore
          if (e.target.closest && e.target.closest('.node')) return;
          e.stopPropagation(); // prevent the viewport pan handler from firing
          const pt = this._toViewportCoords(e.clientX, e.clientY);
          const cur = this._nsOffsets.get(zoneNs) || { dx: 0, dy: 0 };
          this._nsDrag = {
            ns: zoneNs,
            startX: pt.x, startY: pt.y,
            baseOffX: cur.dx, baseOffY: cur.dy,
          };
          g.style.cursor = 'grabbing';
          this._svg.setPointerCapture(e.pointerId);
        });

        this._zonesLayer.appendChild(g);
        this._zoneEls.set(ns, g);
      }

      const g   = this._zoneEls.get(ns);
      const rect = g.querySelector('.ns-zone-rect');
      const lbl  = g.querySelector('.ns-zone-label');

      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width',  Math.max(w, 120));
      rect.setAttribute('height', Math.max(h, 80));
      rect.setAttribute('fill',   cfg.fill);
      rect.setAttribute('stroke', cfg.stroke);

      lbl.setAttribute('x', x + 14);
      lbl.setAttribute('y', y + LABEL_H - 7);
      lbl.setAttribute('fill', cfg.labelFill);
    }
  }

  // Convert a client (screen) coordinate to the SVG viewport coordinate space,
  // correctly accounting for pan/zoom applied to #viewport.
  _toViewportCoords(clientX, clientY) {
    const pt = this._svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = this._viewport.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    return pt.matrixTransform(ctm.inverse());
  }

  // Set a namespace zone offset directly (e.g. when restoring from localStorage).
  setNsOffset(ns, dx, dy) {
    this._nsOffsets.set(ns, { dx, dy });
  }

  // Clear mirrored ns offsets (call when cluster is reset so next drag starts fresh).
  resetNsOffsets() {
    this._nsOffsets.clear();
  }

  // Animate the traffic path from an Ingress node through its connected edges.
  // Pulses Ingress→Service→Pod edges for `durationMs` milliseconds.
  animateTrafficFrom(ingressID, durationMs = 4000) {
    const edgesToAnimate = new Set();
    // Find edges: Ingress → Service (routes), Service → Pod (selects)
    for (const [, el] of this._edgeEls) {
      const e = el._edge;
      if (!e) continue;
      if (e.source === ingressID && e.type === 'routes') {
        edgesToAnimate.add(el);
        // Also find edges from that service
        for (const [, el2] of this._edgeEls) {
          const e2 = el2._edge;
          if (!e2) continue;
          if (e2.source === e.target && e2.type === 'selects') edgesToAnimate.add(el2);
        }
      }
    }
    for (const el of edgesToAnimate) el.classList.add('edge-traffic');
    setTimeout(() => {
      for (const el of edgesToAnimate) el.classList.remove('edge-traffic');
    }, durationMs);
  }

  // Wire up SVG-level pointermove/up for zone dragging.
  // The individual zone pointerdown is added in _renderZones when each zone is first created.
  _initZoneDrag() {
    this._svg.addEventListener('pointermove', (e) => {
      if (!this._nsDrag) return;
      const pt = this._toViewportCoords(e.clientX, e.clientY);
      const dx = this._nsDrag.baseOffX + (pt.x - this._nsDrag.startX);
      const dy = this._nsDrag.baseOffY + (pt.y - this._nsDrag.startY);
      this._nsOffsets.set(this._nsDrag.ns, { dx, dy });
      if (this._onNsOffsetChange) this._onNsOffsetChange(this._nsDrag.ns, dx, dy);
    });

    const endDrag = () => {
      if (!this._nsDrag) return;
      const zoneEl = this._zoneEls.get(this._nsDrag.ns);
      if (zoneEl) zoneEl.style.cursor = 'grab';
      this._nsDrag = null;
    };
    this._svg.addEventListener('pointerup',     endDrag);
    this._svg.addEventListener('pointercancel', endDrag);
  }

  _initDefs() {
    for (const [type, color] of Object.entries(EDGE_COLORS)) {
      const markerID = EDGE_MARKERS[type];
      const marker = svgEl('marker', {
        id: markerID,
        markerWidth: 8, markerHeight: 8,
        refX: 8, refY: 3,
        orient: 'auto',
      });
      marker.appendChild(svgEl('path', { d: 'M0,0 L0,6 L8,3 z', fill: color }));
      this._defs.appendChild(marker);
    }
  }
}

// --- Shape builders ---

function kindShape(kind) {
  switch (kind) {
    case 'Deployment':  return hexagon(NODE_R);
    case 'StatefulSet': return hexagon(NODE_R, 30);
    case 'ReplicaSet':  return pentagon(NODE_R);
    case 'Pod':         return circle(NODE_R);
    case 'Service':     return diamond(NODE_R);
    case 'Ingress':     return chevron(NODE_R);
    case 'ConfigMap':   return square(NODE_R);
    case 'Secret':      return square(NODE_R, 'rounded');
    case 'PersistentVolumeClaim': return cylinder(NODE_R, 'small');
    case 'PersistentVolume':      return cylinder(NODE_R, 'large');
    case 'DaemonSet':   return roundedRect(NODE_R);
    case 'HorizontalPodAutoscaler': return triangle(NODE_R);
    case 'CronJob':     return roundedRect(NODE_R, true);
    case 'Job':                  return square(NODE_R);
    case 'Namespace':            return circle(NODE_R * 2.5);
    case 'ControlPlaneComponent': return octagon(NODE_R);
    case 'CustomResource':        return star4(NODE_R);
    // Redpanda operator CRD kinds — all use star4 (operator-managed resources)
    case 'RedpandaTopic':         return star4(NODE_R * 0.9);
    case 'RedpandaUser':          return star4(NODE_R * 0.9);
    case 'RedpandaSchema':        return star4(NODE_R * 0.9);
    case 'HelmRelease':           return star4(NODE_R);
    case 'HelmRepository':        return star4(NODE_R * 0.85);
    // RBAC
    case 'ServiceAccount':        return shield(NODE_R);
    case 'Role':                  return square(NODE_R * 0.85);
    case 'ClusterRole':           return square(NODE_R * 0.85, 'rounded');
    case 'RoleBinding':           return diamond(NODE_R * 0.8);
    case 'ClusterRoleBinding':    return diamond(NODE_R * 0.85);
    // Infrastructure
    case 'Node':                  return serverShape(NODE_R);
    // External access pseudo-nodes
    case 'ExternalClient':    return cloudShape(NODE_R);
    case 'IngressController': return gatewayShape(NODE_R);
    default:                      return circle(NODE_R);
  }
}

function hexagon(r, rotDeg = 0) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * 60 + rotDeg) * Math.PI / 180;
    pts.push(`${r * Math.cos(a)},${r * Math.sin(a)}`);
  }
  return svgEl('polygon', { points: pts.join(' ') });
}

function pentagon(r) {
  const pts = [];
  for (let i = 0; i < 5; i++) {
    const a = (i * 72 - 90) * Math.PI / 180;
    pts.push(`${r * Math.cos(a)},${r * Math.sin(a)}`);
  }
  return svgEl('polygon', { points: pts.join(' ') });
}

function circle(r)   { return svgEl('circle', { cx: 0, cy: 0, r }); }

function diamond(r) {
  const d = r * 1.2;
  return svgEl('polygon', { points: `0,${-d} ${d},0 0,${d} ${-d},0` });
}

function chevron(r) {
  return svgEl('path', { d: `M${-r},${-r*0.7} L${r*0.5},0 L${-r},${r*0.7} L${-r*0.4},0 Z` });
}

function square(r, variant) {
  const s = r * 1.3;
  if (variant === 'rounded') return svgEl('rect', { x: -s, y: -s, width: s*2, height: s*2, rx: 6, ry: 6 });
  return svgEl('rect', { x: -s, y: -s, width: s*2, height: s*2 });
}

function cylinder(r, size) {
  const w = size === 'large' ? r * 1.5 : r * 1.2;
  const h = size === 'large' ? r * 1.8 : r * 1.4;
  const ry = h * 0.18;
  const g = svgEl('g');
  g.appendChild(svgEl('rect', { x: -w, y: -h/2 + ry, width: w*2, height: h - ry }));
  g.appendChild(svgEl('ellipse', { cx: 0, cy: -h/2 + ry, rx: w, ry }));
  return g;
}

function roundedRect(r, small) {
  const w = small ? r * 1.4 : r * 1.6;
  const h = small ? r * 0.9 : r * 1.1;
  return svgEl('rect', { x: -w, y: -h, width: w*2, height: h*2, rx: 8, ry: 8 });
}

function triangle(r) {
  const h = r * 1.5;
  return svgEl('polygon', { points: `0,${-h} ${r*1.2},${h*0.6} ${-r*1.2},${h*0.6}` });
}

// 4-pointed star — used for CustomResource (CRD instances from operators)
function star4(r) {
  const inner = r * 0.38;
  const d = `M0,${-r} L${inner},${-inner} L${r},0 L${inner},${inner} L0,${r} L${-inner},${inner} L${-r},0 L${-inner},${-inner} Z`;
  return svgEl('path', { d });
}

function octagon(r) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * 45 + 22.5) * Math.PI / 180;
    pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
  }
  return svgEl('polygon', { points: pts.join(' ') });
}

// Shield shape for ServiceAccount — suggests identity/auth
function shield(r) {
  const w = r * 1.1, h = r * 1.3;
  return svgEl('path', {
    d: `M0,${-h} L${w},${-h * 0.5} L${w},${h * 0.1} Q0,${h} 0,${h} Q0,${h} ${-w},${h * 0.1} L${-w},${-h * 0.5} Z`
  });
}

// Server/rack shape for Node — represents physical/virtual machine
function serverShape(r) {
  const w = r * 1.6, h = r * 1.0;
  const g = svgEl('g');
  // Body
  g.appendChild(svgEl('rect', { x: -w, y: -h, width: w * 2, height: h * 2, rx: 4, ry: 4 }));
  // Status LED stripe
  g.appendChild(svgEl('rect', { x: w - 10, y: -h + 4, width: 6, height: 6, rx: 3, ry: 3, class: 'node-led' }));
  return g;
}

// Cloud shape for ExternalClient (internet pseudo-node)
function cloudShape(r) {
  const s = r * 1.05;
  // Three overlapping arcs forming a cloud silhouette, centered at origin
  const d = [
    `M${-s*0.55},${s*0.35}`,
    `Q${-s*1.05},${s*0.35} ${-s*0.95},${-s*0.05}`,
    `Q${-s*0.95},${-s*0.55} ${-s*0.35},${-s*0.55}`,
    `Q${-s*0.25},${-s*0.95} ${s*0.1},${-s*0.85}`,
    `Q${s*0.45},${-s*1.05} ${s*0.7},${-s*0.6}`,
    `Q${s*1.05},${-s*0.5} ${s*0.9},${-s*0.05}`,
    `Q${s*0.95},${s*0.35} ${s*0.55},${s*0.35}`,
    'Z',
  ].join(' ');
  return svgEl('path', { d });
}

// Gateway/proxy shape for IngressController — forward-pointing arrow body
function gatewayShape(r) {
  const w = r * 1.1, h = r * 0.7, tip = r * 1.3;
  const d = `M${-w},${-h} L${w*0.3},${-h} L${tip},0 L${w*0.3},${h} L${-w},${h} L${-w*0.4},0 Z`;
  return svgEl('path', { d });
}

// Edge path: line from edge of src to edge of tgt with slight curve
function edgePath(src, tgt, r) {
  const dx = tgt.x - src.x;
  const dy = tgt.y - src.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const x1 = src.x + ux * r;
  const y1 = src.y + uy * r;
  const x2 = tgt.x - ux * (r + 10);
  const y2 = tgt.y - uy * (r + 10);
  const mx = (x1 + x2) / 2 - uy * 20;
  const my = (y1 + y2) / 2 + ux * 20;
  return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function truncate(s, maxLen) {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}
