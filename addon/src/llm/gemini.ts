import type { Config } from "../config.js";
import { requestJson } from "../http.js";

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown } }>;
    };
  }>;
};

export async function chatGemini(
  config: Config,
  systemPrompt: string,
  text: string,
): Promise<string> {
  if (!config.gemini.apiKey) throw new Error("Gemini API key is empty");
  if (!config.gemini.chatModel) throw new Error("Gemini chat model is empty");
  const model = config.gemini.chatModel.replace(/^models\//, "");
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  );
  url.searchParams.set("key", config.gemini.apiKey);

  const payload = (await requestJson(url.toString(), {
    method: "POST",
    proxy: config.proxy.socks5,
    timeoutMs: 120_000,
    body: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text }] }],
    },
  })) as GeminiResponse;

  const parts = payload.candidates?.[0]?.content?.parts ?? [];
  const textParts = parts
    .map((part) => part.text)
    .filter((value): value is string => typeof value === "string");
  if (parts.some((part) => part.functionCall)) {
    throw new Error("Gemini tool calls are not supported in chat mode");
  }
  return textParts.join("");
}
