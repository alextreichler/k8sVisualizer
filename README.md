# k8sVisualizer

An interactive browser-based tool for visualizing and simulating Kubernetes clusters. Built to make it easier to understand how Kubernetes resources relate to each other — pods, services, deployments, persistent volumes, operators, and more — without needing a real cluster running.

The graph updates in real time as you interact with it. You can deploy scenarios (Redpanda, cert-manager, ArgoCD, etc.), simulate failures, scale workloads, and watch the state changes propagate through the cluster view.

## Running locally

```bash
go run . --mode=full
```

Then open `http://localhost:8090`. The `--mode=full` flag starts with a pre-built sample cluster. Omit it to start empty.

## Building

```bash
task build
./k8svis --mode=full
```

Requires [Task](https://taskfile.dev) (`brew install go-task`).

## Updating CRD schemas

The panel shows live field descriptions for Redpanda CRDs (Redpanda, Topic, User, Schema). These are fetched from the operator's GitHub releases and embedded in the binary at build time. To pull the latest:

```bash
task update-schemas
```

Or for a specific version:

```bash
task update-schemas VERSIONS=v24.3.1
```

Set `GITHUB_TOKEN` in your environment to avoid the unauthenticated rate limit.

## Docker

```bash
docker build -t k8svisualizer .
docker run -p 8090:8090 k8svisualizer --mode=full
```

Images are published to `ghcr.io/alextreichler/k8svisualizer` on every push to main.

## Configuration

Configured via environment variables at runtime:

| Variable | Default | Description |
|---|---|---|
| `READ_ONLY` | `false` | Disables all mutating endpoints. Useful for public deployments where you want visitors to explore but not modify state. |
| `ALLOWED_ORIGINS` | _(all)_ | Comma-separated list of allowed CORS origins. Leave empty for local development. |
| `MAX_SSE_CLIENTS` | `100` | Maximum concurrent browser connections. |
| `MAX_CONCURRENT_SCENARIOS` | `3` | Maximum number of scenarios that can run at the same time. |

## Deploying

The app is stateless — no database, no disk writes. Static files are embedded in the binary so `readOnlyRootFilesystem: true` works out of the box.

If you're running behind nginx ingress, the SSE connection requires a couple of annotations or graph updates won't reach the browser:

```yaml
nginx.ingress.kubernetes.io/proxy-buffering: "off"
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
```
