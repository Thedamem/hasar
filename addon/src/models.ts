import type { Config } from "./config.js";
import { geminiApiUrl, geminiHeaders } from "./gemini.js";
import { requestJson } from "./http.js";
import { openAiBaseUrl } from "./openai-base.js";

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
  object?: string;
};

type OpenAiItem = OpenAiModel | string;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueModels(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const model of models) {
    const previous = byId.get(model.id);
    if (!previous || previous.name === previous.id) byId.set(model.id, model);
  }
  return [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id, undefined, { numeric: true }),
  );
}

function openAiItems(payload: unknown): OpenAiItem[] {
  if (Array.isArray(payload)) return payload as OpenAiItem[];
  if (!payload || typeof payload !== "object") {
    throw new Error("unexpected response: expected an object with data[]");
  }
  const object = payload as { data?: unknown; models?: unknown };
  const items = Array.isArray(object.data)
    ? object.data
    : Array.isArray(object.models)
      ? object.models
      : null;
  if (!items) {
    throw new Error("unexpected response: expected data[] or models[]");
  }
  return items as OpenAiItem[];
}

export async function listOpenAiModels(config: Config): Promise<ModelList> {
  const base = openAiBaseUrl(config);
  if (!base) {
    throw new Error("OpenAI base URL is empty");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (config.openai.apiKey) {
    headers.authorization = `Bearer ${config.openai.apiKey}`;
  }

  let payload: unknown;
  try {
    payload = await requestJson(`${base}/models`, {
      headers,
      proxy: config.proxy.socks5,
      timeoutMs: 15_000,
    });
  } catch (error) {
    throw new Error(`OpenAI /models request failed: ${errorText(error)}`);
  }

  const models = openAiItems(payload)
    .map((item): ModelInfo | null => {
      const id = typeof item === "string" ? item : item?.id ?? item?.name;
      return typeof id === "string" && id.length > 0
        ? { id, name: id, methods: [] as string[] }
        : null;
    })
    .filter((model): model is ModelInfo => model !== null);

  return { chat: uniqueModels(models), live: [] };
}

export async function listGeminiModels(config: Config): Promise<ModelList> {
  if (!config.gemini.apiKey) {
    throw new Error("Gemini API key is empty");
  }

  const url = new URL(geminiApiUrl(config, "models"));
  url.searchParams.set("pageSize", "1000");

  let payload: unknown;
  try {
    payload = await requestJson(url.toString(), {
      proxy: config.proxy.socks5,
      headers: {
        accept: "application/json",
        ...geminiHeaders(config.gemini.apiKey),
      },
      timeoutMs: 15_000,
    });
  } catch (error) {
    throw new Error(`Gemini /models request failed: ${errorText(error)}`);
  }

  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) {
    throw new Error("unexpected response: expected models[]");
  }

  const models = ((payload as { models: GeminiModel[] }).models)
    .filter((model) => typeof model.name === "string" && model.name.length > 0)
    .map((model) => {
      const id = (model.name as string).replace(/^models\//, "");
      return {
        id,
        name: model.displayName ?? id,
        methods: Array.isArray(model.supportedGenerationMethods)
          ? model.supportedGenerationMethods
          : [],
        inputTokenLimit: model.inputTokenLimit,
        outputTokenLimit: model.outputTokenLimit,
      } satisfies ModelInfo;
    });

  const hasMethods = models.some((model) => model.methods.length > 0);
  const chat = hasMethods
    ? uniqueModels(models.filter((model) => model.methods.includes("generateContent")))
    : uniqueModels(models.filter((model) => !/embed/i.test(model.id)));
  const live = hasMethods
    ? uniqueModels(
        models.filter((model) => model.methods.includes("bidiGenerateContent")),
      )
    : [];
  return { chat, live };
}

export async function listModels(config: Config): Promise<ModelList> {
  if (config.provider === "gemini") {
    return listGeminiModels(config);
  }
  return listOpenAiModels(config);
}
