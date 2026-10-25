import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

export async function nodeNetworkStatus(_args: Record<string, never>) {
  const { body } = await coreV1Api.listNode();

  const nodes = body.items.map(node => {
    const conditions = node.status?.conditions || [];
    const networkUnavailable = conditions.find(c => c.type === 'NetworkUnavailable');
    const ready = conditions.find(c => c.type === 'Ready');

    return {
      name: node.metadata?.name,
      ready: ready?.status === 'True',
      networkUnavailable: networkUnavailable?.status === 'True',
      networkStatus:
        networkUnavailable?.status === 'True'
          ? `NETWORK UNAVAILABLE: ${networkUnavailable.message}`
          : 'Network OK',
      architecture: node.status?.nodeInfo?.architecture,
      osImage: node.status?.nodeInfo?.osImage,
      kubeletVersion: node.status?.nodeInfo?.kubeletVersion,
      allocatable: {
        cpu: node.status?.allocatable?.['cpu'],
        memory: node.status?.allocatable?.['memory'],
      },
    };
  });

  return {
    totalNodes: body.items.length,
    nodes,
    issues: nodes
      .filter(n => n.networkUnavailable)
      .map(n => `Node ${n.name} has NetworkUnavailable condition`),
  };
}
