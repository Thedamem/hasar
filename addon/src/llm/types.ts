export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: ToolCall[];
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ChatResult = {
  text: string;
  toolCalls: ToolCall[];
};
