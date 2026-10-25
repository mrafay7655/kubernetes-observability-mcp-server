import * as k8s from '@kubernetes/client-node';
import { validateK8sName } from './validate';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

export async function listPods(args: { namespace?: string; label_selector?: string }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  const { body } = await coreV1Api.listNamespacedPod(
    ns, undefined, undefined, undefined, undefined, args.label_selector
  );
  return {
    namespace: ns,
    total: body.items.length,
    pods: body.items.map(pod => ({
      name: pod.metadata?.name,
      namespace: pod.metadata?.namespace,
      status: pod.status?.phase,
      ready: pod.status?.containerStatuses?.every(c => c.ready) ?? false,
      restarts: pod.status?.containerStatuses?.reduce((sum, c) => sum + c.restartCount, 0) ?? 0,
      node: pod.spec?.nodeName,
      age: pod.metadata?.creationTimestamp,
      labels: pod.metadata?.labels,
    })),
  };
}

export async function getPodLogs(args: { name: string; namespace?: string; container?: string; tail_lines?: number }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  validateK8sName(args.name, 'name');
  const tailLines = Math.min(args.tail_lines ?? 100, 1000);
  const { body } = await coreV1Api.readNamespacedPodLog(
    args.name, ns, args.container,
    undefined, undefined, undefined,
    undefined, undefined, undefined, tailLines
  );
  return { pod: args.name, namespace: ns, logs: body };
}

export async function describePod(args: { name: string; namespace?: string }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  validateK8sName(args.name, 'name');
  const { body } = await coreV1Api.readNamespacedPod(args.name, ns);
  return {
    name: body.metadata?.name,
    namespace: body.metadata?.namespace,
    phase: body.status?.phase,
    conditions: body.status?.conditions?.map(c => ({
      type: c.type, status: c.status, reason: c.reason, message: c.message
    })),
    containers: body.spec?.containers?.map(c => ({
      name: c.name,
      image: c.image,
      ports: c.ports?.map(p => ({ containerPort: p.containerPort, protocol: p.protocol })),
      resources: c.resources,
    })),
    containerStatuses: body.status?.containerStatuses?.map(cs => ({
      name: cs.name, ready: cs.ready, restartCount: cs.restartCount, state: cs.state,
    })),
    dnsPolicy: body.spec?.dnsPolicy,
    dnsConfig: body.spec?.dnsConfig,
  };
}
