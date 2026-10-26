import type { Config } from "./config.js";
import { requestJson } from "./http.js";

export type ModelInfo = {
  id: string;
  name: string;
  methods: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
};

export type ModelList = {
  chat: ModelInfo[];
  live: ModelInfo[];
};

const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

type GeminiModel = {
  name?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
};

type OpenAiModel = {
  id?: string;
  name?: string;
};

export async function listOpenAiModels(config: Config): Promise<ModelList> {
  const base = config.openai.baseUrl.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("OpenAI base URL is empty");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.openai.apiKey) {
    headers.authorization = `Bearer ${config.openai.apiKey}`;
  }
  const payload = (await requestJson(`${base}/models`, {
    headers,
    proxy: config.proxy.socks5,
    timeoutMs: 15_000,
  })) as { data?: OpenAiModel[] };
  const models = (payload.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({
      id: model.id as string,
      name: model.name ?? (model.id as string),
      methods: [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { chat: models, live: [] };
}

export async function listGeminiModels(config: Config): Promise<ModelList> {
  if (!config.gemini.apiKey) {
    throw new Error("Gemini API key is empty");
  }
  const url = new URL(`${GEMINI_API}/models`);
  url.searchParams.set("key", config.gemini.apiKey);
  url.searchParams.set("pageSize", "1000");
  const payload = (await requestJson(url.toString(), {
    proxy: config.proxy.socks5,
    headers: { accept: "application/json" },
    timeoutMs: 15_000,
  })) as { models?: GeminiModel[] };
  const models = (payload.models ?? [])
    .filter((model) => typeof model.name === "string" && model.name.length > 0)
    .map((model) => {
      const id = (model.name as string).replace(/^models\//, "");
      const methods = model.supportedGenerationMethods ?? [];
      return {
        id,
        name: model.displayName ?? id,
        methods,
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
      } satisfies ModelInfo;
    });
  const chat = models
    .filter((model) => model.methods.includes("generateContent"))
    .sort((left, right) => left.id.localeCompare(right.id));
  const live = models
    .filter((model) => model.methods.includes("bidiGenerateContent"))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { chat, live };
}

export async function listModels(config: Config): Promise<ModelList> {
  if (config.provider === "gemini") {
    return listGeminiModels(config);
  }
  return listOpenAiModels(config);
}
