import * as k8s from '@kubernetes/client-node';
import { validateK8sName } from '../kubernetes/validate';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const discoveryV1Api = kc.makeApiClient(k8s.DiscoveryV1Api);
const networkingV1Api = kc.makeApiClient(k8s.NetworkingV1Api);

function labelsMatch(
  selector: Record<string, string>,
  labels: Record<string, string>
): boolean {
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

export async function traceServiceToPods(args: { service_name: string; namespace?: string }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  validateK8sName(args.service_name, 'service_name');

  const [svcRes, slicesRes, podsRes, policiesRes] = await Promise.all([
    coreV1Api.readNamespacedService(args.service_name, ns),
    discoveryV1Api.listNamespacedEndpointSlice(ns),
    coreV1Api.listNamespacedPod(ns),
    networkingV1Api.listNamespacedNetworkPolicy(ns),
  ]);

  const svc = svcRes.body;
  const selector = svc.spec?.selector || {};

  const matchingPods = podsRes.body.items.filter(pod => {
    const podLabels = pod.metadata?.labels || {};
    return labelsMatch(selector, podLabels);
  });

  const slices = slicesRes.body.items.filter(
    s => s.metadata?.labels?.['kubernetes.io/service-name'] === args.service_name
  );

  const podAnalysis = matchingPods.map(pod => {
    const podLabels = pod.metadata?.labels || {};
    const applicablePolicies = policiesRes.body.items.filter(p => {
      const sel = p.spec?.podSelector?.matchLabels || {};
      return Object.keys(sel).length === 0 || labelsMatch(sel, podLabels);
    });

    return {
      pod: pod.metadata?.name,
      phase: pod.status?.phase,
      ready: pod.status?.containerStatuses?.every(c => c.ready) ?? false,
      networkPoliciesApplied: applicablePolicies.map(p => p.metadata?.name),
      ingressBlocked: applicablePolicies.some(
        p => Array.isArray(p.spec?.ingress) && p.spec!.ingress!.length === 0
      ),
    };
  });

  const issues: string[] = [];
  if (matchingPods.length === 0) {
    issues.push(`No pods match selector ${JSON.stringify(selector)}`);
  }
  if (podAnalysis.some(p => p.ingressBlocked)) {
    issues.push('Some pods have ingress blocked by NetworkPolicy default-deny');
  }
  if (matchingPods.some(p => !(podAnalysis.find(a => a.pod === p.metadata?.name)?.ready))) {
    issues.push('Some matching pods are not in Ready state');
  }

  return {
    service: args.service_name,
    namespace: ns,
    serviceType: svc.spec?.type,
    clusterIP: svc.spec?.clusterIP,
    selector,
    ports: svc.spec?.ports,
    endpointSlices: slices.length,
    matchingPods: matchingPods.length,
    podDetails: podAnalysis,
    issues,
  };
}
