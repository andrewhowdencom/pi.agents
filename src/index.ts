import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./agent-discovery.js";
import { discoverAgents, clearAgentCache } from "./agent-discovery.js";

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

  // --- Task 6: Inject Active Agent System Instructions ---
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!activeAgentName) return;

    const agents = await discoverAgents(pi, ctx.cwd);
    const agent = agents.find((a) => a.name === activeAgentName);
    if (!agent) return;

    return {
      systemPrompt: _event.systemPrompt + "\n\n# Agent Instructions\n\n" + agent.content,
    };
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
          "No agents found. Create .pi/agents/<name>.md files.",
          "warning",
        );
        return;
      }

      let selectedAgent: AgentDefinition | undefined;

      if (args.trim()) {
        // Direct agent selection by name
        const targetName = args.trim();
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

      setActiveAgent(ctx, selectedAgent.name);
      ctx.ui.notify(`Agent set to ${selectedAgent.name}`, "info");
    },
  });
}
