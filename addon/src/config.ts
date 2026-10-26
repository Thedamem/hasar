import { promises as fs } from "node:fs";
import { chmod, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { openSecret, sealSecret } from "./secrets.js";

export const SECRET_MASK = "••••••••";

export const McpServerSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(["http", "sse", "stdio"]).default("http"),
  url: z.string().default(""),
  command: z.string().default(""),
  args: z.array(z.string()).default([]),
  headers: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
});

export const ConfigSchema = z.object({
  provider: z.enum(["openai", "gemini"]).default("openai"),
  openai: z
    .object({
      baseUrl: z.string().default("https://api.openai.com/v1"),
      apiKey: z.string().default(""),
      model: z.string().default(""),
    })
    .default({ baseUrl: "https://api.openai.com/v1", apiKey: "", model: "" }),
  gemini: z
    .object({
      baseUrl: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
      apiKey: z.string().default(""),
      chatModel: z.string().default(""),
      liveModel: z.string().default("gemini-3.8-live"),
      liveEnabled: z.boolean().default(false),
    })
    .default({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      chatModel: "",
      liveModel: "gemini-3.8-live",
      liveEnabled: false,
    }),
  systemPrompt: z
    .string()
    .default(
      "Ты голосовой помощник. Отвечай кратко, по-русски и без markdown.",
    ),
  piper: z
    .object({
      url: z.string().default("tcp://core-piper:10200"),
      voice: z.string().default(""),
    })
    .default({ url: "tcp://core-piper:10200", voice: "" }),
  routing: z
    .object({
      mode: z.enum(["auto", "assist", "llm"]).default("auto"),
      intentAllowlist: z
        .array(z.string())
        .default([
          "HassTurnOn",
          "HassTurnOff",
          "HassToggle",
          "HassGetState",
          "HassSetPosition",
          "HassStartTimer",
          "HassCancelTimer",
          "HassCancelAllTimers",
          "HassTimerStatus",
          "HassClimateGetTemperature",
        ]),
      llmTriggers: z
        .array(z.string())
        .default(["хасар", "спроси хасар", "поговори с хасар"]),
      sessionTimeoutSeconds: z.number().int().min(10).max(3600).default(120),
    })
    .default({
      mode: "auto",
      intentAllowlist: [
        "HassTurnOn",
        "HassTurnOff",
        "HassToggle",
        "HassGetState",
        "HassSetPosition",
        "HassStartTimer",
        "HassCancelTimer",
        "HassCancelAllTimers",
        "HassTimerStatus",
        "HassClimateGetTemperature",
      ],
      llmTriggers: ["хасар", "спроси хасар", "поговори с хасар"],
      sessionTimeoutSeconds: 120,
    }),
  proxy: z
    .object({
      socks5: z.string().default(""),
    })
    .default({ socks5: "" }),
  mcpServers: z.array(McpServerSchema).default([]),
  plugin: z
    .object({
      url: z.string().default(""),
      token: z.string().default(""),
      fingerprint: z.string().default(""),
    })
    .default({ url: "", token: "", fingerprint: "" }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type McpServer = z.infer<typeof McpServerSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export function configPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

export async function loadConfig(dataDir: string): Promise<Config> {
  await mkdir(dataDir, { recursive: true });
  let parsed: Config;
  try {
    const raw = await fs.readFile(configPath(dataDir), "utf8");
    parsed = ConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return structuredClone(DEFAULT_CONFIG);
  }
  return openConfigSecrets(dataDir, parsed);
}

export async function saveConfig(dataDir: string, config: Config): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = configPath(dataDir);
  const temporary = `${target}.tmp`;
  const sealed = await sealConfigSecrets(dataDir, config);
  const body = `${JSON.stringify(sealed, null, 2)}\n`;
  await fs.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

type SecretField = {
  name: string;
  read: () => string;
  write: (value: string) => void;
};

function secretFields(config: Config): SecretField[] {
  const fields: SecretField[] = [
    {
      name: "openai.apiKey",
      read: () => config.openai.apiKey,
      write: (value) => {
        config.openai.apiKey = value;
      },
    },
    {
      name: "gemini.apiKey",
      read: () => config.gemini.apiKey,
      write: (value) => {
        config.gemini.apiKey = value;
      },
    },
    {
      name: "plugin.token",
      read: () => config.plugin.token,
      write: (value) => {
        config.plugin.token = value;
      },
    },
    {
      name: "proxy.socks5",
      read: () => config.proxy.socks5,
      write: (value) => {
        config.proxy.socks5 = value;
      },
    },
  ];
  config.mcpServers.forEach((server, index) => {
    for (const key of Object.keys(server.headers)) {
      fields.push({
        name: `mcpServers[${index}].headers.${key}`,
        read: () => server.headers[key] ?? "",
        write: (value) => {
          server.headers[key] = value;
        },
      });
    }
  });
  return fields;
}

async function openConfigSecrets(dataDir: string, config: Config): Promise<Config> {
  const next = structuredClone(config);
  for (const field of secretFields(next)) {
    try {
      field.write(await openSecret(dataDir, field.read()));
    } catch (error) {
      console.warn(
        `cannot decrypt ${field.name}; the stored value will be ignored:`,
        (error as Error).message,
      );
      field.write("");
    }
  }
  return next;
}

async function sealConfigSecrets(dataDir: string, config: Config): Promise<Config> {
  const next = structuredClone(config);
  for (const field of secretFields(next)) {
    field.write(await sealSecret(dataDir, field.read()));
  }
  return next;
}

export function redactedConfig(config: Config): Config {
  return {
    ...config,
    openai: {
      ...config.openai,
      apiKey: config.openai.apiKey ? SECRET_MASK : "",
    },
    gemini: {
      ...config.gemini,
      apiKey: config.gemini.apiKey ? SECRET_MASK : "",
    },
    plugin: {
      ...config.plugin,
      token: config.plugin.token ? SECRET_MASK : "",
    },
    mcpServers: config.mcpServers.map((server) => ({
      ...server,
      headers: Object.fromEntries(
        Object.entries(server.headers).map(([key, value]) => [
          key,
          value ? SECRET_MASK : "",
        ]),
      ),
    })),
  };
}
