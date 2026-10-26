import type { Config } from "./config.js";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export function geminiBaseUrl(config: Config): string {
  let base = config.gemini.baseUrl.trim().replace(/\/+$/, "");
  if (!base) base = DEFAULT_BASE;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  if (base.endsWith("/models")) base = base.slice(0, -"/models".length);
  try {
    const parsed = new URL(base);
    if (
      parsed.hostname === "generativelanguage.googleapis.com" &&
      (parsed.pathname === "/" || parsed.pathname === "")
    ) {
      parsed.pathname = "/v1beta";
      base = parsed.toString().replace(/\/+$/, "");
    }
  } catch {
    // requestJson will report an invalid URL when the request is made.
  }
  return base;
}

export function geminiApiUrl(config: Config, suffix: string): string {
  return `${geminiBaseUrl(config)}/${suffix.replace(/^\/+/, "")}`;
}

export function geminiHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { "x-goog-api-key": apiKey } : {};
}

export function geminiLiveUrl(config: Config): URL {
  const base = new URL(geminiBaseUrl(config));
  const url = new URL(base.toString());
  url.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  const prefix = base.pathname
    .replace(/\/v1beta\/?$/, "")
    .replace(/\/+$/, "");
  url.pathname = `${prefix}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
  url.search = "";
  return url;
}
