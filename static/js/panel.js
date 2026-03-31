// panel.js — Detail panel renderer

import { api } from './api.js';

// Educational descriptions shown in the detail panel
const KIND_DESCRIPTIONS = {
  Deployment:    'Manages a set of identical, stateless Pods via a ReplicaSet. Supports declarative rolling updates (<code>maxUnavailable</code> / <code>maxSurge</code>), automatic rollbacks, and pause/resume. When you update the image or spec, a new ReplicaSet is created and the old one is scaled down gradually. Scale manually with <code>kubectl scale</code> or automatically with an HPA.',
  ReplicaSet:    'Ensures a specified number of Pod replicas are always running. Created and owned by a Deployment — rarely used directly. The controller watches for Pod failures and creates replacements. The RS name includes a hash of the pod template so each new Deployment revision gets a fresh RS (enables instant rollback).',
  Pod:           'The smallest schedulable unit. One or more containers that share a network namespace (same IP + ports) and can share volumes. Pods are ephemeral — they are never restarted in-place; a new Pod is created instead. Container probes (liveness, readiness, startup) control health checks and traffic routing.',
  Service:       'A stable virtual IP (ClusterIP) and DNS name backed by kube-proxy rules that load-balance traffic to matching Pods. Types: <em>ClusterIP</em> (cluster-internal only), <em>NodePort</em> (opens a port on every Node), <em>LoadBalancer</em> (provisions a cloud LB), <em>ExternalName</em> (DNS alias to an external hostname). The label selector determines which Pods receive traffic — updated automatically as Pods come and go.',
  Ingress:       'Defines HTTP/HTTPS routing rules to forward external traffic to Services inside the cluster. Rules can match by hostname (<code>app.example.com</code>) or URL path prefix. Requires an <em>Ingress Controller</em> (nginx, Traefik, etc.) to be installed — the Ingress object itself does nothing without one. TLS termination is configured here via a Secret containing the certificate and private key.',
  ConfigMap:     'Stores non-confidential configuration as key-value pairs or whole files. Injected into Pods as environment variables (<code>envFrom</code> / <code>env.valueFrom</code>) or mounted as a volume. Changes to a mounted ConfigMap propagate to running Pods within ~60s; env-var injections require a Pod restart to take effect.',
  Secret:        'Stores sensitive data (passwords, tokens, TLS certs, SSH keys) as base64-encoded values. <strong>Base64 is encoding, not encryption</strong> — enable <em>Encryption at Rest</em> via the EncryptionConfiguration API and consider an external vault (HashiCorp Vault, AWS Secrets Manager). Built-in types: <em>Opaque</em> (generic), <em>kubernetes.io/tls</em>, <em>kubernetes.io/service-account-token</em>, <em>kubernetes.io/dockerconfigjson</em>.',
  PersistentVolumeClaim: 'A developer\'s request for durable storage: specifies size, access mode (ReadWriteOnce, ReadWriteMany, ReadOnlyMany), and optionally a StorageClass. The PV controller binds it to a matching PersistentVolume — either pre-provisioned or dynamically created by a CSI driver. The PVC lifecycle is independent of any Pod; data survives Pod deletion.',
  PersistentVolume: 'A piece of durable storage in the cluster (cloud disk, NFS share, local SSD) provisioned by an admin or dynamically by a CSI driver. Bound 1:1 to a PVC. Reclaim policy controls what happens when the PVC is deleted: <em>Retain</em> (keep data, manual cleanup needed), <em>Delete</em> (delete underlying volume), <em>Recycle</em> (deprecated).',
  StatefulSet:   'Manages stateful applications where each replica needs a stable identity. Each Pod gets a predictable ordinal name (<code>&lt;name&gt;-0</code>, <code>&lt;name&gt;-1</code>…), stable DNS hostname via a headless Service, and its own PVC from <code>volumeClaimTemplates</code>. Default pod management is <em>OrderedReady</em> — pod N must be Running before N+1 starts. Scale-down happens in reverse ordinal order.',
  DaemonSet:     'Ensures exactly one Pod runs on every Node (or Nodes matching a <code>nodeSelector</code>). Kubernetes automatically adds a Pod when a new Node joins the cluster and removes it when the Node is removed. Common uses: log shippers (Fluentd, Fluent Bit), node monitoring agents (node-exporter, Datadog), network plugins (Calico, Cilium), and security agents.',
  HorizontalPodAutoscaler: 'Watches CPU/memory utilization via metrics-server (or custom/external metrics via a metrics adapter) and automatically adjusts the replica count of a Deployment or StatefulSet. Scale-up is fast and reactive; scale-down waits for a <em>stabilization window</em> (default 5 min) to prevent flapping. HPA v2 supports multiple simultaneous metrics, scaling policies, and per-metric target utilization.',
  CronJob:       'Creates Jobs on a repeating schedule using cron syntax (e.g. <code>0 3 * * *</code> = 3am UTC daily). Each scheduled trigger creates a new Job object. Configure <code>concurrencyPolicy</code> (Allow/Forbid/Replace) to control overlapping runs, and <code>successfulJobsHistoryLimit</code> / <code>failedJobsHistoryLimit</code> to limit how many finished Jobs are retained.',
  Job:           'Creates one or more Pods and tracks successful completions. Once <code>completions</code> Pods succeed, the Job is done. <code>parallelism</code> controls how many run simultaneously. <em>Indexed Jobs</em> give each Pod a <code>JOB_COMPLETION_INDEX</code> env var for sharded work. On failure the Job retries up to <code>backoffLimit</code> times. Use Jobs for batch processing, DB migrations, or one-off scripts.',
  Namespace:     'A virtual partition within a cluster. Resource names must be unique within a namespace but not across namespaces. Provides scope for RBAC policies, ResourceQuotas, and LimitRanges. Built-in namespaces: <em>kube-system</em> (control-plane add-ons), <em>kube-public</em> (readable by unauthenticated users), <em>default</em> (fallback when no namespace is specified).',
  ControlPlaneComponent: 'A core Kubernetes control-plane component. These components (kube-apiserver, etcd, kube-scheduler, kube-controller-manager) run as <em>static Pods</em> on control-plane nodes — defined in <code>/etc/kubernetes/manifests/</code> and managed directly by the kubelet, not by a Deployment or ReplicaSet. Click on the component name to see detailed information.',
  CustomResource: 'An instance of a Custom Resource Definition (CRD) installed by an operator. Operators extend the Kubernetes API with new object types and deploy a controller that watches for these CRs. When you create or update a CR, the operator\'s reconcile loop runs and converges actual resources (StatefulSets, Services, Secrets, etc.) toward the desired state you declared in the CR.',
  Node:          'A worker machine in the cluster (physical server or VM). The <em>kubelet</em> is an agent that reports Node status and manages Pod lifecycle (starts/stops containers). <em>kube-proxy</em> maintains iptables/ipvs rules for Service routing. The <em>container runtime</em> (containerd, CRI-O) actually runs containers. Node conditions (Ready, MemoryPressure, DiskPressure, PIDPressure) determine schedulability. Use <code>kubectl cordon</code> to stop new Pod scheduling without evicting existing Pods.',
  ServiceAccount: 'An identity for processes running inside a Pod. Kubernetes auto-mounts a short-lived JWT token at <code>/var/run/secrets/kubernetes.io/serviceaccount/token</code> (via TokenRequest API in v1.21+). The kube-apiserver uses this token to authenticate and authorize API calls from within the Pod. Bind a ServiceAccount to Roles via RoleBindings to grant it only the permissions it needs (principle of least privilege).',
  Role:           'Namespace-scoped permission set. Defines which <em>verbs</em> (get, list, watch, create, update, patch, delete) are allowed on which API <em>resources</em> (pods, services, secrets…) and optional <em>resourceNames</em>. Must be activated by binding it to a subject (ServiceAccount, user, group) via a RoleBinding in the same namespace.',
  ClusterRole:    'Cluster-wide permission set. Like Role but not scoped to a single namespace — essential for operators, node agents, and controllers that must access resources across all namespaces. Also the only way to grant permissions on cluster-scoped resources (Nodes, PersistentVolumes, Namespaces, ClusterRoles themselves).',
  RoleBinding:    'Grants a Role (or ClusterRole scoped to this namespace) to one or more subjects: ServiceAccount, user, or group. The binding is namespace-scoped — the subject gets permissions only within the namespace where the RoleBinding lives.',
  ClusterRoleBinding: 'Grants a ClusterRole cluster-wide to one or more subjects. Used for cluster-level components (kube-scheduler, cloud-controller-manager, operators) that need cross-namespace access. Avoid granting <code>cluster-admin</code> broadly; prefer narrowly scoped ClusterRoles for each component.',
  NetworkPolicy:  'Restricts pod-to-pod and pod-to-external communication using label selectors. By default all Pods can reach all other Pods — a NetworkPolicy opts selected Pods into isolation. <em>Ingress rules</em> control which sources can send traffic in; <em>egress rules</em> control where traffic can go out. <strong>Requires a CNI plugin that enforces NetworkPolicy</strong> (Calico, Cilium, Weave) — applying a NetworkPolicy without such a CNI has no effect.',
  ResourceQuota:  'Caps aggregate resource consumption per namespace: CPU/memory requests and limits, number of Pods, PVCs, Services, Secrets, ConfigMaps, etc. When a create/update request would exceed the quota, it is rejected with a <code>403 Forbidden</code> ("exceeded quota"). Pair with a LimitRange to set per-container defaults so every Pod has resource requests set (required for CPU/memory quota enforcement).',
  // cert-manager CRDs
  Certificate:    'A cert-manager Certificate CR declares the desired x.509 certificate: DNS names, validity duration, renewal threshold, and the Issuer/ClusterIssuer to use. The cert-manager controller generates a private key, submits a CertificateRequest to the configured issuer backend, and stores the signed certificate + private key in the Secret named in <code>spec.secretName</code>. cert-manager monitors expiry and auto-renews (default: at 2/3 of the certificate lifetime).',
  Issuer:         'A cert-manager Issuer is a namespace-scoped certificate authority configuration. Supported backends: <em>SelfSigned</em> (self-signed certs), <em>CA</em> (sign with a Secret containing a CA cert + key), <em>ACME</em> (Let\'s Encrypt via HTTP-01 or DNS-01 challenge), <em>Vault</em>, <em>Venafi</em>. Only Certificate objects in the same namespace can reference an Issuer; use ClusterIssuer for cross-namespace access.',
  ClusterIssuer:  'Like Issuer but cluster-scoped — Certificate objects in any namespace can reference it. Useful for a shared Let\'s Encrypt ACME account or an internal CA that multiple teams share. Configuration is identical to Issuer; the only difference is that it is not tied to a single namespace.',
  // ArgoCD CRDs
  Application:    'An ArgoCD Application CR declares three things: <em>source</em> (Git repo URL + path + revision), <em>destination</em> (target cluster + namespace), and <em>sync policy</em>. The application-controller continuously compares live cluster state with the Git-declared state and reports Sync/Health status. With <em>auto-sync</em> enabled it applies changes automatically; with <em>auto-prune</em> it removes resources deleted from Git.',
  // Redpanda operator CRDs
  RedpandaTopic:  'A Redpanda Topic CR (cluster.redpanda.com/v1alpha2). The Redpanda operator watches Topic CRs and reconciles the actual Kafka topic via the rpk Admin API. Spec controls partitions, replication factor, retention.ms, cleanup.policy, and any topic-level config overrides. Deleting the CR can optionally delete the underlying Kafka topic depending on the operator\'s <code>deletionPolicy</code>.',
  RedpandaUser:   'A Redpanda User CR declares a SASL user identity and ACL rules. The operator syncs user credentials (password pulled from a Secret reference) and grants or revokes ACLs via the Redpanda Admin API. Supports SCRAM-SHA-256 and SCRAM-SHA-512 authentication mechanisms.',
  RedpandaSchema: 'A Redpanda Schema CR registers and manages schemas in the Redpanda Schema Registry (port 8081). Supports Avro, Protobuf, and JSON Schema formats. The operator enforces compatibility settings (BACKWARD, FORWARD, FULL, NONE) and evolves schemas by submitting new versions to the registry.',
  HelmRelease:    'A FluxCD HelmRelease CR (helm.toolkit.fluxcd.io/v2). Used by the legacy Redpanda operator (v0.x with <code>useFlux: true</code>). FluxCD\'s helm-controller fetches the chart from a HelmRepository, renders values, and applies the resulting manifests. The operator only manages the HelmRelease CR; FluxCD handles the Helm lifecycle.',
  HelmRepository: 'A FluxCD HelmRepository CR points the source-controller to a Helm chart repository (e.g. <code>https://charts.redpanda.com</code>). The source-controller polls the repo, fetches the index, and makes charts available to HelmRelease objects in the cluster. Used by the legacy Redpanda operator v0.x path.',
  // Storage / Quota
  StorageClass:   'Defines a class of storage and the CSI provisioner that creates volumes dynamically (e.g. <code>ebs.csi.aws.com</code>, <code>pd.csi.storage.gke.io</code>). PVCs reference a StorageClass by name to request a specific type of disk. The StorageClass marked <em>default</em> is used when a PVC omits <code>storageClassName</code>. Parameters map to CSI driver-specific options (disk type, IOPS tier, encryption).',
  LimitRange:     'Sets per-Pod, per-Container, or per-PVC default resource requests/limits and minimum/maximum bounds within a namespace. When a container spec omits resource requests, the LimitRange <code>defaultRequest</code> is injected by the admission controller. This is required for ResourceQuota CPU/memory enforcement — Kubernetes will not admit a Pod without resource requests when a CPU or memory quota is active.',
  // External access pseudo-nodes (simulator-only)
  ExternalClient:    '<em>Simulator pseudo-node</em> — represents an external client or the public internet. Automatically appears whenever a <em>LoadBalancer</em> or <em>NodePort</em> Service or an <em>Ingress</em> resource is present. Wired via <code>routes</code> edges to show how traffic enters the cluster from outside. Not a real Kubernetes resource.',
  IngressController: '<em>Simulator pseudo-node</em> — represents the Ingress Controller (typically <code>ingress-nginx</code> or Traefik) running inside the cluster. Sits between the internet and your Ingress rules. The controller is a Pod (or Deployment) that watches Ingress objects and programs the underlying proxy. It reads Ingress rules, terminates TLS (using Secrets), and forwards HTTP/S traffic to the target Service. Not a real Kubernetes resource — click an Ingress node to see the actual routing rules.',
};

