import { Type, type TSchema } from "typebox";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, ToolParameter } from "./agent-discovery.js";
import { PiRpcClient, type AccumulatedUsage } from "./rpc-client.js";

const DEFAULT_SUBAGENT_TIMEOUT = 60000;

/**
 * Builds a TypeBox schema for a subagent tool from an AgentDefinition.
 *
 * Every subagent tool receives a mandatory `goal` parameter. Additional
 * parameters declared in the agent's `toolSchema` frontmatter are merged in.
 */
export function buildSubagentToolSchema(
  agent: AgentDefinition,
): TSchema {
  const properties: Record<string, TSchema> = {
    goal: Type.String({
      description: `The scoped goal or task for the ${agent.name} subagent`,
    }),
  };

  if (agent.toolSchema) {
    for (const param of agent.toolSchema) {
      let schema: TSchema;
      switch (param.type) {
        case "number":
          schema = Type.Number({ description: param.description });
          break;
        case "boolean":
          schema = Type.Boolean({ description: param.description });
          break;
        case "string":
        default:
          schema = Type.String({ description: param.description });
          break;
      }

      if (!param.required) {
        schema = Type.Optional(schema);
      }

      properties[param.name] = schema;
    }
  }

  return Type.Object(properties);
}

type SubagentUpdateCallback = (partial: {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  terminate?: boolean;
}) => void;

export type SubagentProgressEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; turnCount: number }
  | { type: "delta"; kind: "thinking" | "text" }
  | { type: "tool_start"; toolName: string; args: Record<string, unknown> }
  | { type: "tool_end"; toolName?: string }
  | { type: "turn_end"; turnCount: number }
  | { type: "agent_end" }
  | { type: "error"; message: string };

/**
 * Execute a subagent via a separate Pi RPC process.
 *
 * Spawns `pi --mode rpc` with the agent's content as system prompt,
 * sends the composed goal, and extracts the final assistant response
 * from the `agent_end` event.
 */
export async function executeSubagent(
  agent: AgentDefinition,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate?: SubagentUpdateCallback,
  onProgress?: (event: SubagentProgressEvent) => void,
): Promise<{ output: string; turnCount: number; timedOut: boolean; usage?: AccumulatedUsage }> {
  const effectiveTimeout = agent.timeout ?? DEFAULT_SUBAGENT_TIMEOUT;
  const maxTurns = agent.maxTurns;
  // Compose the prompt from goal + toolSchema params
  const goal = String(params.goal ?? "");
  let prompt = goal;

  if (agent.toolSchema) {
    for (const param of agent.toolSchema) {
      if (param.name !== "goal" && params[param.name] !== undefined) {
        prompt += `\n\n${param.name}: ${String(params[param.name])}`;
      }
    }
  }

  // Write agent content (frontmatter stripped) to a temp file for --system-prompt
  const tempPath = join(
    tmpdir(),
    `pi-subagent-${Date.now()}-${agent.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.md`,
  );
  await writeFile(tempPath, agent.content, "utf-8");

  const args = [
    "--mode",
    "rpc",
    "--system-prompt",
    tempPath,
    "--no-session",
  ];
  if (agent.model) {
    args.push("--model", agent.model);
  }
  const client = new PiRpcClient(args);

  let timedOut = false;
  let output = "";
  let turnCount = 0;

  let unsubscribe: (() => void) | undefined;
  let unsubscribeProgress: (() => void) | undefined;

  try {
    await client.start();
    await client.sendPrompt(prompt);

    if (onUpdate) {
      unsubscribe = client.onEvent((event) => {
        if (event.type !== "turn_end") return;

        const message = event.message;
        if (
          !message ||
          typeof message !== "object" ||
          (message as Record<string, unknown>).role !== "assistant"
        ) {
          return;
        }

        let turnOutput = "";
        const content = (message as Record<string, unknown>).content;
        if (typeof content === "string") {
          turnOutput = content;
        } else if (Array.isArray(content)) {
          turnOutput = content
            .filter(
              (c): c is { type: string; text?: string } =>
                typeof c === "object" && c !== null && "type" in c,
            )
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
        }

        if (!turnOutput) return;

        const turnCount = client.getTurnCount();
        const usage = client.getAccumulatedUsage();

        onUpdate({
          content: [
            {
              type: "text",
              text: maxTurns !== undefined
                ? `**Turn ${turnCount}/${maxTurns}**\n\n${turnOutput}`
                : `**Turn ${turnCount}**\n\n${turnOutput}`,
            },
          ],
          details: {
            turnCount,
            maxTurns,
            subagentName: agent.name,
            usage,
          },
        });
      });
    }

    if (onProgress) {
      unsubscribeProgress = client.onEvent((event) => {
        const eventType = event.type as string | undefined;
        if (!eventType) return;

        switch (eventType) {
          case "agent_start":
            onProgress({ type: "agent_start" });
            break;
          case "turn_start":
            onProgress({ type: "turn_start", turnCount: client.getTurnCount() + 1 });
            break;
          case "message_update": {
            const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
            if (ame?.type === "thinking_delta") {
              onProgress({ type: "delta", kind: "thinking" });
            } else if (ame?.type === "text_delta") {
              onProgress({ type: "delta", kind: "text" });
            }
            break;
          }
          case "tool_execution_start": {
            const toolName = event.toolName as string | undefined;
            const args = event.args as Record<string, unknown> | undefined;
            if (toolName) {
              onProgress({ type: "tool_start", toolName, args: args ?? {} });
            }
            break;
          }
          case "tool_execution_end": {
            const toolName = event.toolName as string | undefined;
            onProgress({ type: "tool_end", toolName });
            break;
          }
          case "turn_end":
            onProgress({ type: "turn_end", turnCount: client.getTurnCount() + 1 });
            break;
          case "agent_end":
            onProgress({ type: "agent_end" });
            break;
          case "error": {
            const message = event.message as string | undefined;
            onProgress({
              type: "error",
              message: message ?? "Unknown RPC error",
            });
            break;
          }
        }
      });
    }

    const result = await client.waitForCompletion({
      signal,
      timeoutMs: effectiveTimeout,
      maxTurns,
    });

    turnCount = client.getTurnCount();

    // Extract the last assistant message's text content
    const assistantMessages = result.messages.filter(
      (m) => m.role === "assistant",
    );
    const lastAssistant = assistantMessages[assistantMessages.length - 1];

    if (lastAssistant) {
      if (typeof lastAssistant.content === "string") {
        output = lastAssistant.content;
      } else if (Array.isArray(lastAssistant.content)) {
        output = lastAssistant.content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
      }
    } else {
      output = "[Subagent completed with no assistant response]";
    }
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes("timed out")) {
        timedOut = true;
        output = `Subagent ${agent.name} timed out after ${effectiveTimeout}ms of inactivity.`;
      } else if (err.message.includes("cancelled")) {
        output = `Subagent ${agent.name} was cancelled.`;
      } else if (err.message.includes("exceeded maximum")) {
        output = err.message;
      } else if (
        err.message.includes("exited with code") ||
        err.message.includes("killed by signal")
      ) {
        output = `Subagent ${agent.name} process ended unexpectedly: ${err.message}`;
      } else {
        output = `Subagent ${agent.name} failed: ${err.message}`;
      }
    } else {
      output = `Subagent ${agent.name} failed: ${String(err)}`;
    }
  } finally {
    unsubscribe?.();
    unsubscribeProgress?.();
    client.kill();
    await unlink(tempPath).catch(() => {});
  }

  return { output, turnCount, timedOut, usage: client.getAccumulatedUsage() };
}
