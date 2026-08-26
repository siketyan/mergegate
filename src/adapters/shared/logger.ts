import type { Logger } from "../../ports.ts";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured JSON lines, so the delivery id travels with every message. */
export function createLogger(minimum: Level, base: Record<string, unknown> = {}): Logger {
  const write = (level: Level, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[minimum]) {
      return;
    }
    console.log(JSON.stringify({ level, message, ...base, ...fields }));
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    with: (fields) => createLogger(minimum, { ...base, ...fields }),
  };
}
