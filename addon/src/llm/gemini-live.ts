import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket from "ws";

import type { Config } from "../config.js";
import { geminiHeaders, geminiLiveUrl } from "../gemini.js";
import type { ToolDefinition } from "./types.js";

export type LiveAudio = {
  pcm: Buffer;
  sampleRate: number;
  transcript: string;
};

type LivePart = {
  text?: string;
  inlineData?: { data?: string; mimeType?: string };
};

type LiveMessage = {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: LivePart[] };
    outputTranscription?: { text?: string };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
  toolCall?: {
    functionCalls?: Array<{
      name?: string;
      id?: string;
      args?: Record<string, unknown>;
    }>;
  };
};

export function geminiLive(
  config: Config,
  systemPrompt: string,
  text: string,
  tools: ToolDefinition[] = [],
  callTool?: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<LiveAudio> {
  if (!config.gemini.apiKey) return Promise.reject(new Error("Gemini API key is empty"));
  if (!config.gemini.liveModel) return Promise.reject(new Error("Gemini live model is empty"));

  const model = config.gemini.liveModel.replace(/^models\//, "");
  const url = geminiLiveUrl(config);
  const agent = config.proxy.socks5 ? new SocksProxyAgent(config.proxy.socks5) : undefined;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let sampleRate = 24_000;
    let transcript = "";
    let settled = false;
    const socket = new WebSocket(url.toString(), {
      agent,
      headers: geminiHeaders(config.gemini.apiKey),
    });
    const timer = setTimeout(() => {
      finish(new Error("Gemini Live request timed out"));
    }, 45_000);

    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      if (error) {
        reject(error);
        return;
      }
      resolve({ pcm: Buffer.concat(chunks), sampleRate, transcript });
    }

    socket.on("open", () => {
      const setup: Record<string, unknown> = {
        model: `models/${model}`,
        responseModalities: ["AUDIO"],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        outputAudioTranscription: {},
      };
      if (tools.length) {
        setup.tools = [
          {
            functionDeclarations: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            })),
          },
        ];
      }
      socket.send(JSON.stringify({ setup }));
    });

    async function handleToolCall(call: NonNullable<LiveMessage["toolCall"]>) {
      if (!callTool) {
        finish(new Error("Gemini Live requested a tool but MCP is unavailable"));
        return;
      }
      const responses = [];
      for (const item of call.functionCalls ?? []) {
        if (!item.name) continue;
        try {
          const result = await callTool(item.name, item.args ?? {});
          responses.push({
            name: item.name,
            id: item.id,
            response: { result },
          });
        } catch (error) {
          responses.push({
            name: item.name,
            id: item.id,
            response: { error: String(error) },
          });
        }
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
      }
    }

    socket.on("message", (raw) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(raw.toString()) as LiveMessage;
      } catch {
        return;
      }
      if (message.setupComplete !== undefined) {
        socket.send(JSON.stringify({ realtimeInput: { text } }));
        return;
      }
      if (message.toolCall) {
        void handleToolCall(message.toolCall);
        return;
      }
      const content = message.serverContent;
      if (!content) return;
      if (content.outputTranscription?.text) {
        transcript = content.outputTranscription.text;
      }
      for (const part of content.modelTurn?.parts ?? []) {
        if (!part.inlineData?.data) continue;
        const mime = part.inlineData.mimeType ?? "";
        const match = /rate=(\d+)/.exec(mime);
        if (match) sampleRate = Number(match[1]);
        chunks.push(Buffer.from(part.inlineData.data, "base64"));
      }
      if (content.turnComplete || content.interrupted) {
        finish();
      }
    });

    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish();
    });
  });
}
