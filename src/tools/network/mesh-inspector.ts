import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

export async function checkServiceMeshConfig(args: { namespace?: string }) {
  const ns = args.namespace || 'default';

  const [istiodRes, linkerdRes] = await Promise.all([
    appsV1Api.readNamespacedDeployment('istiod', 'istio-system').catch(() => null),
    appsV1Api.readNamespacedDeployment('linkerd-controller', 'linkerd').catch(() => null),
  ]);

  const meshType = istiodRes ? 'istio' : linkerdRes ? 'linkerd' : 'none';

  if (meshType === 'none') {
    return {
      meshDetected: false,
      message: 'No service mesh (Istio or Linkerd) detected in the cluster',
    };
  }

  const result: Record<string, unknown> = { meshDetected: true, meshType };

  if (meshType === 'istio') {
    const [vsRes, drRes, paRes, nsRes] = await Promise.all([
      customObjectsApi
        .listNamespacedCustomObject('networking.istio.io', 'v1beta1', ns, 'virtualservices')
        .catch(() => null),
      customObjectsApi
        .listNamespacedCustomObject('networking.istio.io', 'v1beta1', ns, 'destinationrules')
        .catch(() => null),
      customObjectsApi
        .listNamespacedCustomObject('security.istio.io', 'v1beta1', ns, 'peerauthentications')
        .catch(() => null),
      coreV1Api.readNamespace(ns).catch(() => null),
    ]);

    const sidecarInjection = nsRes?.body.metadata?.labels?.['istio-injection'];

    result['istioControlPlane'] = {
      istiodReady: (istiodRes?.body.status?.readyReplicas ?? 0) > 0,
      readyReplicas: istiodRes?.body.status?.readyReplicas,
    };
    result['namespaceInjection'] = sidecarInjection === 'enabled' ? 'enabled' : 'disabled (add label istio-injection=enabled to namespace)';
    result['virtualServices'] = ((vsRes?.body as Record<string, unknown>)?.['items'] as unknown[])?.length ?? 0;
    result['destinationRules'] = ((drRes?.body as Record<string, unknown>)?.['items'] as unknown[])?.length ?? 0;

    const peerAuths = ((paRes?.body as Record<string, unknown>)?.['items'] as Array<Record<string, unknown>>) || [];
    result['mTLSMode'] =
      peerAuths.length > 0
        ? peerAuths.map(p => ({
            name: (p['metadata'] as Record<string, unknown>)?.['name'],
            mode: ((p['spec'] as Record<string, unknown>)?.['mtls'] as Record<string, unknown>)?.['mode'] || 'PERMISSIVE',
          }))
        : 'No PeerAuthentication found — default PERMISSIVE mTLS mode';
  }

  if (meshType === 'linkerd') {
    result['linkerdControlPlane'] = {
      controllerReady: (linkerdRes?.body.status?.readyReplicas ?? 0) > 0,
      readyReplicas: linkerdRes?.body.status?.readyReplicas,
    };
    result['note'] = 'Linkerd detected. Use linkerd CLI for detailed mesh introspection (tap, top, stat).';
  }

  return result;
}
