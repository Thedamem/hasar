import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { z } from "zod";

import {
  ConfigSchema,
  SECRET_MASK,
  loadConfig,
  redactedConfig,
  saveConfig,
  type Config,
} from "./config.js";
import { recentAsks } from "./debug.js";
import { listModels } from "./models.js";
import { pairPlugin } from "./pairing.js";
import { ask } from "./pipeline.js";
import {
  pluginCancel,
  pluginClock,
  pluginInfo,
  pluginLed,
  pluginLedOff,
  pluginState,
} from "./plugin.js";

const dataDir = process.env.HASAR_DATA_DIR ?? "/data";
let logLevel = process.env.LOG_LEVEL ?? "info";

try {
  const options = JSON.parse(
    await readFile(`${dataDir}/options.json`, "utf8"),
  ) as { log_level?: unknown };
  if (typeof options.log_level === "string") logLevel = options.log_level;
} catch {
  // Local runs and tests do not have Supervisor options.
}

const app = Fastify({
  bodyLimit: 1_048_576,
  logger: {
    level: logLevel,
    redact: {
      paths: [
        "req.headers.authorization",
        'req.headers["x-goog-api-key"]',
        "req.headers.cookie",
      ],
      censor: "[redacted]",
    },
  },
});
let config: Config = await loadConfig(dataDir);

function publicError(error: unknown): string {
  return String(error)
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, "Bearer [redacted]")
    .replace(/([?&]key=)[^&\s]+/gi, "$1[redacted]");
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

async function loadUiAsset(name: string): Promise<string> {
  for (const candidate of [
    `../ui/${name}`,
    `./ui/${name}`,
    `../src/ui/${name}`,
  ]) {
    try {
      return await readFile(new URL(candidate, import.meta.url), "utf8");
    } catch {
      // Try the next layout (dist/ui in Docker, src/ui with tsx).
    }
  }
  throw new Error(`ui/${name} not found`);
}

const ui = await loadUiAsset("index.html");
const styles = await loadUiAsset("styles.css");
const appJs = await loadUiAsset("app.js");

function mergeSecrets(current: Config, next: Config): Config {
  if (next.openai.apiKey === SECRET_MASK) {
    next.openai.apiKey = current.openai.apiKey;
  }
  if (next.gemini.apiKey === SECRET_MASK) {
    next.gemini.apiKey = current.gemini.apiKey;
  }
  if (next.plugin.token === SECRET_MASK) {
    next.plugin.token = current.plugin.token;
  }
  if (next.proxy.socks5 === SECRET_MASK) {
    next.proxy.socks5 = current.proxy.socks5;
  }
  next.mcpServers = next.mcpServers.map((server) => {
    const previous =
      current.mcpServers.find((item) => item.name === server.name) ??
      (server.url
        ? current.mcpServers.find((item) => item.url === server.url)
        : undefined) ??
      (server.command
        ? current.mcpServers.find((item) => item.command === server.command)
        : undefined);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(server.headers)) {
      headers[key] =
        value === SECRET_MASK ? (previous?.headers[key] ?? "") : value;
    }
    return { ...server, headers };
  });
  return next;
}

app.addHook("onSend", async (request, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-frame-options", "SAMEORIGIN");
  if (request.url.startsWith("/api/")) {
    reply.header("cache-control", "no-store");
  }
  if (
    request.url === "/" ||
    request.url.startsWith("/?") ||
    request.url.startsWith("/index.html")
  ) {
    reply.header("cache-control", "no-cache");
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    );
  }
  return payload;
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    return reply
      .code(400)
      .send({ error: zodMessage(error), issues: error.issues });
  }
  const statusCode = (error as { statusCode?: number }).statusCode;
  const status =
    statusCode && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
  if (status >= 500) {
    request.log.error({ err: error }, "request failed");
    return reply.code(status).send({ error: "internal error" });
  }
  return reply.code(status).send({ error: publicError(error) });
});

app.get("/health", async () => ({ status: "ok", version: "0.2.1" }));

app.get("/", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(ui);
});

app.get("/index.html", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(ui);
});

app.get("/styles.css", async (_request, reply) => {
  reply.header("cache-control", "no-cache");
  return reply.type("text/css; charset=utf-8").send(styles);
});

app.get("/app.js", async (_request, reply) => {
  reply.header("cache-control", "no-cache");
  return reply.type("text/javascript; charset=utf-8").send(appJs);
});

app.get("/favicon.ico", async (_request, reply) => {
  return reply.code(204).send();
});

app.get("/api/config", async () => redactedConfig(config));

app.put("/api/config", async (request, reply) => {
  try {
    const parsed = ConfigSchema.parse(request.body);
    config = mergeSecrets(config, parsed);
    await saveConfig(dataDir, config);
    request.log.info("configuration saved");
    return redactedConfig(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply
        .code(400)
        .send({ error: zodMessage(error), issues: error.issues });
    }
    request.log.error({ err: error }, "cannot save configuration");
    return reply.code(500).send({ error: publicError(error) });
  }
});

