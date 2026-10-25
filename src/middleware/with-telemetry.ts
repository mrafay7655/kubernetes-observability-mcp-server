import { SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { getTracer, getMeter } from '../telemetry/tracing';
import { logger } from '../telemetry/logger';

// Simple token bucket: max 10 tool calls per second globally
let tokens = 10;
const MAX_TOKENS = 10;
const REFILL_INTERVAL_MS = 1000;
setInterval(() => { tokens = MAX_TOKENS; }, REFILL_INTERVAL_MS).unref();

function checkRateLimit(): void {
  if (tokens <= 0) {
    throw new Error('Rate limit exceeded — too many tool calls per second. Please slow down.');
  }
  tokens--;
}

const meter = getMeter();

const invocationCounter = meter.createCounter('mcp.tool.invocations', {
  description: 'Number of MCP tool invocations',
});

const errorCounter = meter.createCounter('mcp.tool.errors', {
  description: 'Number of MCP tool errors',
});

const latencyHistogram = meter.createHistogram('mcp.tool.duration_ms', {
  description: 'MCP tool call duration in milliseconds',
  unit: 'ms',
});

export function withTelemetry<T extends Record<string, unknown>>(
  toolName: string,
  handler: (args: T) => Promise<unknown>
): (args: T) => Promise<unknown> {
  return async (args: T) => {
    checkRateLimit();
    const tracer = getTracer();
    const start = Date.now();

    return tracer.startActiveSpan(
      `mcp.tool.${toolName}`,
      { kind: SpanKind.SERVER, attributes: { 'mcp.tool.name': toolName } },
      async (span) => {
        invocationCounter.add(1, { tool: toolName });
        logger.info(`Tool invoked: ${toolName}`, { tool: toolName });

        try {
          const result = await handler(args);
          const duration = Date.now() - start;
          latencyHistogram.record(duration, { tool: toolName, status: 'success' });
          span.setAttribute('mcp.tool.duration_ms', duration);
          span.setAttribute('mcp.tool.success', true);
          span.setStatus({ code: SpanStatusCode.OK });
          logger.info(`Tool completed: ${toolName}`, { tool: toolName, duration_ms: duration });
          return result;
        } catch (err: unknown) {
          const duration = Date.now() - start;
          const message = err instanceof Error ? err.message : String(err);
          errorCounter.add(1, { tool: toolName });
          latencyHistogram.record(duration, { tool: toolName, status: 'error' });
          span.setAttribute('mcp.tool.success', false);
          span.setAttribute('mcp.tool.error', message);
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          // Record a sanitized exception — never the raw axios error (contains Authorization headers)
          span.recordException(new Error(message));
          logger.error(`Tool failed: ${toolName}`, { tool: toolName, error: message, duration_ms: duration });
          throw err;
        } finally {
          span.end();
        }
      }
    );
  };
}
