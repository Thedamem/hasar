import { requestJson } from "./http.js";

function haEndpoint(): { base: string; token: string } | null {
  const token = process.env.SUPERVISOR_TOKEN ?? process.env.HA_TOKEN;
  if (!token) return null;
  const base =
    process.env.HA_URL ??
    (process.env.SUPERVISOR_TOKEN ? "http://supervisor/core/api" : "");
  if (!base) return null;
  return { base: base.replace(/\/+$/, ""), token };
}

export async function callHaService(
  domain: string,
  service: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const endpoint = haEndpoint();
  if (!endpoint) throw new Error("Home Assistant token is not configured");
  const url = `${endpoint.base}/services/${domain}/${service}?return_response=true`;
  const payload = (await requestJson(url, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}` },
    body: data,
    timeoutMs: 60_000,
  })) as { service_response?: unknown } | undefined;
  return payload?.service_response ?? payload;
}

export function textFromAssistResponse(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const response = object.response as Record<string, unknown> | undefined;
  const speech = response?.speech as Record<string, unknown> | undefined;
  const plain = speech?.plain as Record<string, unknown> | undefined;
  if (typeof plain?.speech === "string") return plain.speech;
  const simple = response?.speech as Record<string, unknown> | undefined;
  if (typeof simple?.text === "string") return simple.text;
  return null;
}
