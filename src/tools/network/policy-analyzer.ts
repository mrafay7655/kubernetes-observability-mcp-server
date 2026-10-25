import * as k8s from '@kubernetes/client-node';
import { validateK8sName } from '../kubernetes/validate';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const networkingV1Api = kc.makeApiClient(k8s.NetworkingV1Api);

function labelsMatch(
  selector: Record<string, string>,
  labels: Record<string, string>
): boolean {
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

export async function analyzeNetworkPolicy(args: { pod_name: string; namespace?: string }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  validateK8sName(args.pod_name, 'pod_name');

  const [podRes, policiesRes] = await Promise.all([
    coreV1Api.readNamespacedPod(args.pod_name, ns),
    networkingV1Api.listNamespacedNetworkPolicy(ns),
  ]);

  const podLabels = podRes.body.metadata?.labels || {};
  const policies = policiesRes.body.items;

  const applicablePolicies = policies.filter(p => {
    const sel = p.spec?.podSelector?.matchLabels || {};
    return Object.keys(sel).length === 0 || labelsMatch(sel, podLabels);
  });

  const hasIngressPolicy = applicablePolicies.some(p => p.spec?.ingress !== undefined);
  const hasEgressPolicy = applicablePolicies.some(p => p.spec?.egress !== undefined);
  const defaultDenyIngress = applicablePolicies.some(
    p =>
      Object.keys(p.spec?.podSelector?.matchLabels || {}).length === 0 &&
      Array.isArray(p.spec?.ingress) &&
      p.spec!.ingress!.length === 0
  );

  return {
    pod: args.pod_name,
    namespace: ns,
    podLabels,
    totalPoliciesInNamespace: policies.length,
    applicablePolicies: applicablePolicies.map(p => ({
      name: p.metadata?.name,
      policyTypes: p.spec?.policyTypes,
      ingressRules: p.spec?.ingress?.length ?? 0,
      egressRules: p.spec?.egress?.length ?? 0,
      podSelector: p.spec?.podSelector,
    })),
    analysis: {
      ingressControlled: hasIngressPolicy,
      egressControlled: hasEgressPolicy,
      defaultDenyIngress,
      risk:
        applicablePolicies.length === 0
          ? 'No NetworkPolicies apply — all traffic allowed (no isolation)'
          : defaultDenyIngress
          ? 'Default deny ingress active — traffic blocked unless explicitly allowed'
          : 'Policies apply — review ingress/egress rules carefully',
    },
  };
}
