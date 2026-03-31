# k8sVisualizer — Showcase Guide

A quick reference for demos, talks, or anyone evaluating the project.

---

## What it is

A fully self-contained Kubernetes cluster simulator that runs in any browser. No real cluster needed, no cloud account, no Helm release. One binary, one port, zero dependencies at runtime. It teaches how Kubernetes actually works by letting you watch resources appear, connect, fail, and recover in real time.

The core idea: Kubernetes is hard to learn partly because the graph of resources (who owns what, what selects what, what mounts what) is invisible. This makes it visible.

---

## The best things to show

### 1. The live graph

The canvas is an SVG graph that updates in real time over SSE. Every resource is a node, every relationship is a typed edge. Open the app and walk through what you see:

- **Node shapes** encode kind: hexagon = Pod, rounded box = Deployment, diamond = StatefulSet, etc.
- **Edge colours** encode relationship type: ownership (creates), selection (label matching), mounting, binding, routing, scheduling
- **Phase dots** on Pods show Running / Pending / Terminating / CrashLoopBackOff without you having to click anything
- **Namespace zones** are draggable background regions — you can rearrange the canvas and the positions persist across reloads (localStorage)
- Individual nodes are also draggable and pin in place; double-click to release back to the auto-layout

### 2. The Redpanda Helm scenario (~2 min)

This is the centrepiece. Click **"Install redpanda (operator + chart)"** and watch 59 steps execute live:

1. `helm repo add redpanda` — just a log line
2. Operator namespace and RBAC resources appear
3. Operator Deployment → ReplicaSet → Pod transition Pending → ContainerCreating → Running
4. `helm install redpanda` — the Redpanda CustomResource is created
5. Operator detects the CR via Informer, begins reconciling
6. ConfigMap (bootstrap.yaml + redpanda.yaml), Secret, headless + external Services all appear, all owned by the CR
7. StatefulSet with `podManagementPolicy=OrderedReady` — pod-0 starts and reaches Running before pod-1 starts, which must be Running before pod-2 starts (Raft quorum explained inline)
8. Each pod gets its own PVC → PV (dynamic provisioning)
9. Post-install Job applies Layer 3 admin API config
10. Topic, User, Schema custom resources appear

The terminal log narrates every step the way `helm install --debug` would. The graph goes from empty to a full production-grade Redpanda cluster. This is what a `helm install` actually does — most people have never seen it laid out this way.

**Point to note:** operator and cluster are in the **same namespace** (`redpanda`). That reflects how most Redpanda deployments actually work since v2.x. Cross-namespace support was added in a later release and this is explicitly called out in the step log.

### 3. Failure injection

**Crash loop** — pick any Pod from the panel, inject a crash. Watch the pod phase cycle: Running → CrashLoopBackOff, restart count increment, the exponential backoff timing (10s→20s→40s) explained inline. The pod stays in the graph. This is what your on-call engineer sees at 3am.

**Readiness probe failure** — the pod stays `Running` but the `selects` edges from its Services disappear. Traffic stops reaching it with zero restarts. This is the distinction that trips up most people learning probes: liveness = restart, readiness = endpoint removal.

**Node NotReady** — kubelet stops heartbeating. The node-controller taint fires after the 300-second tolerance. All pods on that node transition to Failed with eviction messages. Then run **Kubelet Recovery** to watch the node come back, conditions restore, and pods reschedule.

**ImagePullBackOff**, **OOMKill**, **Liveness probe failure** are all there with realistic timing and the exact kubectl commands you'd run to diagnose each one.

### 4. Canary deployment scenario

Shows the pure-Kubernetes canary pattern without Istio or any service mesh. Three stable pods (v1.0) and one canary pod (v1.1) both selected by the same Service via `app=myapp`. kube-proxy round-robins across all four endpoints → 75%/25% traffic split by pod count. You can see this in the graph: the Service node has four `selects` edges, three pointing to stable pods and one to canary. The scenario then promotes the canary by scaling stable to 0 and canary to 3.

### 5. The terminal

