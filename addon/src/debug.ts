import { randomUUID } from "node:crypto";

export type AskSource = "station" | "debug" | "api";

export type DebugEvent = {
  id: string;
  at: string;
  source: AskSource;
  text: string;
  route?: string;
  intent?: string;
  provider: string;
  model: string;
  durationMs: number;
  audio?: string;
  error?: string;
};

function redact(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, "Bearer [redacted]");
}

const MAX_EVENTS = 50;
const events: DebugEvent[] = [];

export function recordAsk(event: Omit<DebugEvent, "id" | "at">): DebugEvent {
  const entry: DebugEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...event,
    text: event.text.slice(0, 2000),
    error: event.error ? redact(event.error).slice(0, 2000) : undefined,
  };
  events.unshift(entry);
  events.splice(MAX_EVENTS);
  return entry;
}

export function recentAsks(): DebugEvent[] {
  return events.slice();
}
