import { complete, type Message } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  convertToLlm,
  serializeConversation,
} from "@mariozechner/pi-coding-agent";
import type { SessionEntry, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./agent-discovery.js";

/** Maximum characters for agent role descriptions in the summarization prompt. */
const AGENT_CONTENT_MAX_CHARS = 2048;

/** Maximum number of recent messages to include in naive fallback summary. */
const NAIVE_FALLBACK_MESSAGE_COUNT = 10;

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the roles of both the current (source) and new (target) agents, generate a focused summary that extracts only the salient points relevant to the target agent's responsibilities.

The summary should include:
- Goals and decisions made during the conversation
- Files that were discussed or modified
- Current blockers or open questions
- Next steps that the target agent should take

Be concise but include all necessary context. Do not include any preamble like "Here's the summary" - just output the summary itself.`;

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[... content truncated]";
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === "message") {
    return entry.message;
  }
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
}

function getMessagesFromBranch(branch: SessionEntry[]): AgentMessage[] {
  let compactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      compactionIndex = i;
      break;
    }
  }

  if (compactionIndex < 0) {
    return branch
      .map(entryToMessage)
      .filter((message): message is AgentMessage => message !== undefined);
  }

  const compaction = branch[compactionIndex];
  const firstKeptIndex =
    compaction.type === "compaction"
      ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId)
      : -1;

  const compactedBranch = [
    compaction,
    ...(firstKeptIndex >= 0
      ? branch.slice(firstKeptIndex, compactionIndex)
      : []),
    ...branch.slice(compactionIndex + 1),
  ];

  return compactedBranch
    .map(entryToMessage)
    .filter((message): message is AgentMessage => message !== undefined);
}

function buildNaiveSummary(branch: SessionEntry[]): string {
  const messages = getMessagesFromBranch(branch);
  const recentMessages = messages.slice(-NAIVE_FALLBACK_MESSAGE_COUNT);
  const llmMessages = convertToLlm(recentMessages);
  return serializeConversation(llmMessages);
}

export async function summarizeBranchForAgentSwitch(
  branch: SessionEntry[],
  sourceAgent: AgentDefinition | undefined,
  targetAgent: AgentDefinition,
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<string> {
  const messages = getMessagesFromBranch(branch);
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);

  if (!ctx.model) {
    if (ctx.hasUI) {
      ctx.ui.notify("No model selected; using naive summary", "warning");
    }
    return buildNaiveSummary(branch);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey) {
    const errorMsg = auth.ok
      ? `No API key for ${ctx.model.provider}`
      : auth.error;
    if (ctx.hasUI) {
      ctx.ui.notify(
        `Summarization unavailable (${errorMsg}); using naive summary`,
        "warning",
      );
    }
    return buildNaiveSummary(branch);
  }

  const userMessage: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          "## Conversation History\n\n",
          conversationText,
          "\n\n## Source Agent Role\n\n",
          truncateText(
            sourceAgent?.content ?? "No source agent defined.",
            AGENT_CONTENT_MAX_CHARS,
          ),
          "\n\n## Target Agent Role\n\n",
          truncateText(targetAgent.content, AGENT_CONTENT_MAX_CHARS),
          "\n\n## Task\n\nExtract only the salient points from the conversation history that are relevant to the target agent's responsibilities. Focus on goals, decisions, files, blockers, and next steps.",
        ].join(""),
      },
    ],
    timestamp: Date.now(),
  };

  try {
    if (signal?.aborted) {
      throw new Error("Summarization cancelled");
    }

    const response = await complete(
      ctx.model,
      { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );

    if (response.stopReason === "aborted" || signal?.aborted) {
      throw new Error("Summarization cancelled");
    }

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return summary || buildNaiveSummary(branch);
  } catch (err) {
    if (err instanceof Error && err.message === "Summarization cancelled") {
      throw err;
    }
    console.error("[pi-agents] Summarization failed:", err);
    if (ctx.hasUI) {
      ctx.ui.notify("Summarization failed; using naive summary", "warning");
    }
    return buildNaiveSummary(branch);
  }
}
