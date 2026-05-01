import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./agent-discovery.js";
import { discoverAgents, clearAgentCache } from "./agent-discovery.js";
import { summarizeBranchForAgentSwitch } from "./summarize.js";

export default function (pi: ExtensionAPI) {
  let activeAgentName: string | undefined;

  function updateAgentStatus(ctx: ExtensionContext, name: string | undefined) {
    if (ctx.hasUI) {
      if (name) {
        ctx.ui.setStatus("agent", `Agent: ${name}`);
      } else {
        ctx.ui.setStatus("agent", undefined);
      }
    }
  }

  function setActiveAgent(ctx: ExtensionContext, name: string | undefined) {
    activeAgentName = name;
    updateAgentStatus(ctx, name);
    if (name) {
      pi.appendEntry("agent-state", { name });
    }
  }

  async function performAgentSwitch(
    targetAgent: AgentDefinition,
    ctx: ExtensionCommandContext,
  ) {
    try {
      const sourceAgent = activeAgentName
        ? (await discoverAgents(pi, ctx.cwd)).find((a) => a.name === activeAgentName)
        : undefined;

      const branch = ctx.sessionManager.getBranch();
      const summary = await summarizeBranchForAgentSwitch(
        branch,
        sourceAgent,
        targetAgent,
        ctx,
      );

      const currentSessionFile = ctx.sessionManager.getSessionFile();
      const targetAgentName = targetAgent.name;

      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
        setup: async (sm) => {
          sm.appendMessage({
            role: "user",
            content: [{ type: "text", text: summary }],
            timestamp: Date.now(),
          });
          sm.appendMessage({
            role: "custom",
            customType: "agent-state",
            content: [{ type: "text", text: targetAgentName }],
            display: false,
            details: { name: targetAgentName },
            timestamp: Date.now(),
          });
        },
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify(
            `Handoff to ${targetAgentName} complete`,
            "info",
          );
        },
      });

      if (newSessionResult.cancelled) {
        if (ctx.hasUI) {
          ctx.ui.notify("Agent switch cancelled", "info");
        }
      }
    } catch (err) {
      console.error("[pi-agents] Handoff failed:", err);
      if (ctx.hasUI) {
        ctx.ui.notify("Agent switch failed. Session unchanged.", "error");
      }
    }
  }

  // --- Task 3: Active Agent State Persistence ---
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    let latestAgentState: { name: string } | undefined;

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "agent-state") {
        latestAgentState = entry.data as { name: string };
      } else if (
        entry.type === "message" &&
        entry.message?.role === "custom" &&
        entry.message.customType === "agent-state"
      ) {
        latestAgentState = entry.message.details as { name: string };
      }
    }

    if (latestAgentState) {
      activeAgentName = latestAgentState.name;
      updateAgentStatus(ctx, latestAgentState.name);
    } else {
      activeAgentName = undefined;
      updateAgentStatus(ctx, undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    clearAgentCache();
  });

  // --- Task 4: /agent Command and Visual Mode Switching ---
  pi.registerCommand("agent", {
    description: "Select or switch agent",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        console.log("[pi-agents] /agent requires interactive mode");
        return;
      }

      const agents = await discoverAgents(pi, ctx.cwd);

      if (agents.length === 0) {
        ctx.ui.notify(
          "No agents found. Create .pi/prompts/agent-<name>.md files.",
          "warning",
        );
        return;
      }

      let selectedAgent: AgentDefinition | undefined;

      if (args.trim()) {
        // Direct agent selection by name
        let targetName = args.trim();
        // Allow shorthand without the "agent-" prefix
        if (!targetName.startsWith("agent-")) {
          targetName = "agent-" + targetName;
        }
        selectedAgent = agents.find((a) => a.name === targetName);
        if (!selectedAgent) {
          ctx.ui.notify(`Agent "${args.trim()}" not found`, "error");
          return;
        }
      } else {
        // Show selector picker
        const choice = await ctx.ui.select(
          "Select agent:",
          agents.map((a) => ({
            value: a.name,
            label: a.name,
            description: a.description,
          })),
        );
        if (!choice) {
          return; // User cancelled
        }
        selectedAgent = agents.find((a) => a.name === choice);
      }

      if (!selectedAgent) {
        return;
      }

      // Check if we're switching agents or just selecting one
      if (activeAgentName === selectedAgent.name) {
        ctx.ui.notify(`Already using agent ${selectedAgent.name}`, "info");
        return;
      }

      if (activeAgentName) {
        // --- Task 5: Role-Aware Summarization and New Session Handoff ---
        await performAgentSwitch(selectedAgent, ctx);
      } else {
        // No prior agent active - just set the active agent
        setActiveAgent(ctx, selectedAgent.name);
        ctx.ui.notify(`Agent set to ${selectedAgent.name}`, "info");
      }
    },
  });
}
