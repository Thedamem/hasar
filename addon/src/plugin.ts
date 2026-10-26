import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { TLSSocket } from "node:tls";

import type { Config } from "./config.js";

function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "")
    .replace(/[^0-9a-f]/g, "");
}

export function playWav(config: Config, audio: Buffer): Promise<void> {
  if (!config.plugin.url || !config.plugin.token) {
    return Promise.reject(new Error("plugin is not paired"));
  }
  const target = new URL(config.plugin.url);
  if (target.protocol !== "https:") {
    return Promise.reject(new Error("plugin URL must use https"));
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: "/v1/play",
        method: "POST",
        rejectUnauthorized: false,
        timeout: 30_000,
        headers: {
          authorization: `Bearer ${config.plugin.token}`,
          "content-type": "audio/wav",
          "content-length": audio.length.toString(),
        },
      },
      (response: IncomingMessage) => {
        const socket = response.socket as TLSSocket | null;
        const cert = socket?.getPeerCertificate(true);
        const fingerprint = normalizeFingerprint(
          cert?.fingerprint256 ?? cert?.fingerprint ?? "",
        );
        if (
          config.plugin.fingerprint &&
          fingerprint !== normalizeFingerprint(config.plugin.fingerprint)
        ) {
          reject(new Error("plugin certificate fingerprint mismatch"));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (!response.statusCode || response.statusCode >= 400) {
            reject(
              new Error(
                `plugin HTTP ${response.statusCode ?? "?"}: ${Buffer.concat(chunks)
                  .toString("utf8")
                  .slice(0, 300)}`,
              ),
            );
            return;
          }
          resolve();
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("plugin request timed out")));
    request.on("error", reject);
    request.end(audio);
  });
}
