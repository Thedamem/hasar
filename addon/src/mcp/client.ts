import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { Config, McpServer } from "../config.js";
import type { ToolDefinition } from "../llm/types.js";

type ConnectedServer = {
  client: Client;
  tools: Map<string, string>;
};

export type McpSession = {
  tools: ToolDefinition[];
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
};

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
}

function safeReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, "sk-[redacted]")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza[redacted]");
}

async function connectServer(server: McpServer): Promise<Client> {
  const client = new Client({ name: "hasar-addon", version: "0.1.0" });
  const headers = server.headers;
  if (server.transport === "stdio") {
    if (!server.command) throw new Error(`${server.name}: stdio command is empty`);
    await client.connect(
      new StdioClientTransport({ command: server.command, args: server.args }),
    );
    return client;
  }
  if (!server.url) throw new Error(`${server.name}: URL is empty`);
  const url = new URL(server.url);
  if (server.transport === "sse") {
    await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
    return client;
  }
  try {
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    );
  } catch {
    await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
  }
  return client;
}

export async function openMcp(config: Config): Promise<McpSession> {
  const connected: ConnectedServer[] = [];
  const tools: ToolDefinition[] = [];
  const toolOwners = new Map<string, { server: ConnectedServer; original: string }>();

  for (const server of config.mcpServers.filter((item) => item.enabled)) {
    try {
      const client = await connectServer(server);
      const connectedServer: ConnectedServer = { client, tools: new Map() };
      connected.push(connectedServer);
      const { tools: serverTools } = await client.listTools();
      for (const tool of serverTools) {
        const publicName = `${safeName(server.name)}__${safeName(tool.name)}`;
        connectedServer.tools.set(publicName, tool.name);
        toolOwners.set(publicName, { server: connectedServer, original: tool.name });
        tools.push({
          name: publicName,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        });
      }
    } catch (error) {
      // A broken MCP server must not take down the whole assistant.
      console.warn(`MCP ${server.name} unavailable: ${safeReason(error)}`);
    }
  }

  return {
    tools,
    call: async (name, args) => {
      const owner = toolOwners.get(name);
      if (!owner) throw new Error(`unknown MCP tool: ${name}`);
      const result = await owner.server.client.callTool({
        name: owner.original,
        arguments: args,
      });
      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = blocks
        .map((block) => {
          if (block.type === "text") return block.text;
          return JSON.stringify(block);
        })
        .join("\n");
      if (result.isError) throw new Error(text || "MCP tool failed");
      return text;
    },
    close: async () => {
      await Promise.allSettled(connected.map((item) => item.client.close()));
    },
  };
}
