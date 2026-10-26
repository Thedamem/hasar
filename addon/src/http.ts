import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";

export type JsonRequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  proxy?: string;
  timeoutMs?: number;
};

export function requestJson(
  url: string,
  options: JsonRequestOptions = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const payload =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...options.headers,
    };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload).toString();
    }
    const agent = options.proxy ? new SocksProxyAgent(options.proxy) : undefined;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const request = transport(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers,
        agent,
        timeout: timeoutMs,
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!response.statusCode || response.statusCode >= 400) {
            reject(
              new Error(
                `HTTP ${response.statusCode ?? "?"}: ${text.slice(0, 800)}`,
              ),
            );
            return;
          }
          if (!text) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error("provider returned non-JSON response"));
          }
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("provider request timed out")),
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}
