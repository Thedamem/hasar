import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";

type JsonValue = Record<string, unknown>;

type JsonResponse = {
  body: JsonValue;
  fingerprint: string;
};

function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "")
    .replace(/[^0-9a-f]/g, "");
}

function jsonRequest(
  url: string,
  method: "GET" | "POST",
  body?: JsonValue,
): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") {
      reject(new Error("plugin URL must use https"));
      return;
    }
    const payload = body ? JSON.stringify(body) : undefined;
    const request = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        rejectUnauthorized: false,
        timeout: 15_000,
        headers: {
          accept: "application/json",
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload).toString(),
              }
            : {}),
        },
      },
      (response: IncomingMessage) => {
        const socket = response.socket as TLSSocket | null;
        const cert = socket?.getPeerCertificate(true);
        const fingerprint = normalizeFingerprint(
          cert?.fingerprint256 ?? cert?.fingerprint ?? "",
        );
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode >= 400) {
            reject(
              new Error(
                `plugin returned HTTP ${response.statusCode ?? "?"}: ${raw.slice(0, 300)}`,
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(raw) as JsonValue;
            resolve({ body: parsed, fingerprint });
          } catch {
            reject(new Error("plugin returned non-JSON response"));
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("plugin request timed out")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function pairPlugin(
  pluginUrl: string,
  code: string,
): Promise<{ token: string; deviceId: string; fingerprint: string }> {
  const base = pluginUrl.trim().replace(/\/+$/, "");
  const info = await jsonRequest(`${base}/v1/pairing`, "GET");
  const advertised = normalizeFingerprint(String(info.body.fingerprint ?? ""));
  if (!advertised || advertised !== info.fingerprint) {
    throw new Error("plugin certificate fingerprint mismatch");
  }
  const paired = await jsonRequest(`${base}/v1/pair`, "POST", {
    code,
    client_name: "Hasar add-on",
  });
  const token = paired.body.token;
  const deviceId = paired.body.device_id;
  if (typeof token !== "string" || typeof deviceId !== "string") {
    throw new Error("plugin did not return token/device_id");
  }
  return { token, deviceId, fingerprint: `sha256:${advertised}` };
}
