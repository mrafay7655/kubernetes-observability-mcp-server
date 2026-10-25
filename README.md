# kubernetes-observability-mcp-server

![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript)
![MCP](https://img.shields.io/badge/MCP-1.0-purple?logo=anthropic)
![Dynatrace](https://img.shields.io/badge/Dynatrace-OTLP-green?logo=dynatrace)
![License](https://img.shields.io/badge/License-MIT-yellow)
![Node](https://img.shields.io/badge/Node.js-20%2B-brightgreen?logo=node.js)

A production-grade **Model Context Protocol (MCP) server** that gives AI assistants (Claude, Cursor, Windsurf, etc.) direct, structured access to your Kubernetes cluster for operations, network debugging, and Dynatrace observability correlation — with full OpenTelemetry self-monitoring that ships traces, metrics, and logs to Dynatrace automatically.

## What This Does

Instead of copy-pasting kubectl output into a chat window, this MCP server lets your AI assistant:
- List pods, check logs, describe deployments — directly, without leaving the conversation
- Debug network policies, DNS, ingress routing, and service mesh configuration
- Pull live Dynatrace problems and correlate them with Kubernetes events
- View its own performance in Dynatrace via OTel self-monitoring

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                   AI Assistant (Claude Desktop / Cursor)            │
│                        MCP Client                                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │ stdio (JSON-RPC)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│              kubernetes-observability-mcp-server                    │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  K8s Management  │  │ Network Debugging│  │   Dynatrace      │  │
│  │                  │  │                  │  │   Correlation    │  │
│  │ • list_pods      │  │ • analyze_       │  │                  │  │
│  │ • get_pod_logs   │  │   network_policy │  │ • get_dynatrace_ │  │
│  │ • describe_pod   │  │ • check_service_ │  │   problems       │  │
│  │ • list_          │  │   endpoints      │  │ • correlate_     │  │
│  │   deployments    │  │ • find_orphaned_ │  │   alerts_with_   │  │
│  │ • describe_      │  │   services       │  │   k8s            │  │
│  │   deployment     │  │ • debug_dns_     │  │ • get_entity_    │  │
│  │ • get_namespace_ │  │   config         │  │   health         │  │
│  │   events         │  │ • coredns_health_│  │                  │  │
│  │ • get_namespace_ │  │   check          │  │                  │  │
│  │   health         │  │ • inspect_       │  │                  │  │
│  │                  │  │   ingress_routing│  │                  │  │
│  │                  │  │ • trace_service_ │  │                  │  │
│  │                  │  │   to_pods        │  │                  │  │
│  │                  │  │ • node_network_  │  │                  │  │
│  │                  │  │   status         │  │                  │  │
│  │                  │  │ • check_service_ │  │                  │  │
│  │                  │  │   mesh_config    │  │                  │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                      │            │
│           ▼                     ▼                      ▼            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │           withTelemetry() middleware (OTel wrapper)          │   │
│  │   span per call • invocation counter • latency histogram     │   │
│  └───────────────────────────┬─────────────────────────────────┘   │
└──────────────────────────────│──────────────────────────────────────┘
                               │ OTLP/HTTP
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Dynatrace                                   │
│    Distributed Traces  •  Metrics Dashboard  •  Structured Logs    │
└─────────────────────────────────────────────────────────────────────┘
          ▲
          │ API v2 (problems, entities, metrics)
          │
┌─────────┴───────────────────────────────────────────────────────────┐
│              Kubernetes Cluster (@kubernetes/client-node)           │
│         ~/.kube/config or in-cluster ServiceAccount token           │
└─────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- **Node.js 20+** — `node --version` must show v20 or higher
- **npm 9+** — comes with Node 20
- **kubectl configured** — run `kubectl cluster-info` and confirm it shows your cluster; the server reads `~/.kube/config` by default
- **Dynatrace account** — free trial at [dynatrace.com](https://www.dynatrace.com/trial/) works; Dynatrace tools are optional if you only want K8s features

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/mrafay7655/kubernetes-observability-mcp-server.git
cd kubernetes-observability-mcp-server

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Open .env in your editor and fill in the values (see "Environment Variables" below)

# 4. Build
npm run build

# 5. Verify the server starts (Ctrl+C to exit)
npm start
# Expected output: [mcp] kubernetes-observability-mcp-server running on stdio
```

## Claude Desktop Setup

### Step 1 — Find your config file

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

### Step 2 — Add the server entry

Open the config file and add (or merge) the `mcpServers` block:

```json
{
  "mcpServers": {
    "kubernetes-observability": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/kubernetes-observability-mcp-server/dist/index.js"],
      "env": {
        "DT_ENV_URL": "https://YOUR_ENV_ID.live.dynatrace.com",
        "DT_API_TOKEN": "dt0c01.YOUR_TOKEN_HERE",
        "OTEL_EXPORTER_OTLP_ENDPOINT": "https://YOUR_ENV_ID.live.dynatrace.com/api/v2/otlp",
        "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Api-Token dt0c01.YOUR_TOKEN_HERE",
        "OTEL_SERVICE_NAME": "kubernetes-observability-mcp-server"
      }
    }
  }
}
```

Replace `/ABSOLUTE/PATH/TO/` with the full path to the cloned repository.

**Windows path example:**
```json
"args": ["C:\\Users\\YourName\\Projects\\kubernetes-observability-mcp-server\\dist\\index.js"]
```

**macOS/Linux path example:**
```json
"args": ["/Users/yourname/projects/kubernetes-observability-mcp-server/dist/index.js"]
```

### Step 3 — Restart Claude Desktop

Fully quit Claude Desktop (system tray → Quit) and reopen it. In the new conversation, look for the hammer icon (🔨) in the chat input bar — this confirms MCP tools are loaded.

### Step 4 — Test

Type: `List pods in the default namespace`

The assistant will call `list_pods` and return results from your cluster.

## Claude Code (CLI) Setup

```bash
# Add to your user-level MCP config (persists across projects)
claude mcp add -s user kubernetes-observability \
  node /absolute/path/to/dist/index.js \
  -e DT_ENV_URL=https://YOUR_ENV_ID.live.dynatrace.com \
  -e DT_API_TOKEN=dt0c01.YOUR_TOKEN

# Verify it was added
claude mcp list

# Test a tool call
claude "list all pods in the kube-system namespace"
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DT_ENV_URL` | Yes (for DT tools) | Your Dynatrace environment base URL, e.g. `https://abc12345.live.dynatrace.com` |
| `DT_API_TOKEN` | Yes (for DT tools) | API token — must start with `dt0c01.` (not `dt0s` personal token) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP endpoint for self-monitoring telemetry |
| `OTEL_EXPORTER_OTLP_HEADERS` | No | Auth header: `Authorization=Api-Token dt0c01.YOUR_TOKEN` |
| `OTEL_SERVICE_NAME` | No | Service name in Dynatrace (default: `kubernetes-observability-mcp-server`) |
| `OTEL_SERVICE_VERSION` | No | Service version tag (default: `1.0.0`) |
| `LOG_LEVEL` | No | `debug` / `info` / `warn` / `error` (default: `info`) |
| `KUBECONFIG` | No | Override kubeconfig path (default: `~/.kube/config`) |

**K8s-only mode (no Dynatrace):** Leave `DT_ENV_URL` and `DT_API_TOKEN` unset. All 17 Kubernetes and network tools work without them; only the 3 Dynatrace tools will return an error.

## Dynatrace Setup

### Creating an API Token

1. Open your Dynatrace environment: `https://YOUR_ENV_ID.live.dynatrace.com`
2. Go to **Settings → Integration → Dynatrace API → API tokens**
3. Click **Generate new token**
4. Name it `kubernetes-observability-mcp-server`
5. Enable the following scopes:

| Scope | Purpose |
|-------|---------|
| `metrics.ingest` | Send custom metrics via OTLP |
| `logs.ingest` | Send structured logs via OTLP |
| `openTelemetryTrace.ingest` | Send distributed traces via OTLP |
| `problems.read` | Read Davis AI problems |
| `entities.read` | Read entity health and metadata |
| `metrics.read` | Query service metrics (optional — not available on all plans) |

> **Note:** If your Dynatrace plan does not include `metrics.read`, skip it. The `get_entity_health` tool gracefully falls back and returns entity metadata without metrics.

6. Copy the generated token — it will not be shown again.

### Verify Your Token Type

Your token must start with `dt0c01.` — this is an **API token**.  
Tokens starting with `dt0s` are personal access tokens and will return 401.

### OTLP Endpoint Format

```
https://YOUR_ENV_ID.live.dynatrace.com/api/v2/otlp
```

The server appends `/v1/traces`, `/v1/metrics`, and `/v1/logs` automatically.

## Running Inside a Kubernetes Cluster

To run the server as a Pod inside the cluster (instead of from your laptop), create a ServiceAccount with appropriate RBAC:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: mcp-server
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: mcp-server-reader
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "services", "endpoints", "events", "namespaces", "nodes", "configmaps"]
    verbs: ["get", "list"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies", "ingresses", "ingressclasses"]
    verbs: ["get", "list"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "list"]
  - apiGroups: ["networking.istio.io", "security.istio.io"]
    resources: ["virtualservices", "destinationrules", "peerauthentications"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: mcp-server-reader
subjects:
  - kind: ServiceAccount
    name: mcp-server
    namespace: default
roleRef:
  kind: ClusterRole
  name: mcp-server-reader
  apiGroup: rbac.authorization.k8s.io
```

## Tools Reference

| Tool | Description | Category | Required Permissions |
|------|-------------|----------|---------------------|
| `list_pods` | List pods in a namespace with status, readiness, and restart counts | Kubernetes | `pods:list` |
| `get_pod_logs` | Fetch logs from a pod (max 1,000 lines) | Kubernetes | `pods/log:get` |
| `describe_pod` | Full pod description: DNS policy, containers, IPs, conditions | Kubernetes | `pods:get` |
| `list_deployments` | List deployments with replica counts and conditions | Kubernetes | `deployments:list` |
| `describe_deployment` | Describe a deployment with full container specs | Kubernetes | `deployments:get` |
| `get_namespace_events` | K8s events filtered by type or reason (max 200) | Kubernetes | `events:list` |
| `get_namespace_health` | Health score rollup — pod counts, warnings, overall status | Kubernetes | `pods:list`, `events:list` |
| `analyze_network_policy` | Which NetworkPolicies apply to a pod and their risk | Network | `pods:get`, `networkpolicies:list` |
| `check_service_endpoints` | Detect services with no ready backends | Network | `services:list`, `endpointslices:list` |
| `find_orphaned_services` | Services whose selectors match no running pods | Network | `services:list`, `endpointslices:list` |
| `debug_dns_config` | CoreDNS health, Corefile config, pod DNS policy | Network | `pods:get`, `configmaps:get`, `deployments:get` |
| `coredns_health_check` | CoreDNS pod status and restart rate | Network | `pods:list`, `deployments:get` |
| `inspect_ingress_routing` | IngressClass validation and backend endpoints | Network | `ingresses:list`, `ingressclasses:list`, `endpointslices:list` |
| `trace_service_to_pods` | Full path: Service → EndpointSlices → Pods → NetworkPolicies | Network | `services:get`, `endpointslices:list`, `pods:list`, `networkpolicies:list` |
| `node_network_status` | Node NetworkUnavailable conditions, PodCIDR allocations | Network | `nodes:list` |
| `check_service_mesh_config` | Istio/Linkerd detection, VirtualServices, mTLS mode | Network | `deployments:get`, CRDs read |
| `get_dynatrace_problems` | Dynatrace Davis AI problems, filtered by namespace | Dynatrace | `DT_API_TOKEN` with `problems.read` |
| `correlate_alerts_with_k8s` | Correlate Dynatrace alerts with K8s events | Dynatrace | `DT_API_TOKEN` with `problems.read` |
| `get_entity_health` | Dynatrace entity metrics — response time, error rate | Dynatrace | `DT_API_TOKEN` with `entities.read` |

## Troubleshooting

### Server not appearing in Claude Desktop
- Confirm the path in `args` is absolute and the file exists: `node /path/to/dist/index.js`
- Check for JSON syntax errors in `claude_desktop_config.json`
- Fully quit and restart Claude Desktop (menu bar → Quit, not just close the window)

### `CONNECT_TIMEOUT` in Claude Code
The server may time out if the OTLP endpoint is unreachable on startup. Ensure `OTEL_EXPORTER_OTLP_ENDPOINT` points to a valid Dynatrace URL, or leave it unset to disable telemetry.

### `401 Unauthorized` from Dynatrace tools
- Token must start with `dt0c01.` — personal access tokens (`dt0s`) are rejected
- Verify `problems.read` and `entities.read` scopes are enabled on the token

### `kubectl` / kubeconfig errors
- Run `kubectl get pods` from the same terminal to confirm kubeconfig is valid
- Set `KUBECONFIG=/path/to/config` if your config is not at the default location

### Tool returns empty results
- Kubernetes namespaces default to `"default"` — specify `namespace` if your resources are elsewhere
- Check `kubectl get pods -n YOUR_NAMESPACE` directly to confirm resources exist

## Security

- **No credentials in source code** — all secrets are loaded from environment variables
- **No exec or shell commands** — uses the `@kubernetes/client-node` library API directly; no `kubectl` subprocess
- **Read-only by default** — all tools only read cluster state; no writes, no deletes
- **Input validation** — namespace names, event types, entity names, and entity types are validated before being used in API calls
- **Log limits** — `get_pod_logs` is capped at 1,000 lines regardless of the requested value
- **Never commit `.env`** — `.gitignore` excludes it; rotate any token that was committed

## Contributing

Contributions are welcome! Areas for improvement:

- Additional Kubernetes resource support (StatefulSets, DaemonSets, Jobs)
- Dynatrace SLO querying tool
- Prometheus metrics integration
- Helm release inspection tool
- Kubernetes events streaming

Please open an issue first to discuss major changes.

## License

MIT License — see [LICENSE](LICENSE) for details.
