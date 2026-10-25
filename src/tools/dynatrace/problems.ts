import axios from 'axios';

const K8S_NAME_RE = /^[a-z0-9][a-z0-9\-]{0,62}$/;
const DT_URL_RE = /^https:\/\/[a-z0-9\-]+\.(live|managed)\.dynatrace\.com$/;

function dtClient() {
  const dtBaseUrl = process.env.DT_ENV_URL;
  const dtToken = process.env.DT_API_TOKEN;
  if (!dtBaseUrl || !dtToken) {
    throw new Error('DT_ENV_URL and DT_API_TOKEN environment variables must be set');
  }
  if (!DT_URL_RE.test(dtBaseUrl)) {
    throw new Error('DT_ENV_URL must be a valid Dynatrace URL: https://<env-id>.live.dynatrace.com');
  }
  return axios.create({
    baseURL: `${dtBaseUrl}/api/v2`,
    timeout: 30000,
    headers: {
      Authorization: `Api-Token ${dtToken}`,
      'Content-Type': 'application/json',
    },
  });
}

export async function getDynatraceProblems(args: {
  namespace?: string;
  status?: string;
  time_from?: string;
}) {
  const client = dtClient();

  if (args.namespace && !K8S_NAME_RE.test(args.namespace)) {
    throw new Error('namespace must be lowercase alphanumeric with dashes, max 63 chars');
  }
  // Dynatrace API only accepts status(OPEN) — omit filter to get all problems
  const params: Record<string, string> = {
    fields: '+evidenceDetails,+impactAnalysis',
    from: args.time_from || 'now-2h',
  };

  if (args.status === 'OPEN') {
    params['problemSelector'] = 'status(OPEN)';
  }
  // For RESOLVED or ALL — omit status filter, API returns everything in time range

  if (args.namespace) {
    params['entitySelector'] =
      `type(CLOUD_APPLICATION_NAMESPACE),entityName("${args.namespace}")`;
  }

  const { data } = await client.get('/problems', { params });

  return {
    totalProblems: data.totalCount,
    problems: (data.problems || []).map((p: Record<string, unknown>) => ({
      id: p['problemId'],
      title: p['title'],
      status: p['status'],
      severity: p['severityLevel'],
      impactLevel: p['impactLevel'],
      startTime: new Date(p['startTime'] as number).toISOString(),
      duration: p['endTime']
        ? `${Math.round(((p['endTime'] as number) - (p['startTime'] as number)) / 60000)} min`
        : 'ongoing',
      affectedEntities: (p['affectedEntities'] as Array<Record<string, unknown>>)?.map(e => ({
        id: (e['entityId'] as Record<string, unknown>)?.['id'],
        name: e['name'],
      })),
      rootCause: (p['rootCauseEntity'] as Record<string, unknown>)?.['name'],
    })),
  };
}

export async function correlateAlertsWithEvents(args: {
  namespace?: string;
  time_from?: string;
  time_to?: string;
}) {
  const client = dtClient();

  if (args.namespace && !K8S_NAME_RE.test(args.namespace)) {
    throw new Error('namespace must be lowercase alphanumeric with dashes, max 63 chars');
  }
  const from = args.time_from || 'now-1h';

  // Fetch problems — events v2 endpoint may not be available on all environments
  const problemsRes = await client.get('/problems', {
    params: {
      from,
      ...(args.time_to ? { to: args.time_to } : {}),
    },
  });

  // Try events v2 endpoint — gracefully skip if unavailable (404) on this environment
  const eventsRes = await client
    .get('/events', {
      params: {
        from,
        ...(args.time_to ? { to: args.time_to } : {}),
        eventSelector:
          'eventType("KUBERNETES_NODE_UNAVAILABLE","KUBERNETES_POD_EVICTION","KUBERNETES_UNSCHEDULABLE")',
      },
    })
    .catch((e) => {
      const status = e.response?.status;
      return {
        data: {
          events: [],
          _note: status === 404
            ? 'Events v2 API not available on this Dynatrace environment'
            : `Events API error: ${status}`,
        },
      };
    });

  return {
    namespace: args.namespace || 'all',
    timeRange: { from, to: args.time_to || 'now' },
    dynatraceProblems: problemsRes.data.totalCount,
    kubernetesEvents: (eventsRes.data.events || []).length,
    eventsNote: eventsRes.data['_note'] || null,
    problems: (problemsRes.data.problems || []).slice(0, 10).map((p: Record<string, unknown>) => ({
      id: p['problemId'],
      title: p['title'],
      severity: p['severityLevel'],
      status: p['status'],
      startTime: new Date(p['startTime'] as number).toISOString(),
    })),
    k8sEvents: (eventsRes.data.events || []).slice(0, 10).map((e: Record<string, unknown>) => ({
      eventType: e['eventType'],
      title: e['title'],
      entityName: (e['entityId'] as Record<string, unknown>)?.['name'],
      startTime: new Date(e['startTime'] as number).toISOString(),
    })),
  };
}
