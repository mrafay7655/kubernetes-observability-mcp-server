import * as k8s from '@kubernetes/client-node';
import { validateK8sName } from './validate';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);

export async function listDeployments(args: { namespace?: string }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  const { body } = await appsV1Api.listNamespacedDeployment(ns);
  return {
    namespace: ns,
    total: body.items.length,
    deployments: body.items.map(d => ({
      name: d.metadata?.name,
      replicas: d.spec?.replicas,
      readyReplicas: d.status?.readyReplicas ?? 0,
      availableReplicas: d.status?.availableReplicas ?? 0,
      updatedReplicas: d.status?.updatedReplicas ?? 0,
      conditions: d.status?.conditions?.map(c => ({
        type: c.type, status: c.status, reason: c.reason, message: c.message
      })),
      age: d.metadata?.creationTimestamp,
    })),
  };
}

export async function describeDeployment(args: { name: string; namespace?: string }) {
  const ns = args.namespace || 'default';
  validateK8sName(ns, 'namespace');
  validateK8sName(args.name, 'name');
  const { body } = await appsV1Api.readNamespacedDeployment(args.name, ns);
  return {
    name: body.metadata?.name,
    namespace: body.metadata?.namespace,
    replicas: body.spec?.replicas,
    readyReplicas: body.status?.readyReplicas,
    strategy: body.spec?.strategy,
    selector: body.spec?.selector,
    conditions: body.status?.conditions,
    containers: body.spec?.template?.spec?.containers?.map(c => ({
      name: c.name,
      image: c.image,
      resources: c.resources,
      envVarCount: c.env?.length ?? 0,
    })),
  };
}
