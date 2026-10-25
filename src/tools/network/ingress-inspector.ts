import * as k8s from '@kubernetes/client-node';
import { validateK8sName } from '../kubernetes/validate';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const networkingV1Api = kc.makeApiClient(k8s.NetworkingV1Api);
const discoveryV1Api = kc.makeApiClient(k8s.DiscoveryV1Api);

export async function inspectIngressRouting(args: {
  namespace?: string;
  ingress_name?: string;
}) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  if (args.ingress_name) validateK8sName(args.ingress_name, 'ingress_name');

  const ingressItems = args.ingress_name
    ? [(await networkingV1Api.readNamespacedIngress(args.ingress_name, ns)).body]
    : (await networkingV1Api.listNamespacedIngress(ns)).body.items;

  const [classesRes, slicesRes] = await Promise.all([
    networkingV1Api.listIngressClass().catch(() => ({ body: { items: [] as k8s.V1IngressClass[] } })),
    discoveryV1Api.listNamespacedEndpointSlice(ns),
  ]);

  const availableClasses = classesRes.body.items.map(c => c.metadata?.name);

  const results = ingressItems.map(ing => {
    const ingressClass = ing.spec?.ingressClassName;
    const classExists = !ingressClass || availableClasses.includes(ingressClass);

    const ruleAnalysis = (ing.spec?.rules || []).map(rule => {
      const paths = (rule.http?.paths || []).map(path => {
        const backendSvc = path.backend?.service?.name;
        let endpointStatus = 'unknown';

        if (backendSvc) {
          const slices = slicesRes.body.items.filter(
            s => s.metadata?.labels?.['kubernetes.io/service-name'] === backendSvc
          );
          const readyEndpoints = slices.reduce(
            (sum, s) => sum + (s.endpoints?.filter(e => e.conditions?.ready).length || 0),
            0
          );
          endpointStatus = readyEndpoints > 0 ? `${readyEndpoints} ready` : 'NO READY ENDPOINTS';
        }

        return {
          path: path.path,
          pathType: path.pathType,
          backend: backendSvc,
          backendPort: path.backend?.service?.port,
          endpointStatus,
        };
      });

      return { host: rule.host || '*', paths };
    });

    const issues: string[] = [];
    if (!classExists) issues.push(`IngressClass '${ingressClass}' not found in cluster`);
    ruleAnalysis.forEach(r =>
      r.paths.forEach(p => {
        if (p.endpointStatus === 'NO READY ENDPOINTS') {
          issues.push(`Backend '${p.backend}' has no ready endpoints for path ${p.path}`);
        }
      })
    );

    return {
      name: ing.metadata?.name,
      ingressClass,
      classExists,
      tls: ing.spec?.tls?.map(t => ({ hosts: t.hosts, tlsConfigured: true })),
      rules: ruleAnalysis,
      issues,
    };
  });

  return {
    namespace: ns,
    availableIngressClasses: availableClasses,
    ingresses: results,
    totalIssues: results.reduce((sum, r) => sum + r.issues.length, 0),
  };
}
