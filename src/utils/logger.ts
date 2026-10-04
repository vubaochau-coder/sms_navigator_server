const SENSITIVE_KEY_REGEX = /(password|token|secret|authorization|private_key|privatekey|seed)/i;

/**
 * Mask sensitive values in objects before logging
 */
export function sanitizeLogData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogData(item));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(key) && typeof value === 'string') {
      sanitized[key] = value.length > 8 ? `${value.slice(0, 4)}...***` : '***';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeLogData(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function formatLogMessage(
  level: string,
  message: string,
  meta?: unknown,
  error?: unknown
): string {
  const timestamp = new Date().toISOString();
  let logStr = `[${timestamp}] [${level}] ${message}`;

  if (meta && Object.keys(meta as object).length > 0) {
    try {
      const sanitized = sanitizeLogData(meta);
      logStr += ` | Context: ${JSON.stringify(sanitized)}`;
    } catch {
      // Ignore serialization issues
    }
  }

  if (error) {
    if (error instanceof Error) {
      logStr += `\n  Error: ${error.name}: ${error.message}`;
      if (error.stack) {
        logStr += `\n  Stack: ${error.stack}`;
      }
    } else {
      logStr += `\n  Error: ${String(error)}`;
    }
  }

  return logStr;
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.log(formatLogMessage('INFO', message, meta));
  },

  warn(message: string, meta?: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.warn(formatLogMessage('WARN', message, meta));
  },

  error(message: string, error?: unknown, meta?: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.error(formatLogMessage('ERROR', message, meta, error));
  },

  debug(message: string, meta?: Record<string, unknown>): void {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.debug(formatLogMessage('DEBUG', message, meta));
    }
  }
};
