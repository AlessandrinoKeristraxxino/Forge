// src/core/logger.ts
//
// Forge Logger (structured, lightweight)
// --------------------------------------
// Central logging utility used by:
// - server.ts (LSP server)
// - run.ts (runner)
// - core pipeline modules (lexer/parser/semantic) if desired
//
// Goals:
// - Consistent formatting
// - Optional debug mode
// - No dependencies
// - Easy to route logs to VS Code OutputChannel later
//
// Exported API:
//   - Logger
//   - createLogger(options)
//   - logOnce(key, ...)
//   - time(label) -> timer helper
//
// Usage:
//   const log = createLogger({ name: "forge", level: "info" });
//   log.info("Hello", { x: 1 });
//   const t = log.time("parse"); ... t.end();
//
// Levels:
//   silent < error < warn < info < debug < trace

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "trace";

export type LoggerOptions = {
  name?: string; // prefix
  level?: LogLevel;

  // Custom sink. If not provided, uses console.
  sink?: {
    error: (msg: string) => void;
    warn: (msg: string) => void;
    info: (msg: string) => void;
    debug: (msg: string) => void;
  };

  // Whether to include timestamps in log lines
  timestamp?: boolean;

  // If true, include JSON payload after message when payload is provided
  includePayload?: boolean;
};

export type Timer = {
  end: (payload?: any) => void;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export class Logger {
  private readonly name: string;
  private level: LogLevel;
  private readonly sink: Required<LoggerOptions>["sink"];
  private readonly timestamp: boolean;
  private readonly includePayload: boolean;

  private onceKeys = new Set<string>();

  constructor(options: LoggerOptions = {}) {
    this.name = options.name ?? "forge";
    this.level = options.level ?? "info";
    this.timestamp = options.timestamp ?? true;
    this.includePayload = options.includePayload ?? true;

    const consoleSink = {
      error: (msg: string) => console.error(msg),
      warn: (msg: string) => console.warn(msg),
      info: (msg: string) => console.log(msg),
      debug: (msg: string) => console.debug(msg),
    };

    this.sink = (options.sink ?? consoleSink) as any;
  }

  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  public error(msg: string, payload?: any): void {
    this.emit("error", msg, payload);
  }

  public warn(msg: string, payload?: any): void {
    this.emit("warn", msg, payload);
  }

  public info(msg: string, payload?: any): void {
    this.emit("info", msg, payload);
  }

  public debug(msg: string, payload?: any): void {
    this.emit("debug", msg, payload);
  }

  public trace(msg: string, payload?: any): void {
    // Trace goes to debug sink but only enabled when level is trace
    this.emit("trace", msg, payload);
  }

  public logOnce(level: Exclude<LogLevel, "silent">, key: string, msg: string, payload?: any): void {
    if (this.onceKeys.has(key)) return;
    this.onceKeys.add(key);

    // route to correct method
    if (level === "error") this.error(msg, payload);
    else if (level === "warn") this.warn(msg, payload);
    else if (level === "info") this.info(msg, payload);
    else if (level === "debug") this.debug(msg, payload);
    else this.trace(msg, payload);
  }

  public time(label: string): Timer {
    const start = nowMs();
    const safeLabel = String(label ?? "timer");

    this.debug(`⏱ start ${safeLabel}`);

    return {
      end: (payload?: any) => {
        const ms = nowMs() - start;
        this.debug(`⏱ end ${safeLabel} (${ms.toFixed(2)}ms)`, payload);
      },
    };
  }

  private emit(level: Exclude<LogLevel, "silent">, msg: string, payload?: any): void {
    if (!this.enabled(level)) return;

    const line = this.formatLine(level, msg, payload);

    if (level === "error") this.sink.error(line);
    else if (level === "warn") this.sink.warn(line);
    else this.sink.info(line); // info/debug/trace go to info by default

    // Also emit debug/trace to debug sink if present
    if (level === "debug" || level === "trace") {
      this.sink.debug(line);
    }
  }

  private enabled(level: Exclude<LogLevel, "silent">): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level];
  }

  private formatLine(level: string, msg: string, payload?: any): string {
    const ts = this.timestamp ? `${isoTime()} ` : "";
    const prefix = `[${this.name}]`;
    const lv = level.toUpperCase();

    if (payload === undefined || !this.includePayload) {
      return `${ts}${prefix} ${lv}: ${msg}`;
    }

    const serialized = safeStringify(payload);
    return `${ts}${prefix} ${lv}: ${msg} ${serialized}`;
  }
}

/* =========================================================
   Factory
   ========================================================= */

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options);
}

/* =========================================================
   Utilities
   ========================================================= */

export function safeStringify(value: any): string {
  try {
    if (typeof value === "string") return JSON.stringify(value);
    return JSON.stringify(value, null, 2);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}

function nowMs(): number {
  const perf = (globalThis as any).performance;
  if (perf && typeof perf.now === "function") return perf.now();
  return Date.now();
}

function isoTime(): string {
  const d = new Date();
  // compact ISO without ms for readability
  const iso = d.toISOString(); // 2026-02-04T...
  return iso.replace(/\.\d{3}Z$/, "Z");
}
