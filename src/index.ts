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
import {
  type WorkflowStep,
  type ConditionalStep,
  isConditionalStep,
  isLinearStep,
  isPauseStep,
  WORKFLOW_RESERVED_KEYWORDS,
  validateWorkflowGraph,
} from "./workflow-types.js";
import { discoverWorkflows, clearWorkflowCache } from "./workflow-discovery.js";
import { WorkflowEngine } from "./workflow-engine.js";

export default function (pi: ExtensionAPI) {
  let activeAgentName: string | undefined;
  const registeredSubagentTools = new Set<string>();
  const MAX_SUBAGENT_DEPTH = 3;
  const subagentStorage = new AsyncLocalStorage<{ depth: number }>();

  // --- Workflow engine and state ---
  const engine = new WorkflowEngine();
  let originalToolSet: string[] | null = null;

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

  function updateWorkflowStatus(ctx: ExtensionContext) {
    if (ctx.hasUI) {
      const text = engine.getStatusText();
      if (text) {
        ctx.ui.setStatus("workflow", `Workflow: ${text}`);
      } else {
        ctx.ui.setStatus("workflow", undefined);
      }
    }
  }

  function restoreOriginalTools() {
    if (originalToolSet) {
      pi.setActiveTools(originalToolSet);
    }
    originalToolSet = null;
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

          const maxTurns = agent.maxTurns;

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
              const totalText = total !== undefined ? `/${total}` : "";
              const cost = details?.usage?.cost?.total ?? 0;
              const costText = cost > 0 ? `, ~$${cost.toFixed(4)}` : "";
              ctx.ui.setWorkingMessage(
                `${agent.name}: turn ${turn}${totalText}${costText}`,
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

  // --- CLI flags ---
  pi.registerFlag("agent-switch-confirm", {
    description: "Confirm before agent-initiated agent switches",
    type: "boolean",
    default: true,
  });

  pi.registerFlag("workflow-confirm", {
    description: "Confirm before starting a workflow",
    type: "boolean",
    default: true,
  });

  // --- Event handlers ---

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

    // Restore workflow state
    const workflowRestored = engine.restore(entries);
    if (workflowRestored) {
      const state = engine.getState();
      if (state) {
        const workflows = await discoverWorkflows(pi, ctx.cwd);
        const def = workflows.find((w) => w.name === state.workflowName);
        if (def) {
          engine.attachDefinition(def.definition);
          if (state.status === "paused") {
            ctx.ui?.notify(
              `Workflow '${state.workflowName}' is paused at ${state.currentStepId}. Use /workflow resume to continue.`,
              "info",
            );
          }
          updateWorkflowStatus(ctx);
        } else {
          // Definition no longer available — reset
          engine.reset();
        }
      }
    }

    const agents = await discoverAgents(pi, ctx.cwd);
    registerSubagentTools(agents);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    let systemPrompt = _event.systemPrompt;

    if (activeAgentName) {
      const agents = await discoverAgents(pi, ctx.cwd);
      const agent = agents.find((a) => a.name === activeAgentName);
      if (agent) {
        systemPrompt +=
          "\n\n# Agent Instructions\n\n" + agent.content;
      }
    }

    // Workflow step prompt injection and tool activation
    if (engine.isAnyWorkflowActive()) {
      const step = engine.getCurrentStep();
      if (step) {
        if (isLinearStep(step) && step.prompt) {
          systemPrompt += `\n\n# Workflow Step: ${step.id}\n\n${step.prompt}`;
        } else if (isConditionalStep(step)) {
          if (step.prompt) {
            // User override
            systemPrompt += `\n\n# Workflow Step: ${step.id}\n\n${step.prompt}`;
          } else if (step.subagents && step.subagents.length > 0) {
            // Auto-generated coordinator prompt
            const agents = await discoverAgents(pi, ctx.cwd);
            const toolNames = step.subagents
              .map((name) => {
                const a = agents.find((agent) => agent.name === name);
                return a?.toolName || `invoke_${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
              })
              .filter(Boolean);

            const availableSignals = Object.keys(step.transitions).join(", ");

            systemPrompt += `\n\n# Workflow Decision Point\n\nYou are at a workflow decision point for step "${step.id}". `;
            systemPrompt += `The following specialized reviewers are available as subagent tools: ${toolNames.join(", ")}. `;
            systemPrompt += `Call each with a scoped goal based on the implementation, wait for their output, synthesize all findings, `;
            systemPrompt += `and then call workflow_signal(signal: '<signal>') to choose the next step. `;
            systemPrompt += `Available signals: ${availableSignals}.`;
          } else {
            // Simple conditional without subagents
            const availableSignals = Object.keys(step.transitions).join(", ");
            systemPrompt += `\n\n# Workflow Decision Point\n\nYou are at a workflow decision point for step "${step.id}". `;
            systemPrompt += `Call workflow_signal(signal: '<signal>') to choose the next step. `;
            systemPrompt += `Available signals: ${availableSignals}.`;
          }
        } else if (isPauseStep(step) && step.prompt) {
          systemPrompt += `\n\n# Workflow Pause\n\n${step.prompt}`;
        }
      }

      // Dynamic tool activation
      const allTools = pi.getActiveTools();
      if (!originalToolSet) {
        originalToolSet = [...allTools].filter((t) => t !== "workflow_signal");
      }

      const targetTools = new Set(originalToolSet);
      const currentStep = engine.getCurrentStep();

      if (currentStep && isConditionalStep(currentStep)) {
        targetTools.add("workflow_signal");

        if (currentStep.subagents) {
          const agents = await discoverAgents(pi, ctx.cwd);
          for (const subName of currentStep.subagents) {
            const subAgent = agents.find((a) => a.name === subName);
            if (subAgent?.toolName) {
              targetTools.add(subAgent.toolName);
            }
          }
        }
      }

      pi.setActiveTools([...targetTools]);
    } else {
      // Not in a workflow — ensure workflow-specific tools are hidden
      const activeTools = pi.getActiveTools();
      const filtered = activeTools.filter((t) => t !== "workflow_signal");
      if (filtered.length !== activeTools.length) {
        pi.setActiveTools(filtered);
      }
      originalToolSet = null;
    }

    return { systemPrompt };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!engine.isActive()) return;

    const result = engine.advance();
    if (!result) return;

    switch (result.type) {
      case "complete": {
        engine.persist(pi);
        const name = engine.getState()?.workflowName;
        updateWorkflowStatus(ctx);
        ctx.ui?.notify(
          `Workflow '${name}' completed successfully`,
          "info",
        );
        engine.reset();
        restoreOriginalTools();
        break;
      }

      case "next": {
        engine.persist(pi);
        if (result.step && !isPauseStep(result.step)) {
          setActiveAgent(ctx, (result.step as any).agent);
        }
        updateWorkflowStatus(ctx);

        const nextStep = engine.getCurrentStep();
        const prompt =
          nextStep && (nextStep as any).prompt
            ? (nextStep as any).prompt
            : `Continue to workflow step: ${result.stepId}`;
        pi.sendUserMessage(prompt, { deliverAs: "steer" });
        break;
      }

      case "retry": {
        engine.persist(pi);
        updateWorkflowStatus(ctx);
        ctx.ui?.notify(
          `Agent did not signal a transition. Retrying with reminder...`,
          "warning",
        );
        pi.sendUserMessage(
          "Please call workflow_signal to proceed with the workflow.",
          { deliverAs: "steer" },
        );
        break;
      }

      case "needs-intervention": {
        engine.persist(pi);
        updateWorkflowStatus(ctx);

        if (result.availableTransitions.length > 0) {
          if (ctx.hasUI) {
            const choice = await ctx.ui.select(
              "Workflow paused — select next step:",
              result.availableTransitions,
            );

            if (choice) {
              engine.forceTransition(choice);
              const nextResult = engine.advance();
              if (nextResult && nextResult.type === "next") {
                engine.persist(pi);
                if (nextResult.step && !isPauseStep(nextResult.step)) {
                  setActiveAgent(ctx, (nextResult.step as any).agent);
                }
                updateWorkflowStatus(ctx);
                const nextPrompt =
                  nextResult.step && (nextResult.step as any).prompt
                    ? (nextResult.step as any).prompt
                    : `Continue to workflow step: ${nextResult.stepId}`;
                pi.sendUserMessage(nextPrompt, { deliverAs: "steer" });
              }
            } else {
              ctx.ui?.notify(
                "Workflow intervention cancelled. Use /workflow resume to continue.",
                "info",
              );
            }
          } else {
            // Non-interactive mode: abort with error instead of pausing
            engine.abort();
            engine.persist(pi);
            console.error(
              "[pi-agents] Workflow aborted: agent did not signal a transition and no UI available for intervention.",
            );
            engine.reset();
            restoreOriginalTools();
          }
        } else {
          ctx.ui?.notify(
            "Workflow paused. Use /workflow resume to continue.",
            "info",
          );
        }
        break;
      }

      case "error": {
        engine.persist(pi);
        ctx.ui?.notify(`Workflow error: ${result.message}`, "error");
        engine.reset();
        restoreOriginalTools();
        break;
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "switch_agent" && engine.isAnyWorkflowActive()) {
      ctx.ui?.notify(
        "Agent attempted manual switch during workflow. Use workflow_signal for conditional steps, or abort with /workflow abort.",
        "warning",
      );
      return {
        block: true,
        reason: "Manual agent switches are disabled during workflow execution.",
      };
    }
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    if (engine.isAnyWorkflowActive()) {
      const name = engine.getState()?.workflowName;
      if (ctx.hasUI) {
        const ok = await ctx.ui.confirm(
          "Session Switch",
          `Switching sessions will abort the running workflow '${name}'. Continue?`,
        );
        if (!ok) {
          return { cancel: true };
        }
      }
      engine.abort();
      engine.persist(pi);
      updateWorkflowStatus(ctx);
      engine.reset();
      restoreOriginalTools();
    }
  });

  pi.on("session_shutdown", async () => {
    clearAgentCache();
    registeredSubagentTools.clear();

    if (engine.isAnyWorkflowActive()) {
      engine.persist(pi);
    }
    clearWorkflowCache();
  });

  // --- Commands ---

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
        const targetName = args.trim();
        selectedAgent = agents.find((a) => a.name === targetName);
        if (!selectedAgent) {
          ctx.ui.notify(`Agent "${args.trim()}" not found`, "error");
          return;
        }
      } else {
        const choice = await ctx.ui.select(
          "Select agent:",
          agents.map((a) => a.name),
        );
        if (!choice) {
          return;
        }
        selectedAgent = agents.find((a) => a.name === choice);
      }

      if (!selectedAgent) {
        return;
      }

      if (activeAgentName === selectedAgent.name) {
        ctx.ui.notify(`Already using agent ${selectedAgent.name}`, "info");
        return;
      }

      setActiveAgent(ctx, selectedAgent.name);
      ctx.ui.notify(`Agent set to ${selectedAgent.name}`, "info");
    },
  });

  async function showWorkflowPicker(ctx: ExtensionContext) {
    const workflows = await discoverWorkflows(pi, ctx.cwd);
    if (workflows.length === 0) {
      ctx.ui?.notify(
        "No workflows found. Create .pi/workflows/<name>.yml files.",
        "warning",
      );
      return null;
    }

    const choice = await ctx.ui.select(
      "Select workflow:",
      workflows.map((w) => w.name),
    );
    return choice;
  }

  pi.registerCommand("workflow", {
    description: "Manage workflows: start, pause, resume, abort, check status, or list",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const parts = trimmed.split(/\s+/);
      const firstArg = parts[0].toLowerCase();

      // No args
      if (!trimmed) {
        if (engine.isAnyWorkflowActive()) {
          ctx.ui?.notify(engine.getDetailedStatus(), "info");
        } else {
          const choice = await showWorkflowPicker(ctx);
          if (choice) {
            // Start the selected workflow
            await startWorkflowByName(choice, "", ctx);
          }
        }
        return;
      }

      // Subcommands
      if (WORKFLOW_RESERVED_KEYWORDS.has(firstArg)) {
        switch (firstArg) {
          case "pause": {
            if (!engine.isActive()) {
              ctx.ui?.notify("No workflow is currently running.", "warning");
              return;
            }
            engine.pause();
            engine.persist(pi);
            updateWorkflowStatus(ctx);
            ctx.ui?.notify(
              `Workflow paused at ${engine.getState()?.currentStepId}. Use /workflow resume to continue.`,
              "info",
            );
            return;
          }

          case "resume": {
            if (!engine.isPaused()) {
              ctx.ui?.notify("No workflow is currently paused.", "warning");
              return;
            }
            engine.resume();
            engine.persist(pi);
            updateWorkflowStatus(ctx);
            ctx.ui?.notify("Workflow resumed.", "info");

            const step = engine.getCurrentStep();
            const prompt =
              step && (step as any).prompt
                ? (step as any).prompt
                : "Continue workflow.";
            pi.sendUserMessage(prompt, { deliverAs: "steer" });
            return;
          }

          case "abort": {
            if (!engine.isAnyWorkflowActive()) {
              ctx.ui?.notify("No workflow is currently active.", "warning");
              return;
            }
            if (ctx.hasUI) {
              const ok = await ctx.ui.confirm(
                "Abort Workflow",
                `Abort workflow '${engine.getState()?.workflowName}'?`,
              );
              if (!ok) return;
            }
            engine.abort();
            engine.persist(pi);
            updateWorkflowStatus(ctx);
            ctx.ui?.notify(
              `Workflow '${engine.getState()?.workflowName}' aborted.`,
              "info",
            );
            engine.reset();
            restoreOriginalTools();
            return;
          }

          case "status": {
            ctx.ui?.notify(
              engine.isAnyWorkflowActive()
                ? engine.getDetailedStatus()
                : "No workflow is currently running.",
              "info",
            );
            return;
          }

          case "list": {
            const choice = await showWorkflowPicker(ctx);
            if (choice) {
              await startWorkflowByName(choice, "", ctx);
            }
            return;
          }
        }
      }

      // Start workflow by name
      const workflowName = parts[0];
      const initialPrompt = parts.slice(1).join(" ").trim();
      await startWorkflowByName(workflowName, initialPrompt, ctx);
    },
  });

  async function startWorkflowByName(workflowName: string, initialPrompt: string, ctx: ExtensionContext) {
    const workflows = await discoverWorkflows(pi, ctx.cwd);
    const workflow = workflows.find((w) => w.name === workflowName);

    if (!workflow) {
      ctx.ui?.notify(
        `Workflow "${workflowName}" not found. Use /workflow list to see available workflows.`,
        "error",
      );
      return;
    }

    if (engine.isAnyWorkflowActive()) {
      ctx.ui?.notify(
        "A workflow is already active. Abort it with /workflow abort before starting a new one.",
        "warning",
      );
      return;
    }

    const confirmWorkflows = pi.getFlag("workflow-confirm") ?? true;
    if (ctx.hasUI && confirmWorkflows) {
      const firstStep = workflow.definition.steps[0];
      const firstAgent = isPauseStep(firstStep)
        ? "user"
        : (firstStep as any).agent;
      const ok = await ctx.ui.confirm(
        "Start Workflow",
        `Start workflow '${workflowName}'? (Step 1/${workflow.definition.steps.length}: ${firstAgent})`,
      );
      if (!ok) return;
    }

    // Validate workflow graph structure
    const graphValidation = validateWorkflowGraph(workflow.definition);
    if (!graphValidation.valid) {
      ctx.ui?.notify(
        `Workflow graph is invalid:\n${graphValidation.errors.join("\n")}`,
        "error",
      );
      return;
    }

    engine.start(workflow.definition);
    originalToolSet = pi.getActiveTools().filter((t) => t !== "workflow_signal");

    // Validate agents
    const agents = await discoverAgents(pi, ctx.cwd);
    const validNames = new Set(agents.map((a) => a.name));
    const validation = engine.validateAgents(validNames);
    if (!validation.valid) {
      ctx.ui?.notify(
        `Workflow references unknown agents: ${validation.missing.join(", ")}. Aborting.`,
        "error",
      );
      engine.reset();
      restoreOriginalTools();
      return;
    }

    engine.persist(pi);

    const firstStep = workflow.definition.steps[0];
    if (!isPauseStep(firstStep)) {
      setActiveAgent(ctx, (firstStep as any).agent);
    }
    updateWorkflowStatus(ctx);
    ctx.ui?.notify(
      `Workflow '${workflowName}' started. Step 1/${workflow.definition.steps.length}: ${isPauseStep(firstStep) ? "user" : (firstStep as any).agent}`,
      "info",
    );

    let prompt = (firstStep as any).prompt || "Begin the workflow.";
    if (initialPrompt) {
      if (prompt) {
        prompt += "\n\n" + initialPrompt;
      } else {
        prompt = initialPrompt;
      }
    }
    pi.sendUserMessage(prompt, { deliverAs: "steer" });
  }

  pi.registerCommand("chain", {
    description: "Run an ad-hoc linear chain of agents",
    handler: async (args, ctx) => {
      const agentNames = args.trim().split(/\s+/).filter(Boolean);
      if (agentNames.length === 0) {
        ctx.ui?.notify("Usage: /chain <agent1> <agent2> ...", "warning");
        return;
      }

      if (engine.isAnyWorkflowActive()) {
        ctx.ui?.notify(
          "A workflow is already active. Abort it with /workflow abort before starting a chain.",
          "warning",
        );
        return;
      }

      const agents = await discoverAgents(pi, ctx.cwd);
      const validNames = new Set(agents.map((a) => a.name));
      const invalid = agentNames.filter((n) => !validNames.has(n));
      if (invalid.length > 0) {
        ctx.ui?.notify(`Unknown agents: ${invalid.join(", ")}`, "error");
        return;
      }

      const confirmWorkflows = pi.getFlag("workflow-confirm") ?? true;
      if (ctx.hasUI && confirmWorkflows) {
        const ok = await ctx.ui.confirm(
          "Start Chain",
          `Start linear chain: ${agentNames.join(" → ")}?`,
        );
        if (!ok) return;
      }

      engine.startChain(agentNames);
      originalToolSet = pi.getActiveTools().filter((t) => t !== "workflow_signal");
      engine.persist(pi);

      const firstAgent = agentNames[0];
      setActiveAgent(ctx, firstAgent);
      updateWorkflowStatus(ctx);
      ctx.ui?.notify(
        `Starting chain: ${agentNames.join(" → ")}`,
        "info",
      );

      pi.sendUserMessage("Begin the workflow chain.", {
        deliverAs: "steer",
      });
    },
  });

  // --- Tools ---

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

        const agents = await discoverAgents(pi, ctx.cwd);

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

  pi.registerTool({
    name: "workflow_signal",
    label: "Workflow Signal",
    description:
      "Signal the outcome of a workflow decision point to advance to the next step.",
    promptSnippet:
      "Call workflow_signal at a workflow decision point to choose the next step",
    promptGuidelines: [
      "Use workflow_signal when you have completed your review or decision and need to advance the workflow.",
      "The signal name must match one of the available transitions for the current workflow step.",
    ],
    parameters: Type.Object({
      signal: Type.String({
        description:
          "The transition signal name (e.g., 'approved', 'changes_needed')",
      }),
      feedback: Type.Optional(
        Type.String({
          description: "Optional feedback to pass to the next step",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!engine.isAnyWorkflowActive()) {
        return {
          content: [
            {
              type: "text",
              text: "No active workflow step. workflow_signal can only be called during a workflow.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      const step = engine.getCurrentStep();
      if (!step || !isConditionalStep(step)) {
        return {
          content: [
            {
              type: "text",
              text: "Not at a workflow decision point. workflow_signal can only be called at conditional workflow steps.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      const success = engine.recordSignal(params.signal, params.feedback);
      if (!success) {
        const available = Object.keys(step.transitions).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Invalid signal "${params.signal}". Available transitions: ${available}.`,
            },
          ],
          details: { availableTransitions: Object.keys(step.transitions) },
          isError: true,
        };
      }

      const target = step.transitions[params.signal]?.target;
      return {
        content: [
          {
            type: "text",
            text: `Signal "${params.signal}" received. Transitioning to ${target} after this turn completes.`,
          },
        ],
        details: {
          target,
          signal: params.signal,
          feedback: params.feedback,
        },
      };
    },
  });
}
