import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { initTelemetry, shutdownTelemetry } from './telemetry/tracing';
import { withTelemetry } from './middleware/with-telemetry';

// Kubernetes tools
import { listPods, getPodLogs, describePod } from './tools/kubernetes/pods';
import { listDeployments, describeDeployment } from './tools/kubernetes/deployments';
import { getNamespaceEvents, getNamespaceHealth } from './tools/kubernetes/events';

// Network debugging tools
import { analyzeNetworkPolicy } from './tools/network/policy-analyzer';
import { checkServiceEndpoints, findOrphanedServices } from './tools/network/service-debugger';
import { debugDnsConfig, coreDnsHealthCheck } from './tools/network/dns-debugger';
import { inspectIngressRouting } from './tools/network/ingress-inspector';
import { traceServiceToPods } from './tools/network/service-tracer';
import { nodeNetworkStatus } from './tools/network/node-network';
import { checkServiceMeshConfig } from './tools/network/mesh-inspector';

// Dynatrace tools
import { getDynatraceProblems, correlateAlertsWithEvents } from './tools/dynatrace/problems';
import { getEntityHealth } from './tools/dynatrace/entity-health';

function sanitizeError(message: string): string {
  if (/404|not found/i.test(message)) return 'Resource not found';
  if (/403|forbidden|unauthorized/i.test(message)) return 'Insufficient permissions — check RBAC or API token scopes';
  if (/401/i.test(message)) return 'Authentication failed — check DT_API_TOKEN';
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET/i.test(message)) return 'Connection timed out — check cluster/Dynatrace connectivity';
  if (/5[0-9]{2}/.test(message)) return 'API server returned an error — check server logs';
  // Strip any embedded URLs (could expose cluster API server address)
  return message.replace(/https?:\/\/[^\s,)]+/g, '[url-redacted]');
}

// Bootstrap OTel — failures must not crash the MCP server
try {
  initTelemetry();
} catch (err) {
  console.error('[mcp] OTel init failed (continuing without telemetry):', err);
}

