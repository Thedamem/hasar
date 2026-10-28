import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";

import type { Config } from "./config.js";

function normalizeFingerprint(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "")
    .replace(/[^0-9a-f]/g, "");
}

type RawRequest = {
  method: "GET" | "POST";
  path: string;
  body?: Buffer | string;
  contentType?: string;
  timeoutMs?: number;
  verified?: boolean;
};

function pluginRequestRaw(
  config: Config,
  options: RawRequest,
): Promise<{ statusCode: number; body: Buffer }> {
  if (!config.plugin.url || !config.plugin.token) {
    return Promise.reject(new Error("plugin is not paired"));
  }
  const target = new URL(config.plugin.url);
  if (target.protocol !== "https:") {
    return Promise.reject(new Error("plugin URL must use https"));
  }

  const payload =
    options.body === undefined
      ? undefined
      : Buffer.isBuffer(options.body)
        ? options.body
        : Buffer.from(options.body, "utf8");

  return new Promise((resolve, reject) => {
    let peerFingerprint = "";
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.plugin.token}`,
      accept: "application/json",
    };
    if (payload) {
      headers["content-type"] = options.contentType ?? "application/json";
      headers["content-length"] = payload.length.toString();
    }

    const request = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: options.path,
        method: options.method,
        rejectUnauthorized: false,
        timeout: options.timeoutMs ?? 15_000,
        headers,
      },
      (response: IncomingMessage) => {
        const socket = (request.socket ?? response.socket) as TLSSocket | null;
        const cert = socket?.getPeerCertificate(true);
        const liveFingerprint = normalizeFingerprint(
          cert?.fingerprint256 ?? cert?.fingerprint ?? "",
        );
        const fingerprint = liveFingerprint || peerFingerprint;
        if (
          !options.verified &&
          config.plugin.fingerprint &&
          fingerprint !== normalizeFingerprint(config.plugin.fingerprint)
        ) {
          reject(new Error("plugin certificate fingerprint mismatch"));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if (!response.statusCode || response.statusCode >= 400) {
            reject(
              new Error(
                `plugin HTTP ${response.statusCode ?? "?"}: ${body
                  .toString("utf8")
                  .slice(0, 300)}`,
              ),
            );
            return;
          }
          resolve({ statusCode: response.statusCode, body });
        });
      },
    );
    let peerSocket: TLSSocket | null = null;
    const capture = () => {
      const cert = peerSocket?.getPeerCertificate?.(true);
      const value = normalizeFingerprint(
        cert?.fingerprint256 ?? cert?.fingerprint ?? "",
      );
      if (value) peerFingerprint = value;
    };
    request.on("socket", (socket) => {
      peerSocket = socket as TLSSocket;
      // For a new TLS socket the certificate may not be available yet;
      // secureConnect fires once the handshake is complete. Reused sockets
      // already have it.
      capture();
      peerSocket.once("secureConnect", capture);
    });
    // Important for 204 responses: by the time the response callback runs,
    // Node may have already released the peer certificate.
    request.on("finish", capture);
    request.on("timeout", () =>
      request.destroy(new Error("plugin request timed out")),
    );
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function verifyPluginFingerprint(config: Config): Promise<void> {
  const expected = normalizeFingerprint(config.plugin.fingerprint);
  if (!expected) return Promise.resolve();

  const target = new URL(config.plugin.url);
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      {
        host: hostname,
        port: Number(target.port || 443),
        servername: hostname,
        rejectUnauthorized: false,
        timeout: 5000,
      },
      () => {
        const cert = socket.getPeerCertificate(true);
        const actual = normalizeFingerprint(
          cert?.fingerprint256 ?? cert?.fingerprint ?? "",
        );
        socket.end();
        if (actual !== expected) {
          reject(new Error("plugin certificate fingerprint mismatch"));
          return;
        }
        resolve();
      },
    );
    socket.on("timeout", () =>
      socket.destroy(new Error("plugin TLS verification timed out")),
    );
    socket.on("error", reject);
  });
}

async function pluginJson<T>(
  config: Config,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T | undefined> {
  await verifyPluginFingerprint(config);
  const response = await pluginRequestRaw(config, {
    method,
    path,
    body: body === undefined ? undefined : JSON.stringify(body),
    verified: true,
  });
  if (!response.body.length) return undefined;
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw new Error("plugin returned non-JSON response");
  }
}

export async function playWav(config: Config, audio: Buffer): Promise<void> {
  await verifyPluginFingerprint(config);
  await pluginRequestRaw(config, {
    method: "POST",
    path: "/v1/play",
    body: audio,
    contentType: "audio/wav",
    timeoutMs: 30_000,
    verified: true,
  });
}

export function pluginInfo(config: Config): Promise<Record<string, unknown> | undefined> {
  return pluginJson<Record<string, unknown>>(config, "GET", "/v1/info");
}

export function pluginState(config: Config): Promise<Record<string, unknown> | undefined> {
  return pluginJson<Record<string, unknown>>(config, "GET", "/v1/state");
}

export function pluginLed(config: Config, colors: string[]): Promise<void> {
  return pluginJson(config, "POST", "/v1/led", { colors }).then(() => undefined);
}

export function pluginLedOff(config: Config): Promise<void> {
  return pluginJson(config, "POST", "/v1/led/off").then(() => undefined);
}

export function pluginClock(
  config: Config,
  clock: { time?: string; brightness?: number; off?: boolean },
): Promise<void> {
  return pluginJson(config, "POST", "/v1/clock", clock).then(() => undefined);
}

export function pluginCancel(config: Config): Promise<void> {
  return pluginJson(config, "POST", "/v1/cancel").then(() => undefined);
}
