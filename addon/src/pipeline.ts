import type { Config } from "./config.js";
import { wavFromPcm } from "./audio.js";
import { recordAsk, type AskSource } from "./debug.js";
import { callHaService, textFromAssistResponse } from "./ha.js";
import { chatGemini } from "./llm/gemini.js";
import { geminiLive } from "./llm/gemini-live.js";
import { chatOpenAi } from "./llm/openai.js";
import type { ChatMessage } from "./llm/types.js";
import { openMcp } from "./mcp/client.js";
import { playWav } from "./plugin.js";
import { synthesizePiper } from "./tts/piper.js";

export type AskResult = {
  route: "assist" | "chat" | "gemini-live";
  text: string;
  intent?: string;
  audio: "played" | "skipped" | "failed";
};

type IntentResult = {
  matched?: boolean;
  intent?: string | null;
  slots?: Record<string, unknown>;
};

function hasTrigger(text: string, triggers: string[]): boolean {
  const normalized = text.toLowerCase();
  return triggers.some((trigger) => {
    const value = trigger.trim().toLowerCase();
    return value.length > 0 && normalized.includes(value);
  });
}

async function recognizeIntent(text: string): Promise<IntentResult | null> {
  try {
    return (await callHaService("hasar", "recognize_intent", { text })) as IntentResult;
  } catch {
    return null;
  }
}

async function speak(config: Config, text: string, speakText: boolean): Promise<AskResult["audio"]> {
  if (!speakText) return "skipped";
  try {
    const audio = await synthesizePiper(config.piper.url, text, config.piper.voice);
    if (!config.plugin.url) return "skipped";
    await playWav(config, audio);
    return "played";
  } catch (error) {
    console.warn("TTS/playback failed:", error);
    return "failed";
  }
}

async function runAssist(config: Config, text: string, speakText: boolean): Promise<AskResult | null> {
  try {
    const value = await callHaService("conversation", "process", {
      text,
      agent_id: "conversation.home_assistant",
    });
    const responseText = textFromAssistResponse(value);
    if (!responseText) return null;
    return {
      route: "assist",
      text: responseText,
      audio: await speak(config, responseText, speakText),
    };
  } catch (error) {
    console.warn("Assist failed, falling back to LLM:", error);
    return null;
  }
}

async function runOpenAiChat(
  config: Config,
  text: string,
  speakText: boolean,
): Promise<AskResult> {
  const mcp = await openMcp(config);
  try {
    const messages: ChatMessage[] = [
      { role: "system", content: config.systemPrompt },
      { role: "user", content: text },
    ];
    for (let round = 0; round < 6; round += 1) {
      const result = await chatOpenAi(config, messages, mcp.tools);
      if (!result.toolCalls.length) {
        const answer = result.text.trim() || "Не удалось получить ответ.";
        return {
          route: "chat",
          text: answer,
          audio: await speak(config, answer, speakText),
        };
      }
      messages.push({
        role: "assistant",
        content: result.text || null,
        toolCalls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        try {
          const output = await mcp.call(call.name, call.arguments);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: output,
          });
        } catch (error) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: `error: ${String(error)}`,
          });
        }
      }
    }
    throw new Error("LLM exceeded the tool-call limit");
  } finally {
    await mcp.close();
  }
}

async function runGeminiChat(
  config: Config,
  text: string,
  speakText: boolean,
): Promise<AskResult> {
  const answer = await chatGemini(config, config.systemPrompt, text);
  const finalText = answer.trim() || "Не удалось получить ответ.";
  return {
    route: "chat",
    text: finalText,
    audio: await speak(config, finalText, speakText),
  };
}

async function runGeminiLive(
  config: Config,
  text: string,
  speakText: boolean,
): Promise<AskResult> {
  const mcp = await openMcp(config);
  try {
    const live = await geminiLive(
      config,
      config.systemPrompt,
      text,
      mcp.tools,
      mcp.call,
    );
    if (!live.pcm.length) throw new Error("Gemini Live returned no audio");
    const audio = wavFromPcm(live.pcm, live.sampleRate);
    let playback: AskResult["audio"] = "skipped";
    if (speakText) {
      try {
        if (config.plugin.url) {
          await playWav(config, audio);
          playback = "played";
        }
      } catch (error) {
        console.warn("live playback failed:", error);
        playback = "failed";
      }
    }
    return {
      route: "gemini-live",
      text: live.transcript || "(audio response)",
      audio: playback,
    };
  } finally {
    await mcp.close();
  }
}

export async function ask(
  config: Config,
  text: string,
  speakText: boolean,
  source: AskSource = "api",
): Promise<AskResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("text is empty");

  const started = Date.now();
  const provider = config.provider;
  const model =
    provider === "gemini"
      ? config.gemini.liveEnabled
        ? config.gemini.liveModel
        : config.gemini.chatModel
      : config.openai.model;

  try {
    const result = await askInner(config, trimmed, speakText);
    recordAsk({
      source,
      text: trimmed,
      route: result.route,
      intent: result.intent,
      provider,
      model,
      durationMs: Date.now() - started,
      audio: result.audio,
    });
    return result;
  } catch (error) {
    recordAsk({
      source,
      text: trimmed,
      provider,
      model,
      durationMs: Date.now() - started,
      error: String(error),
    });
    throw error;
  }
}

async function askInner(
  config: Config,
  trimmed: string,
  speakText: boolean,
): Promise<AskResult> {
  const explicitLlm = hasTrigger(trimmed, config.routing.llmTriggers);
  if (config.routing.mode === "llm" || explicitLlm) {
    return runLlm(config, trimmed, speakText);
  }
  if (config.routing.mode === "assist") {
    const assisted = await runAssist(config, trimmed, speakText);
    if (assisted) return assisted;
    return runLlm(config, trimmed, speakText);
  }

  const intent = await recognizeIntent(trimmed);
  if (
    intent?.matched &&
    intent.intent &&
    config.routing.intentAllowlist.includes(intent.intent)
  ) {
    const assisted = await runAssist(config, trimmed, speakText);
    if (assisted) return { ...assisted, intent: intent.intent };
  }
  return runLlm(config, trimmed, speakText);
}

async function runLlm(
  config: Config,
  text: string,
  speakText: boolean,
): Promise<AskResult> {
  if (config.provider === "gemini" && config.gemini.liveEnabled) {
    return runGeminiLive(config, text, speakText);
  }
  if (config.provider === "gemini") {
    return runGeminiChat(config, text, speakText);
  }
  return runOpenAiChat(config, text, speakText);
}