const server = new Server(
  { name: 'kubernetes-observability-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

const tools = [
  // ── Kubernetes ──────────────────────────────────────────────────────────────
  {
    name: 'list_pods',
    description: 'List pods in a namespace with status, readiness, and restart counts',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Kubernetes namespace (default: "default")' },
        label_selector: { type: 'string', description: 'Label selector filter e.g. "app=nginx"' },
      },
    },
    handler: withTelemetry('list_pods', listPods),
  },
  {
    name: 'get_pod_logs',
    description: 'Fetch logs from a pod container with optional tail line limit',
    inputSchema: {
      type: 'object' as const,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Pod name' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        container: { type: 'string', description: 'Container name (optional for multi-container pods)' },
        tail_lines: { type: 'number', description: 'Lines from end to return (default: 100)' },
      },
    },
    handler: withTelemetry('get_pod_logs', getPodLogs),
  },
  {
    name: 'describe_pod',
    description: 'Full pod description including DNS policy, network config, containers, and conditions',
    inputSchema: {
      type: 'object' as const,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Pod name' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('describe_pod', describePod),
  },
  {
    name: 'list_deployments',
    description: 'List deployments with replica counts and conditions',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('list_deployments', listDeployments),
  },
  {
    name: 'describe_deployment',
    description: 'Describe a deployment with full container specs and rollout conditions',
    inputSchema: {
      type: 'object' as const,
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Deployment name' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('describe_deployment', describeDeployment),
  },
  {
    name: 'get_namespace_events',
    description: 'Get Kubernetes events filtered by type or reason — great for spotting OOMKills, BackOffs',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        event_type: { type: 'string', enum: ['Normal', 'Warning'], description: 'Filter by event type' },
        reason: { type: 'string', description: 'Filter by reason e.g. "OOMKilling", "BackOff", "Failed"' },
        limit: { type: 'number', description: 'Max events (default: 50)' },
      },
    },
    handler: withTelemetry('get_namespace_events', getNamespaceEvents),
  },
  {
    name: 'get_namespace_health',
    description: 'Health score rollup for a namespace — pod counts, warnings, overall status',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('get_namespace_health', getNamespaceHealth),
  },

  // ── Network Debugging ───────────────────────────────────────────────────────
  {
    name: 'analyze_network_policy',
    description: 'Analyze which NetworkPolicies apply to a pod and detect traffic restrictions',
    inputSchema: {
      type: 'object' as const,
      required: ['pod_name'],
      properties: {
        pod_name: { type: 'string', description: 'Pod name to analyze' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('analyze_network_policy', analyzeNetworkPolicy),
  },
  {
    name: 'check_service_endpoints',
    description: 'Check if service endpoints are ready — detects services with no ready backends',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        service_name: { type: 'string', description: 'Specific service (optional — checks all if omitted)' },
      },
    },
    handler: withTelemetry('check_service_endpoints', checkServiceEndpoints),
  },
  {
    name: 'find_orphaned_services',
    description: 'Find services whose label selectors match no running pods',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('find_orphaned_services', findOrphanedServices),
  },
  {
    name: 'debug_dns_config',
    description: 'Debug DNS — checks CoreDNS health, Corefile config, and pod DNS policy',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        pod_name: { type: 'string', description: 'Pod to check DNS policy (optional)' },
      },
    },
    handler: withTelemetry('debug_dns_config', debugDnsConfig),
  },
  {
    name: 'coredns_health_check',
    description: 'Quick CoreDNS health check — pod status, replica count, restart rate',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: withTelemetry('coredns_health_check', coreDnsHealthCheck as (args: Record<string, unknown>) => Promise<unknown>),
  },
  {
    name: 'inspect_ingress_routing',
    description: 'Validate ingress routing — IngressClass existence, backend service endpoints',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        ingress_name: { type: 'string', description: 'Specific ingress (optional — checks all if omitted)' },
      },
    },
    handler: withTelemetry('inspect_ingress_routing', inspectIngressRouting),
  },
  {
    name: 'trace_service_to_pods',
    description: 'Trace full path: Service → EndpointSlices → Pods → NetworkPolicies',
    inputSchema: {
      type: 'object' as const,
      required: ['service_name'],
      properties: {
        service_name: { type: 'string', description: 'Service name to trace' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('trace_service_to_pods', traceServiceToPods),
  },
  {
    name: 'node_network_status',
    description: 'Check network status of all nodes — NetworkUnavailable conditions, PodCIDR allocations',
    inputSchema: { type: 'object' as const, properties: {} },
    handler: withTelemetry('node_network_status', nodeNetworkStatus as (args: Record<string, unknown>) => Promise<unknown>),
  },
  {
    name: 'check_service_mesh_config',
    description: 'Inspect Istio/Linkerd mesh config — VirtualServices, mTLS mode, sidecar injection status',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
    },
    handler: withTelemetry('check_service_mesh_config', checkServiceMeshConfig),
  },

  // ── Dynatrace Correlation ────────────────────────────────────────────────────
  {
    name: 'get_dynatrace_problems',
    description: 'Fetch Dynatrace Davis AI problems, optionally filtered by Kubernetes namespace',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'K8s namespace to filter problems (optional)' },
        status: {
          type: 'string',
          enum: ['OPEN', 'RESOLVED', 'ALL'],
          description: 'Problem status (default: OPEN)',
        },
        time_from: { type: 'string', description: 'Time range start (default: now-2h)' },
      },
    },
    handler: withTelemetry('get_dynatrace_problems', getDynatraceProblems),
  },
  {
    name: 'correlate_alerts_with_k8s',
    description: 'Correlate Dynatrace alerts with Kubernetes events in a time window',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Kubernetes namespace (optional)' },
        time_from: { type: 'string', description: 'Start time (default: now-1h)' },
        time_to: { type: 'string', description: 'End time (default: now)' },
      },
    },
    handler: withTelemetry('correlate_alerts_with_k8s', correlateAlertsWithEvents),
  },
  {
    name: 'get_entity_health',
    description: 'Get Dynatrace health metrics for a service/entity — response time, error rate',
    inputSchema: {
      type: 'object' as const,
      required: ['entity_name'],
      properties: {
        entity_name: { type: 'string', description: 'Entity display name in Dynatrace' },
        entity_type: {
          type: 'string',
          description: 'Entity type (default: SERVICE). Options: SERVICE, PROCESS_GROUP, CLOUD_APPLICATION',
        },
      },
    },
    handler: withTelemetry('get_entity_health', getEntityHealth),
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  }

  try {
    const result = await (tool.handler as (args: Record<string, unknown>) => Promise<unknown>)(
      (request.params.arguments || {}) as Record<string, unknown>
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Sanitize — map known API error patterns to avoid leaking cluster internals
    const safeMessage = sanitizeError(message);
    return {
      content: [{ type: 'text', text: `Error: ${safeMessage}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] kubernetes-observability-mcp-server running on stdio');

  process.on('SIGINT', async () => {
    await shutdownTelemetry();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await shutdownTelemetry();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[mcp] Fatal error:', err);
  process.exit(1);
});