Press `` ` `` to open a simulated shell. Everything runs against the in-memory cluster:

```
kubectl get pods -A
kubectl get events
kubectl describe pod redpanda-0 -n redpanda
kubectl top pods -n redpanda
kubectl scale sts/redpanda --replicas=5 -n redpanda
kubectl exec redpanda-0 -n redpanda -- hostname
kubectl rollout status deployment/redpanda-operator -n redpanda
kubectl delete namespace redpanda
helm list -n redpanda
helm status redpanda
helm uninstall redpanda
```

`kubectl get` shows the real column layout (READY/STATUS/RESTARTS for pods, TYPE/CLUSTER-IP/PORT(S) for services, STATUS/VOLUME/CAPACITY for PVCs). The graph updates as you run commands — scale a StatefulSet in the terminal and watch pods appear/disappear on the canvas.

### 6. Kubernetes version switching

18 versions tracked, 1.16 through 1.33. Switch the version picker and the detail panel reflects what APIs are available, what was deprecated, and what was removed in that version. Good for answering "when did Ingress move out of extensions/v1beta1?" without looking it up.

### 7. The bootstrap flows

Start from an empty cluster and build it up step by step:

- **kubeadm path**: Control Plane → CoreDNS → CNI (Flannel / Calico / Cilium) → kube-proxy → worker nodes
- **Managed path**: EKS / GKE / AKS with pre-provisioned control plane
- **k3s**: single binary, everything bundled
- **HA**: 3 etcd nodes + 3 API servers + 3 workers behind a load balancer

Watch the control-plane edges appear: `scheduler → watches → apiserver`, `apiserver → stores → etcd`, coreDNS pod selected by kube-dns service. This is the answer to "what actually runs on a control plane node?"

### 8. Edge type filter

The sidebar has a filter for every edge type. Toggle off `owns` to see only the network/selection topology. Toggle off everything except `mounts` to see exactly which pods mount which ConfigMaps and Secrets. Good for explaining RBAC permission flows and storage layouts without the graph getting noisy.

---

## What makes the implementation interesting

**Single binary, zero runtime dependencies.** Static files are embedded with `//go:embed static` and served from memory. `FROM scratch` Docker image, `readOnlyRootFilesystem: true` works out of the box. The binary is ~12MB.

**Real-time over SSE, not polling.** The backend pushes typed events (`resource.created`, `resource.updated`, `scenario.step`) over a single persistent connection per browser tab. The frontend does a DOM reconciliation pass on each event — only the changed nodes are re-rendered.

**The reconciler loop.** The simulation engine runs a tick every 5 seconds and runs a set of reconcilers that mirror what actual Kubernetes controllers do:
- Deployments ensure pod count = spec.replicas (creates/terminates pods)
- StatefulSets enforce ordered pod naming and startup
- DaemonSets create one pod per node
- PVC reconciler does dynamic provisioning (creates PV, binds, creates StorageClass)
- HPA reconciler random-walks CPU and scales the target Deployment
- Custom resource reconciler syncs CR spec to its owned StatefulSet — this is why the Redpanda CR controls the broker count

**The layout engine.** Uses a deterministic static grid layout (not force-directed) so the graph is stable. Each resource kind has a vertical rank (Services above Deployments above Pods above PVCs) and each namespace gets a column. Pinned nodes and namespace offsets are saved to localStorage. The layout is instant — no simulation convergence delay.

**CRD schemas embedded at build time.** The `task update-schemas` command fetches Redpanda operator CRD JSON schemas from GitHub releases and embeds them in the binary. The detail panel shows live field descriptions and validation rules directly from the CRD, not from hardcoded strings.

---

## Talking points by audience

**Platform/infra engineers:** The reconciler loops, cascade-on-delete semantics (CNI removal → all pods NetworkNotReady, etcd deletion → cluster-wide failure), PV reclaim policy enforcement, and the Redpanda operator scenario match real operational experience. The readiness vs liveness probe distinction is exactly the kind of thing that bites people in production.

**Developers new to Kubernetes:** The bootstrap flows and Helm scenario make the "magic" of a running cluster concrete. Every resource that appears in the graph was created by something with a reason. The terminal gives them a safe place to run kubectl without breaking anything.

**Platform engineers evaluating Redpanda:** The scenario shows the exact resource topology produced by `helm install redpanda-operator` + `helm install redpanda` — namespaces, RBAC, CRD, operator deployment, CR, StatefulSet, headless service, PVC/PV per broker, ConfigMap layers, post-install job. It's an accurate model of what ends up in the cluster.

**Conference/meetup demo:** Run `go run . --mode=full`, open the browser, show the full cluster, inject a crash loop, recover it, deploy Redpanda, then run the canary scenario. About 8 minutes of live interaction with no setup required.

---

## Quick start for a demo

```bash
# From source
go run . --mode=full

# Or Docker
docker run -p 8090:8090 ghcr.io/alextreichler/k8svisualizer --mode=full
```

Open `http://localhost:8090`. For a public deployment with read-only access:

```bash
READ_ONLY=true docker run -p 8090:8090 ghcr.io/alextreichler/k8svisualizer --mode=full
```

Behind nginx, add:
```
nginx.ingress.kubernetes.io/proxy-buffering: "off"
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
```