const COMPONENT_DESCRIPTIONS = {
  'coredns': 'The cluster DNS server. Every Service gets a DNS A record (<code>&lt;svc&gt;.&lt;ns&gt;.svc.cluster.local</code> → ClusterIP). Pods get records too (<code>10-244-1-5.&lt;ns&gt;.pod.cluster.local</code>). Unknown domains are forwarded to the Node\'s upstream resolver. Configured via a <code>Corefile</code> ConfigMap in kube-system. Typically runs as 2 replicas for HA. Without CoreDNS, service discovery by name does not work.',
  'kube-proxy': 'Runs as a DaemonSet on every Node. Watches Services and EndpointSlices and programs iptables (or ipvs) rules so that traffic sent to a Service ClusterIP is DNAT\'d to one of the backend Pod IPs. In iptables mode, traffic is balanced randomly across Pods. kube-proxy does not proxy traffic itself — it only installs kernel-level forwarding rules.',
  'kube-apiserver': 'The front door to the cluster and the <strong>only</strong> component that talks to etcd. All <code>kubectl</code> commands, controller watches, kubelet heartbeats, and webhook calls go through here. Enforces authentication (x.509 certs, tokens, OIDC), authorization (RBAC/ABAC/Node), and admission control (mutating then validating webhooks) on every request. Horizontally scalable — use a load balancer in HA setups.',
  'etcd': 'A distributed key-value store using the Raft consensus protocol. Holds all cluster state: object specs, status subresources, Secrets, and leader-election leases. Only kube-apiserver reads and writes etcd — all other components talk to the API server. If etcd loses quorum the cluster becomes read-only: no new Pods can be scheduled and no configuration changes take effect. Back it up regularly with <code>etcdctl snapshot save</code>.',
  'kube-scheduler': 'Watches for Pods with an empty <code>spec.nodeName</code> and assigns them to Nodes using a two-phase process. <em>Filtering</em> eliminates Nodes that cannot satisfy constraints (resource requests, node affinity, taints/tolerations, topology spread). <em>Scoring</em> ranks remaining Nodes (balances resource utilization, prefers nodes with required images, etc.) and picks the highest score. Writes the chosen Node name back via a Pod binding, which triggers the kubelet on that Node.',
  'kube-controller-manager': 'A single binary running 40+ reconciliation controllers in parallel goroutines. Key controllers: <em>Deployment</em> (manages ReplicaSets), <em>ReplicaSet</em> (manages Pods), <em>DaemonSet</em>, <em>StatefulSet</em>, <em>Job</em>, <em>CronJob</em>, <em>Node</em> (evicts pods from NotReady nodes after <code>node-eviction-timeout</code>), <em>PV</em> (binds PVCs to PVs), <em>HPA</em>, <em>Namespace</em>, <em>ServiceAccount</em>, <em>EndpointSlice</em>. All communicate exclusively through kube-apiserver via Informer/ListWatch.',
  'cloud-controller-manager': 'Runs cloud-provider-specific controllers decoupled from the core kube-controller-manager. <em>Node controller</em>: initializes cloud metadata for new Nodes and removes terminated VMs. <em>Route controller</em>: configures cloud network routes between Nodes. <em>Service controller</em>: provisions cloud load balancers for LoadBalancer-type Services. Ships separately per cloud (aws-cloud-controller-manager, gce, azure, etc.).',
  'prometheus': 'Time-series metrics database that scrapes <code>/metrics</code> HTTP endpoints from Pods and Nodes at configurable intervals. Data is stored in a local TSDB with configurable retention (default 15d). Uses PromQL for queries and alerting rules. Typically deployed with <em>Alertmanager</em> (alert routing/deduplication) and <em>Grafana</em> (dashboards). In Kubernetes, ServiceMonitor/PodMonitor CRDs (from kube-prometheus-stack) declaratively configure scrape targets.',
  // cert-manager
  'cert-manager': 'The cert-manager controller is the main reconciliation engine. It watches Certificate, CertificateRequest, Issuer, and ClusterIssuer objects. When a Certificate CR appears, the controller: (1) generates a private key, (2) creates a CertificateRequest, (3) submits it to the configured Issuer backend (ACME, CA, Vault…), (4) stores the signed certificate + key in the target Secret. Monitors expiry and auto-renews (default: at 2/3 of the certificate lifetime, configurable via <code>spec.renewBefore</code>).',
  'cert-manager-webhook': 'An admission webhook server registered with kube-apiserver. It runs <strong>synchronously</strong> inside the API call path — every create/update of a cert-manager CRD (Certificate, Issuer, ClusterIssuer, CertificateRequest, etc.) is validated here before being persisted to etcd. This prevents malformed or insecure CRs from being stored. Also performs resource defaulting via mutating admission (fills in optional fields). <strong>If the webhook Pod is down, all cert-manager CR operations will fail</strong> with a "connection refused" or timeout error.',
  'cert-manager-cainjector': 'Injects CA bundle data into the <code>caBundle</code> field of ValidatingWebhookConfiguration, MutatingWebhookConfiguration, and APIService objects. This is required so kube-apiserver trusts the TLS certificate presented by the webhook server. The cainjector watches Certificate and Secret objects annotated with <code>cert-manager.io/inject-ca-from</code> and automatically copies the CA certificate into the referenced webhook/apiservice configurations whenever the CA cert changes.',
  // ArgoCD
  'argocd-server': 'The ArgoCD API server and web UI backend. Exposes REST/gRPC APIs consumed by the <code>argocd</code> CLI and browser UI. Handles SSO/OIDC authentication, RBAC policy enforcement, app management requests (sync, diff, rollback, delete), and WebSocket streaming for live log tailing. Communicates with the application-controller (sync status) and repo-server (rendered manifests).',
  'argocd-application': 'The ArgoCD application-controller. Runs a continuous reconciliation loop that compares desired state (rendered from Git) with live cluster state (Kubernetes API). Computes and reports Sync status (Synced/OutOfSync) and Health status (Healthy/Degraded/Progressing/Missing). Triggers sync operations (automatically with auto-sync, or on-demand). Manages app-of-apps patterns and handles resource pruning when objects are removed from Git.',
  'argocd-repo': 'The ArgoCD repo-server. Clones and caches Git repositories locally, then renders manifests using the appropriate tool: plain YAML, Helm (renders chart with values), Kustomize, or Jsonnet. Returns rendered Kubernetes objects to the application-controller for comparison and sync. Runs in isolation for security — manifest generation happens here, not in the controller. Supports Config Management Plugins (CMP) for custom toolchains.',
  // Redpanda
  'redpanda': 'The top-level Redpanda Custom Resource. Create this object to declare "I want a Redpanda cluster with these settings." The redpanda-operator watches for it via Informer and reconciles all dependent resources: a StatefulSet for broker Pods, a headless Service for stable Pod DNS names, a LoadBalancer/NodePort Service for client access, ConfigMaps for broker config, Secrets for TLS certificates and SASL credentials, and optionally a Redpanda Console Deployment. Edit this CR to change broker count, resource limits, TLS settings, or enable features like Schema Registry.',
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
