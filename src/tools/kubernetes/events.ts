import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

const ALLOWED_EVENT_TYPES = new Set(['Normal', 'Warning']);
const REASON_RE = /^[a-zA-Z]{1,64}$/;
const K8S_NAME_RE = /^[a-z0-9][a-z0-9\-]{0,62}$/;

export async function getNamespaceEvents(args: {
  namespace?: string;
  event_type?: string;
  reason?: string;
  limit?: number;
}) {
  const ns = args.namespace || 'default';
  if (ns !== 'default' && !K8S_NAME_RE.test(ns)) {
    throw new Error('namespace must be lowercase alphanumeric with dashes, max 63 chars');
  }
  if (args.event_type && !ALLOWED_EVENT_TYPES.has(args.event_type)) {
    throw new Error('event_type must be "Normal" or "Warning"');
  }
  if (args.reason && !REASON_RE.test(args.reason)) {
    throw new Error('reason must be alphanumeric letters only, max 64 chars');
  }
  const limit = Math.min(args.limit ?? 50, 200);
  const fieldSelector = [
    args.event_type ? `type=${args.event_type}` : '',
    args.reason ? `reason=${args.reason}` : '',
  ].filter(Boolean).join(',') || undefined;

  const { body } = await coreV1Api.listNamespacedEvent(
    ns, undefined, undefined, undefined, fieldSelector, undefined, limit
  );

  const sorted = body.items.sort(
    (a, b) =>
      (new Date(b.lastTimestamp || 0).getTime()) -
      (new Date(a.lastTimestamp || 0).getTime())
  );

  return {
    namespace: ns,
    total: sorted.length,
    events: sorted.map(e => ({
      type: e.type,
      reason: e.reason,
      message: e.message,
      object: `${e.involvedObject.kind}/${e.involvedObject.name}`,
      count: e.count,
      firstTime: e.firstTimestamp,
      lastTime: e.lastTimestamp,
    })),
  };
}

export async function getNamespaceHealth(args: { namespace?: string }) {
  const ns = args.namespace || 'default';
  const [podsRes, eventsRes] = await Promise.all([
    coreV1Api.listNamespacedPod(ns),
    coreV1Api.listNamespacedEvent(
      ns, undefined, undefined, undefined, 'type=Warning', undefined, 20
    ),
  ]);

  const pods = podsRes.body.items;
  const totalPods = pods.length;
  const runningPods = pods.filter(p => p.status?.phase === 'Running').length;
  const failedPods = pods.filter(p => p.status?.phase === 'Failed').length;
  const pendingPods = pods.filter(p => p.status?.phase === 'Pending').length;
  const highRestarts = pods.filter(p =>
    (p.status?.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) ?? 0) > 5
  ).length;

  const healthScore = totalPods === 0 ? 100 : Math.round((runningPods / totalPods) * 100);

  return {
    namespace: ns,
    healthScore: `${healthScore}%`,
    summary: { totalPods, runningPods, failedPods, pendingPods, highRestartPods: highRestarts },
    recentWarnings: eventsRes.body.items.length,
    status: healthScore >= 80 ? 'healthy' : healthScore >= 50 ? 'degraded' : 'critical',
  };
}
