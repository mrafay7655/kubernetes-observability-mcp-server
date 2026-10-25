import * as k8s from '@kubernetes/client-node';
import { validateK8sName } from '../kubernetes/validate';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const discoveryV1Api = kc.makeApiClient(k8s.DiscoveryV1Api);

export async function checkServiceEndpoints(args: {
  namespace?: string;
  service_name?: string;
}) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  if (args.service_name) validateK8sName(args.service_name, 'service_name');

  const servicesItems = args.service_name
    ? [(await coreV1Api.readNamespacedService(args.service_name, ns)).body]
    : (await coreV1Api.listNamespacedService(ns)).body.items;

  const slicesRes = await discoveryV1Api.listNamespacedEndpointSlice(ns);

  const results = servicesItems.map(svc => {
    const svcName = svc.metadata?.name!;
    const slices = slicesRes.body.items.filter(
      s => s.metadata?.labels?.['kubernetes.io/service-name'] === svcName
    );

    const totalEndpoints = slices.reduce((sum, s) => sum + (s.endpoints?.length || 0), 0);
    const readyEndpoints = slices.reduce(
      (sum, s) => sum + (s.endpoints?.filter(e => e.conditions?.ready).length || 0),
      0
    );

    return {
      service: svcName,
      type: svc.spec?.type,
      clusterIP: svc.spec?.clusterIP,
      ports: svc.spec?.ports?.map(p => ({
        port: p.port,
        targetPort: p.targetPort,
        protocol: p.protocol,
      })),
      selector: svc.spec?.selector,
      endpointSlices: slices.length,
      totalEndpoints,
      readyEndpoints,
      status:
        readyEndpoints === 0 && totalEndpoints === 0
          ? 'NO_ENDPOINTS — selector may not match any pods'
          : readyEndpoints === 0
          ? 'ENDPOINTS_NOT_READY — pods exist but not ready'
          : 'HEALTHY',
    };
  });

  const unhealthy = results.filter(r => r.status !== 'HEALTHY');
  return {
    namespace: ns,
    totalServices: results.length,
    unhealthyServices: unhealthy.length,
    services: results,
  };
}

export async function findOrphanedServices(args: { namespace?: string }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  const [servicesRes, slicesRes] = await Promise.all([
    coreV1Api.listNamespacedService(ns),
    discoveryV1Api.listNamespacedEndpointSlice(ns),
  ]);

  const orphaned = servicesRes.body.items
    .filter(svc => svc.spec?.selector && Object.keys(svc.spec.selector).length > 0)
    .filter(svc => {
      const svcName = svc.metadata?.name!;
      const slices = slicesRes.body.items.filter(
        s => s.metadata?.labels?.['kubernetes.io/service-name'] === svcName
      );
      const readyEndpoints = slices.reduce(
        (sum, s) => sum + (s.endpoints?.filter(e => e.conditions?.ready).length || 0),
        0
      );
      return readyEndpoints === 0;
    })
    .map(svc => ({
      service: svc.metadata?.name,
      selector: svc.spec?.selector,
      type: svc.spec?.type,
      issue: 'No ready endpoints — selector may not match any running pods',
    }));

  return {
    namespace: ns,
    orphanedServicesCount: orphaned.length,
    orphanedServices: orphaned,
    recommendation:
      orphaned.length > 0
        ? 'Check that pods with matching labels exist and are Running/Ready'
        : 'All services have ready endpoints',
  };
}