const ModelRequestSchema = z.object({
  provider: z.enum(["openai", "gemini"]).optional(),
  openai: z
    .object({
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
  gemini: z
    .object({
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
});

app.post("/api/models", async (request, reply) => {
  const body = ModelRequestSchema.parse(request.body ?? {});
  const selected = structuredClone(config);
  if (body.provider) selected.provider = body.provider;
  if (body.openai) {
    if (body.openai.baseUrl !== undefined) {
      selected.openai.baseUrl = body.openai.baseUrl;
    }
    if (body.openai.apiKey !== undefined && body.openai.apiKey !== SECRET_MASK) {
      selected.openai.apiKey = body.openai.apiKey;
    }
  }
  if (body.gemini) {
    if (body.gemini.baseUrl !== undefined) {
      selected.gemini.baseUrl = body.gemini.baseUrl;
    }
    if (body.gemini.apiKey !== undefined && body.gemini.apiKey !== SECRET_MASK) {
      selected.gemini.apiKey = body.gemini.apiKey;
    }
  }
  try {
    return await listModels(selected);
  } catch (error) {
    request.log.warn(
      { provider: selected.provider, reason: publicError(error) },
      "model discovery failed",
    );
    return reply.code(400).send({
      error: publicError(error),
      provider: selected.provider,
    });
  }
});

app.get("/api/status", async () => ({
  provider: config.provider,
  models: {
    openai: config.openai.model,
    geminiChat: config.gemini.chatModel,
    geminiLive: config.gemini.liveModel,
  },
  piper: config.piper.url,
  routing: config.routing.mode,
  mcpServers: config.mcpServers.length,
}));

app.post("/api/ask", async (request, reply) => {
  const body = z
    .object({
      text: z.string().min(1),
      speak: z.boolean().default(true),
      source: z.enum(["station", "debug", "api"]).default("api"),
    })
    .parse(request.body);
  try {
    return await ask(config, body.text, body.speak, body.source);
  } catch (error) {
    request.log.warn({ reason: publicError(error) }, "ask failed");
    return reply.code(400).send({ error: publicError(error) });
  }
});

function ledCountFromInfo(info: Record<string, unknown> | undefined): number {
  const features = Array.isArray(info?.features) ? info.features : [];
  for (const feature of features) {
    if (typeof feature !== "string") continue;
    const match = /^led\.ring\.(\d+)$/.exec(feature);
    if (match) return Number(match[1]);
  }
  return 6;
}

app.get("/api/debug/plugin", async (request, reply) => {
  try {
    const [info, state] = await Promise.all([
      pluginInfo(config),
      pluginState(config),
    ]);
    return {
      info: info ?? null,
      state: state ?? null,
      ledCount: ledCountFromInfo(info),
    };
  } catch (error) {
    request.log.warn({ reason: publicError(error) }, "plugin status failed");
    return reply.code(400).send({ error: publicError(error) });
  }
});

app.post("/api/debug/led", async (request, reply) => {
  const body = z
    .object({ colors: z.array(z.string().min(1)).min(1).max(64) })
    .parse(request.body);
  try {
    await pluginLed(config, body.colors);
    return { ok: true };
  } catch (error) {
    request.log.warn({ reason: publicError(error) }, "plugin led failed");
    return reply.code(400).send({ error: publicError(error) });
  }
});

app.post("/api/debug/led/off", async (request, reply) => {
  try {
    await pluginLedOff(config);
    return { ok: true };
  } catch (error) {
    request.log.warn({ reason: publicError(error) }, "plugin led off failed");
    return reply.code(400).send({ error: publicError(error) });
  }
});

app.post("/api/debug/clock", async (request, reply) => {
  const body = z
    .object({
      time: z.string().optional(),
      brightness: z.number().int().min(0).max(255).optional(),
      off: z.boolean().optional(),
    })
    .parse(request.body);
  try {
    await pluginClock(config, body);
    return { ok: true };
  } catch (error) {
    request.log.warn({ reason: publicError(error) }, "plugin clock failed");
    return reply.code(400).send({ error: publicError(error) });
  }
});

app.post("/api/debug/cancel", async (request, reply) => {
  try {
    await pluginCancel(config);
    return { ok: true };
  } catch (error) {
    request.log.warn({ reason: publicError(error) }, "plugin cancel failed");
    return reply.code(400).send({ error: publicError(error) });
  }
});

app.get("/api/debug/log", async () => ({ events: recentAsks() }));

app.post("/api/pair", async (request, reply) => {
  const body = z
    .object({ pluginUrl: z.string().url(), code: z.string().min(1) })
    .parse(request.body);
  try {
    const paired = await pairPlugin(body.pluginUrl, body.code);
    config.plugin.url = body.pluginUrl.trim().replace(/\/+$/, "");
    config.plugin.token = paired.token;
    config.plugin.fingerprint = paired.fingerprint;
    await saveConfig(dataDir, config);
    return {
      ok: true,
      device_id: paired.deviceId,
      fingerprint: paired.fingerprint,
    };
  } catch (error) {
    request.log.warn({ reason: publicError(error) }, "pairing failed");
    return reply.code(400).send({ error: publicError(error) });
  }
});

await app.listen({ host: "0.0.0.0", port: 8097 });
app.log.info({ dataDir }, "hasar add-on listening on :8097");
