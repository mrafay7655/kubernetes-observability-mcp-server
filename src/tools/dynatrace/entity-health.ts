import axios from 'axios';

const ALLOWED_ENTITY_TYPES = new Set([
  'SERVICE', 'PROCESS_GROUP', 'CLOUD_APPLICATION', 'CLOUD_APPLICATION_NAMESPACE',
  'HOST', 'APPLICATION', 'SYNTHETIC_TEST', 'KUBERNETES_CLUSTER',
]);

const ENTITY_NAME_RE = /^[a-zA-Z0-9._:/@\-\s]{1,200}$/;
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

export async function getEntityHealth(args: { entity_name: string; entity_type?: string }) {
  const client = dtClient();

  if (!args.entity_name || !ENTITY_NAME_RE.test(args.entity_name)) {
    throw new Error('entity_name must be 1-200 chars of alphanumeric, dots, dashes, colons, slashes, or spaces');
  }

  const entityType = args.entity_type || 'SERVICE';
  if (!ALLOWED_ENTITY_TYPES.has(entityType.toUpperCase())) {
    throw new Error(`entity_type must be one of: ${[...ALLOWED_ENTITY_TYPES].join(', ')}`);
  }

  const { data } = await client.get('/entities', {
    params: {
      entitySelector: `type(${entityType.toUpperCase()}),entityName("${args.entity_name}")`,
      fields: '+properties,+toRelationships,+fromRelationships',
    },
  });

  if (!data.entities?.length) {
    return {
      found: false,
      message: `No Dynatrace entity found for '${args.entity_name}' of type ${entityType}`,
    };
  }

  const entity = data.entities[0] as Record<string, unknown>;
  const entityId = entity['entityId'];

  const metricsRes = await client
    .get('/metrics/query', {
      params: {
        metricSelector: 'builtin:service.response.time:avg,builtin:service.errors.total.rate',
        entitySelector: `entityId("${entityId}")`,
        resolution: '5m',
        from: 'now-30m',
      },
    })
    .catch(() => null);

  return {
    found: true,
    entityId,
    entityName: entity['displayName'],
    entityType: entity['type'],
    properties: entity['properties'],
    metrics: metricsRes?.data?.resolution
      ? {
          avgResponseTime: (metricsRes.data.result?.[0]?.data?.[0]?.values as number[])?.at(-1),
          errorRate: (metricsRes.data.result?.[1]?.data?.[0]?.values as number[])?.at(-1),
        }
      : 'Metrics unavailable',
  };
}
