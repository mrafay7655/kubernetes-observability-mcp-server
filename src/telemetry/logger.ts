import winston from 'winston';
import { trace } from '@opentelemetry/api';

const baseFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const span = trace.getActiveSpan();
    const spanContext = span?.spanContext();
    const traceFields = spanContext
      ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
      : {};
    return JSON.stringify({ timestamp, level, message, ...traceFields, ...meta });
  })
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: baseFormat,
  transports: [new winston.transports.Console({ stderrLevels: ['error', 'warn', 'info', 'debug'] })],
});
