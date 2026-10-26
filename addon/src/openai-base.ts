import type { Config } from "./config.js";

export function openAiBaseUrl(config: Config): string {
  let base = config.openai.baseUrl.trim().replace(/\/+$/, "");
  if (!base) return "";
  if (base.endsWith("/chat/completions")) {
    base = base.slice(0, -"/chat/completions".length);
  }
  if (base.endsWith("/models")) {
    base = base.slice(0, -"/models".length);
  }
  if (/^https?:\/\/api\.openai\.com$/i.test(base)) {
    base = `${base}/v1`;
  }
  return base;
}
