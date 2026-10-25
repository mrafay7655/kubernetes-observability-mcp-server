import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { trace, metrics } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;

const DT_URL_RE = /^https:\/\/[a-z0-9\-]+\.(live|managed)\.dynatrace\.com$/;

export function initTelemetry(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    console.warn('[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT not set — telemetry disabled');
    return;
  }

  // Validate endpoint to prevent telemetry exfiltration to attacker-controlled servers
  const endpointBase = endpoint.replace(/\/api\/v2\/otlp\/?$/, '');
  if (!DT_URL_RE.test(endpointBase)) {
    console.warn('[telemetry] OTEL_EXPORTER_OTLP_ENDPOINT is not a Dynatrace URL — telemetry disabled');
    return;
  }

  // Build auth header: prefer constructing from DT_API_TOKEN to avoid requiring a duplicate token
  // in OTEL_EXPORTER_OTLP_HEADERS. Fall back to parsing OTEL_EXPORTER_OTLP_HEADERS if set.
  const headers: Record<string, string> = {};
  const dtToken = process.env.DT_API_TOKEN;
  if (dtToken) {
    headers['Authorization'] = `Api-Token ${dtToken}`;
  } else {
    const rawHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    if (rawHeaders) {
      rawHeaders.split(',').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx > 0) {
          const k = pair.substring(0, idx).trim();
          const v = pair.substring(idx + 1).trim();
          headers[k] = v;
        }
      });
    }
  }

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'kubernetes-observability-mcp-server',
    [SEMRESATTRS_SERVICE_VERSION]: process.env.OTEL_SERVICE_VERSION || '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'production',
  });

  const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers });
  const metricExporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, headers });
  const logExporter = new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 30000,
    }) as any,
    logRecordProcessors: [new BatchLogRecordProcessor(logExporter)],
  });

  sdk.start();
  console.error('[telemetry] OpenTelemetry initialized -> Dynatrace OTLP');
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
  }
}

export function getTracer() {
  return trace.getTracer(
    process.env.OTEL_SERVICE_NAME || 'kubernetes-observability-mcp-server'
  );
}

export function getMeter() {
  return metrics.getMeter(
    process.env.OTEL_SERVICE_NAME || 'kubernetes-observability-mcp-server'
  );
}
