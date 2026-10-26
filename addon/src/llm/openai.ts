import type { Config } from "../config.js";
import { requestJson } from "../http.js";
import { openAiBaseUrl } from "../openai-base.js";
import type { ChatMessage, ChatResult, ToolCall, ToolDefinition } from "./types.js";

type OpenAiMessage = Record<string, unknown>;

type OpenAiResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
};

function encodeMessage(message: ChatMessage): OpenAiMessage {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      };
    case "tool":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
  }
}

export async function chatOpenAi(
  config: Config,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ChatResult> {
  const base = openAiBaseUrl(config);
  if (!base) throw new Error("OpenAI base URL is empty");
  if (!config.openai.model) throw new Error("OpenAI model is empty");

  const headers: Record<string, string> = {};
  if (config.openai.apiKey) {
    headers.authorization = `Bearer ${config.openai.apiKey}`;
  }
  const body: Record<string, unknown> = {
    model: config.openai.model,
    messages: messages.map(encodeMessage),
  };
  if (tools.length) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    body.tool_choice = "auto";
  }

  const payload = (await requestJson(`${base}/chat/completions`, {
    method: "POST",
    headers,
    body,
    proxy: config.proxy.socks5,
    timeoutMs: 120_000,
  })) as OpenAiResponse;

  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("OpenAI returned no message");

  const toolCalls: ToolCall[] = (message.tool_calls ?? [])
    .filter((call) => call.function?.name)
    .map((call, index) => {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function?.arguments ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
      return {
        id: call.id ?? `call_${index}`,
        name: call.function?.name as string,
        arguments: args,
      };
    });

  return { text: message.content ?? "", toolCalls };
}
