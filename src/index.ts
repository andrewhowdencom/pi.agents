import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./agent-discovery.js";
import { discoverAgents, clearAgentCache } from "./agent-discovery.js";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { buildSubagentToolSchema, executeSubagent } from "./subagent-tools.js";
import { AsyncLocalStorage } from "node:async_hooks";

export default function (pi: ExtensionAPI) {
  let activeAgentName: string | undefined;
  const registeredSubagentTools = new Set<string>();
  const MAX_SUBAGENT_DEPTH = 3;
  const subagentStorage = new AsyncLocalStorage<{ depth: number }>();

  function getSubagentDepth(): number {
    const store = subagentStorage.getStore();
    return store?.depth ?? 0;
  }

  function withSubagentDepth<T>(fn: () => Promise<T>): Promise<T> {
    const currentDepth = getSubagentDepth();
    return subagentStorage.run({ depth: currentDepth + 1 }, fn);
  }

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

  function registerSubagentTools(agents: AgentDefinition[]) {
    for (const agent of agents) {
      if (!agent.subagent || !agent.toolName) continue;

      if (registeredSubagentTools.has(agent.toolName)) continue;

      if (agent.toolName === "switch_agent") {
        console.warn(
          `[pi-agents] Subagent tool name "${agent.toolName}" collides with switch_agent, skipping`,
        );
        continue;
      }

      registeredSubagentTools.add(agent.toolName);

      const schema = buildSubagentToolSchema(agent);

      pi.registerTool({
        name: agent.toolName,
        label: `Invoke ${agent.name}`,
        description:
          agent.description || `Invoke ${agent.name} as a subagent`,
        promptSnippet: `Invoke the ${agent.name} subagent with a scoped goal`,
        promptGuidelines: [
          `Use ${agent.toolName} when you need the ${agent.name} agent to perform a specific, scoped task and return its output. The caller agent will resume after the subagent completes.`,
        ],
        parameters: schema,
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          // Self-invocation guardrail
          if (activeAgentName === agent.name) {
            return {
              content: [
                {
                  type: "text",
                  text: `Cannot invoke subagent ${agent.name} because it is the currently active agent.`,
                },
              ],
              details: {},
              isError: true,
            };
          }

          // Depth limit guardrail
          const depth = getSubagentDepth();
          if (depth >= MAX_SUBAGENT_DEPTH) {
            return {
              content: [
                {
                  type: "text",
                  text: `Subagent depth limit (${MAX_SUBAGENT_DEPTH}) exceeded. Cannot nest deeper than ${MAX_SUBAGENT_DEPTH} levels.`,
                },
              ],
              details: { currentDepth: depth },
              isError: true,
            };
          }

          const maxTurns = agent.maxTurns ?? 30;

          if (ctx.hasUI) {
            ctx.ui.setWorkingMessage(`Invoking ${agent.name}...`);
          }

          const onSubagentUpdate = (partial: {
            content: Array<{ type: "text"; text: string }>;
            details: unknown;
            terminate?: boolean;
          }) => {
            onUpdate?.(partial);
            if (ctx.hasUI) {
              const details = partial.details as {
                turnCount?: number;
                maxTurns?: number;
                usage?: { cost?: { total?: number } };
              } | undefined;
              const turn = details?.turnCount ?? 0;
              const total = details?.maxTurns ?? maxTurns;
              const cost = details?.usage?.cost?.total ?? 0;
              const costText = cost > 0 ? `, ~$${cost.toFixed(4)}` : "";
              ctx.ui.setWorkingMessage(
                `${agent.name}: turn ${turn}/${total}${costText}`,
              );
            }
          };

          const result = await withSubagentDepth(() =>
            executeSubagent(
              agent,
              params,
              signal,
              onSubagentUpdate,
            ),
          );

          if (ctx.hasUI) {
            ctx.ui.setWorkingMessage();
          }

          return {
            content: [
              {
                type: "text",
                text: result.output,
              },
            ],
            details: {
              turnCount: result.turnCount,
              timedOut: result.timedOut,
              subagentDepth: depth + 1,
              usage: result.usage,
            },
          };
        },
      });
    }
  }

  // --- Task 3: Register CLI flag for agent switch confirmation ---
  pi.registerFlag("agent-switch-confirm", {
    description: "Confirm before agent-initiated agent switches",
    type: "boolean",
    default: true,
  });



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

    const agents = await discoverAgents(pi, ctx.cwd);
    registerSubagentTools(agents);
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
    registeredSubagentTools.clear();
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

  // --- Task 1: switch_agent tool for autonomous agent handoff ---
  pi.registerTool({
    name: "switch_agent",
    label: "Switch Agent",
    description: "Permanently transfer control to a different agent.",
    promptSnippet: "Switch to another agent to continue the workflow",
    promptGuidelines: [
      "Use switch_agent when you have completed your role and another agent should take over.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "Name of the target agent to switch to",
      }),
      style: Type.Optional(
        StringEnum(["lightweight", "summarize"] as const),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        // Validate style
        if (params.style === "summarize") {
          return {
            content: [
              {
                type: "text",
                text: "Summarize style is not yet supported. Use 'lightweight' for same-session switching.",
              },
            ],
            details: {},
            isError: true,
          };
        }

        // Discover available agents
        const agents = await discoverAgents(pi, ctx.cwd);

        // Validate target exists
        const targetAgent = agents.find((a) => a.name === params.agent);
        if (!targetAgent) {
          const availableAgents = agents.map((a) => a.name).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `Agent "${params.agent}" not found. Available agents: ${availableAgents || "none"}.`,
              },
            ],
            details: { availableAgents },
            isError: true,
          };
        }

        // Prevent self-switch
        if (activeAgentName === params.agent) {
          return {
            content: [
              {
                type: "text",
                text: `Already using agent ${params.agent}. Switch to a different agent.`,
              },
            ],
            details: {},
            isError: true,
          };
        }

        // User confirmation (guardrail)
        const confirmSwitches = pi.getFlag("agent-switch-confirm") ?? true;
        if (ctx.hasUI && confirmSwitches) {
          const currentAgentLabel = activeAgentName || "default";
          const ok = await ctx.ui.confirm(
            "Agent Handoff",
            `${currentAgentLabel} wants to switch to ${params.agent}. Allow?`,
          );
          if (!ok) {
            return {
              content: [
                {
                  type: "text",
                  text: "Agent switch denied by user.",
                },
              ],
              details: {},
              isError: true,
            };
          }
        }

        // Perform the switch
        setActiveAgent(ctx, params.agent);

        return {
          content: [
            {
              type: "text",
              text: `Switched to agent ${params.agent}.`,
            },
          ],
          details: {},
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error during agent switch: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
