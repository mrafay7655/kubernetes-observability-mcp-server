import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);
const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);

export async function debugDnsConfig(args: { pod_name?: string; namespace?: string }) {
  const ns = args.namespace || 'default';

  const [coreDnsPodsRes, coreDnsConfigRes, coreDnsSvcRes, coreDnsDeployRes] = await Promise.all([
    coreV1Api.listNamespacedPod(
      'kube-system', undefined, undefined, undefined, undefined, 'k8s-app=kube-dns'
    ),
    coreV1Api.readNamespacedConfigMap('coredns', 'kube-system').catch(() => null),
    coreV1Api.readNamespacedService('kube-dns', 'kube-system').catch(() => null),
    appsV1Api.readNamespacedDeployment('coredns', 'kube-system').catch(() => null),
  ]);

  const coreDnsPods = coreDnsPodsRes.body.items;
  const coreDnsHealth = {
    deploymentReady: coreDnsDeployRes
      ? (coreDnsDeployRes.body.status?.readyReplicas ?? 0) > 0
      : false,
    pods: coreDnsPods.map(p => ({
      name: p.metadata?.name,
      phase: p.status?.phase,
      ready: p.status?.containerStatuses?.every(c => c.ready),
      restarts: p.status?.containerStatuses?.[0]?.restartCount,
    })),
    clusterIP: coreDnsSvcRes?.body.spec?.clusterIP,
    // Return plugin summary only — raw Corefile contains internal DNS topology
    corefilePlugins: coreDnsConfigRes?.body.data?.['Corefile']
      ?.match(/^\s*(\w+)\s/gm)
      ?.map((s: string) => s.trim())
      .filter((s: string) => s.length > 0) ?? [],
    corefilePresent: !!coreDnsConfigRes?.body.data?.['Corefile'],
  };

  let podDnsInfo = null;
  if (args.pod_name) {
    const podRes = await coreV1Api.readNamespacedPod(args.pod_name, ns);
    const pod = podRes.body;
    podDnsInfo = {
      pod: args.pod_name,
      dnsPolicy: pod.spec?.dnsPolicy,
      dnsConfig: pod.spec?.dnsConfig,
      recommendation:
        pod.spec?.dnsPolicy === 'None' && !pod.spec?.dnsConfig
          ? 'WARNING: dnsPolicy=None with no dnsConfig — pod has no DNS resolution'
          : pod.spec?.dnsPolicy === 'ClusterFirst'
          ? 'OK: Using cluster DNS (CoreDNS) as primary resolver'
          : 'Custom DNS policy — verify dnsConfig is correct for your use case',
    };
  }

  const issues: string[] = [];
  if (!coreDnsHealth.deploymentReady) {
    issues.push('CoreDNS deployment has no ready replicas — DNS resolution will fail');
  }
  coreDnsPods.forEach(p => {
    if (p.status?.phase !== 'Running') {
      issues.push(`CoreDNS pod ${p.metadata?.name} is ${p.status?.phase}`);
    }
    if ((p.status?.containerStatuses?.[0]?.restartCount ?? 0) > 5) {
      issues.push(
        `CoreDNS pod ${p.metadata?.name} has high restarts — likely OOMKilled, increase memory limits`
      );
    }
  });

  return {
    coreDns: coreDnsHealth,
    podDnsInfo,
    detectedIssues: issues,
    summary:
      issues.length === 0
        ? 'CoreDNS appears healthy — no DNS config issues detected'
        : `${issues.length} DNS issue(s) detected`,
  };
}

export async function coreDnsHealthCheck(_args: Record<string, never>) {
  const [podsRes, deployRes] = await Promise.all([
    coreV1Api.listNamespacedPod(
      'kube-system', undefined, undefined, undefined, undefined, 'k8s-app=kube-dns'
    ),
    appsV1Api.readNamespacedDeployment('coredns', 'kube-system').catch(() => null),
  ]);

  const pods = podsRes.body.items;
  const allReady = pods.every(p =>
    p.status?.containerStatuses?.every(c => c.ready)
  );
  const totalRestarts = pods.reduce(
    (sum, p) => sum + (p.status?.containerStatuses?.[0]?.restartCount ?? 0),
    0
  );

  return {
    status: allReady ? 'healthy' : 'degraded',
    pods: pods.length,
    readyPods: pods.filter(p => p.status?.phase === 'Running').length,
    totalRestarts,
    deploymentDesiredReplicas: deployRes?.body.spec?.replicas,
    deploymentReadyReplicas: deployRes?.body.status?.readyReplicas ?? 0,
    recommendation:
      !allReady
        ? 'CoreDNS pods not ready — DNS resolution will fail cluster-wide. Check logs with get_pod_logs.'
        : totalRestarts > 10
        ? 'High restart count — CoreDNS may be OOMKilled. Consider increasing memory limits in kube-system.'
        : 'CoreDNS is healthy',
  };
}
