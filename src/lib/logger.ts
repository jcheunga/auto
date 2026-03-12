export type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggerOptions {
  level?: LogLevel;
  bindings?: Record<string, unknown>;
}

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.level ?? "info";
    this.bindings = options.bindings ?? {};
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger({
      level: this.minLevel,
      bindings: {
        ...this.bindings,
        ...bindings
      }
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.emit("error", message, fields);
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (levelWeights[level] < levelWeights[this.minLevel]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.bindings,
      ...(fields ? sanitizeFields(fields) : {})
    };

    const line = JSON.stringify(payload);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

export function normalizeLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return sanitizeFields({
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack
    });
  }

  return {
    errorMessage: String(error)
  };
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, sanitizeValue(value)])
  );
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `<Buffer ${value.length} bytes>`;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (value && typeof value === "object") {
    return sanitizeFields(value as Record<string, unknown>);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}
