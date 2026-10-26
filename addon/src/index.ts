import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { z } from "zod";

import {
  ConfigSchema,
  loadConfig,
  redactedConfig,
  saveConfig,
  type Config,
} from "./config.js";
import { listModels } from "./models.js";
import { pairPlugin } from "./pairing.js";
import { ask } from "./pipeline.js";

const MASK = "••••••••";
const dataDir = process.env.HASAR_DATA_DIR ?? "/data";
const logLevel = process.env.LOG_LEVEL ?? "info";

const app = Fastify({ logger: { level: logLevel } });
let config: Config = await loadConfig(dataDir);

async function loadUi(): Promise<string> {
  for (const candidate of ["../ui/index.html", "./ui/index.html", "../src/ui/index.html"]) {
    try {
      return await readFile(new URL(candidate, import.meta.url), "utf8");
    } catch {
      // Try the next layout (dist/ui in Docker, src/ui with tsx).
    }
  }
  throw new Error("ui/index.html not found");
}

const ui = await loadUi();

function mergeSecrets(current: Config, next: Config): Config {
  if (next.openai.apiKey === MASK) next.openai.apiKey = current.openai.apiKey;
  if (next.gemini.apiKey === MASK) next.gemini.apiKey = current.gemini.apiKey;
  if (next.plugin.token === MASK) next.plugin.token = current.plugin.token;
  next.mcpServers = next.mcpServers.map((server) => {
    const previous = current.mcpServers.find((item) => item.name === server.name);
    if (!previous) return server;
    const headers = { ...server.headers };
    for (const [key, value] of Object.entries(headers)) {
      if (value === MASK && previous.headers[key] !== undefined) {
        headers[key] = previous.headers[key] as string;
      }
    }
    return { ...server, headers };
  });
  return next;
}

app.get("/health", async () => ({ status: "ok", version: "0.1.0" }));

app.get("/", async (_request, reply) => {
  return reply.type("text/html; charset=utf-8").send(ui);
});

app.get("/api/config", async () => redactedConfig(config));

app.put("/api/config", async (request, reply) => {
  try {
    const parsed = ConfigSchema.parse(request.body);
    config = mergeSecrets(config, parsed);
    await saveConfig(dataDir, config);
    return redactedConfig(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid config", issues: error.issues });
    }
    return reply.code(500).send({ error: String(error) });
  }
});

app.post("/api/models", async (request, reply) => {
  const body = z
    .object({ provider: z.enum(["openai", "gemini"]).optional() })
    .parse(request.body ?? {});
  const selected = { ...config, provider: body.provider ?? config.provider };
  try {
    return await listModels(selected);
  } catch (error) {
    return reply.code(400).send({ error: String(error) });
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
    .object({ text: z.string().min(1), speak: z.boolean().default(true) })
    .parse(request.body);
  try {
    return await ask(config, body.text, body.speak);
  } catch (error) {
    return reply.code(400).send({ error: String(error) });
  }
});

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
    return reply.code(400).send({ error: String(error) });
  }
});

await app.listen({ host: "0.0.0.0", port: 8097 });
app.log.info({ dataDir }, "hasar add-on listening on :8097");
