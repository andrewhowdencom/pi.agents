import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "./agent-discovery.js";
import { discoverAgents, clearAgentCache } from "./agent-discovery.js";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { executeSubagent, type SubagentProgressEvent } from "./subagent-tools.js";
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
  const MAX_DELEGATE_DEPTH = 3;
  const delegateStorage = new AsyncLocalStorage<{ depth: number }>();

  // --- Workflow engine and state ---
  const engine = new WorkflowEngine();
  let originalToolSet: string[] | null = null;

  function getDelegateDepth(): number {
    const store = delegateStorage.getStore();
    return store?.depth ?? 0;
  }

  function withDelegateDepth<T>(fn: () => Promise<T>): Promise<T> {
    const currentDepth = getDelegateDepth();
    return delegateStorage.run({ depth: currentDepth + 1 }, fn);
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
    pi.appendEntry("agent-state", { name });
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
    default: false,
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

    if (latestAgentState?.name) {
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

    await discoverAgents(pi, ctx.cwd);
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
          } else if (step.delegates && step.delegates.length > 0) {
            // Auto-generated coordinator prompt
            const availableSignals = Object.keys(step.transitions).join(", ");

            systemPrompt += `\n\n# Workflow Decision Point\n\nYou are at a workflow decision point for step "${step.id}". `;
            systemPrompt += `The following specialized reviewers are available as delegates: ${step.delegates.join(", ")}. `;
            systemPrompt += `Call delegate_agent(agent: '<name>', goal: '<scoped goal>') for each, wait for their output, synthesize all findings, `;
            systemPrompt += `and then call workflow_signal(signal: '<signal>') to choose the next step. `;
            systemPrompt += `Available signals: ${availableSignals}.`;
          } else {
            // Simple conditional without delegates
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

      // Only conditional steps get workflow_signal
      const currentStep = engine.getCurrentStep();
      if (currentStep && isConditionalStep(currentStep)) {
        targetTools.add("workflow_signal");
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
        if (targetName === "none" || targetName === "clear") {
          if (activeAgentName === undefined) {
            ctx.ui.notify("Already using default system prompt", "info");
            return;
          }
          setActiveAgent(ctx, undefined);
          ctx.ui.notify("Agent cleared — using default system prompt", "info");
          return;
        }
        selectedAgent = agents.find((a) => a.name === targetName);
        if (!selectedAgent) {
          ctx.ui.notify(`Agent "${args.trim()}" not found`, "error");
          return;
        }
      } else {
        const choice = await ctx.ui.select(
          "Select agent:",
          ["Default (no agent)", ...agents.map((a) => a.name)],
        );
        if (!choice) {
          return;
        }
        if (choice === "Default (no agent)") {
          if (activeAgentName === undefined) {
            ctx.ui.notify("Already using default system prompt", "info");
            return;
          }
          setActiveAgent(ctx, undefined);
          ctx.ui.notify("Agent cleared — using default system prompt", "info");
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

    const prompt = initialPrompt || (firstStep as any).prompt || "Begin the workflow.";
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

        if (!targetAgent.role.includes("leader")) {
          return {
            content: [
              {
                type: "text",
                text: `Agent "${params.agent}" is not configured as a leader. Add 'leader' to its role (e.g., role: [leader]) to enable switching.`,
              },
            ],
            details: {},
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

  // --- Discovery and delegate tools ---

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List all available agents with their capabilities.",
    promptSnippet: "List available agents",
    promptGuidelines: [
      "Use list_agents before calling switch_agent or delegate_agent to discover which agents are available and their capabilities.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const agents = await discoverAgents(pi, ctx.cwd);
      const text = agents
        .map((a) => `- **${a.name}**: ${a.description || "No description"} (role: ${a.role.join(", ")})`)
        .join("\n");
      return {
        content: [{ type: "text", text: text || "No agents found." }],
        details: { agents: agents.map((a) => ({ name: a.name, description: a.description, role: a.role, path: a.path })) },
      };
    },
  });

  pi.registerTool({
    name: "list_delegates",
    label: "List Delegates",
    description: "List all agents that can be invoked as delegates.",
    promptSnippet: "List available delegate agents",
    promptGuidelines: [
      "Use list_delegates to discover which agents can be invoked as delegates via delegate_agent.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const agents = await discoverAgents(pi, ctx.cwd);
      const delegates = agents.filter((a) => a.role.includes("delegate"));
      const text = delegates
        .map((a) => `- **${a.name}**${a.model ? ` (${a.model})` : ""}: ${a.description || "No description"}`)
        .join("\n");
      return {
        content: [{ type: "text", text: text || "No delegate agents found." }],
        details: {
          delegates: delegates.map((a) => ({
            name: a.name,
            description: a.description,
            toolName: a.toolName,
            model: a.model,
            timeout: a.timeout,
            maxTurns: a.maxTurns,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "delegate_agent",
    label: "Delegate to Agent",
    description: "Invoke a delegate agent to perform a scoped task and return its output.",
    promptSnippet: "Invoke a delegate agent with a scoped goal",
    promptGuidelines: [
      "Use delegate_agent when you need a specialized agent to perform a specific, scoped task and return its output. The caller agent will resume after the delegate completes.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "Name of the delegate agent to invoke",
      }),
      goal: Type.String({
        description: "The scoped goal or task for the delegate agent",
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agents = await discoverAgents(pi, ctx.cwd);
      const agent = agents.find((a) => a.name === params.agent);

      if (!agent) {
        const availableDelegates = agents
          .filter((a) => a.role.includes("delegate"))
          .map((a) => a.name)
          .join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Agent "${params.agent}" not found. Available delegates: ${availableDelegates || "none"}.`,
            },
          ],
          details: { availableDelegates: availableDelegates.split(", ").filter(Boolean) },
          isError: true,
        };
      }

      if (!agent.role.includes("delegate")) {
        return {
          content: [
            {
              type: "text",
              text: `Agent '${params.agent}' is not configured as a delegate. Add 'delegate' to its role (e.g., role: [delegate] or role: [leader, delegate]) to enable delegation.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Self-invocation guardrail
      if (activeAgentName === agent.name) {
        return {
          content: [
            {
              type: "text",
              text: `Cannot delegate to ${agent.name} because it is the currently active agent.`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Depth limit guardrail
      const depth = getDelegateDepth();
      if (depth >= MAX_DELEGATE_DEPTH) {
        return {
          content: [
            {
              type: "text",
              text: `Delegate depth limit (${MAX_DELEGATE_DEPTH}) exceeded. Cannot nest deeper than ${MAX_DELEGATE_DEPTH} levels.`,
            },
          ],
          details: { currentDepth: depth },
          isError: true,
        };
      }

      // Workflow step approval guardrail
      if (engine.isAnyWorkflowActive()) {
        const currentStep = engine.getCurrentStep();
        if (
          currentStep &&
          (isLinearStep(currentStep) || isConditionalStep(currentStep)) &&
          currentStep.delegates
        ) {
          if (!currentStep.delegates.includes(params.agent)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Delegate ${params.agent} is not approved for the current workflow step. Approved delegates: ${currentStep.delegates.join(", ")}.`,
                },
              ],
              details: { approvedDelegates: currentStep.delegates },
              isError: true,
            };
          }
        }
      }

      const maxTurns = agent.maxTurns;

      if (ctx.hasUI) {
        ctx.ui.setWorkingMessage(`Delegating to ${agent.name}...`);
      }

      const onDelegateUpdate = (partial: {
        content: Array<{ type: "text"; text: string }>;
        details: unknown;
        terminate?: boolean;
      }) => {
        onUpdate?.(partial);
      };

      function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
        if (toolName === "bash" && typeof args.command === "string") {
          const cmd = args.command;
          return cmd.length > 30 ? `${cmd.slice(0, 30)}...` : cmd;
        }
        if (typeof args.path === "string") {
          return args.path;
        }
        if (typeof args.pattern === "string") {
          return args.pattern;
        }
        return "";
      }

      const state = {
        turnCount: 0,
        currentTool: null as { toolName: string; argsText: string } | null,
        lastDeltaTime: 0,
        deltaPulse: 0,
        startTime: Date.now(),
        dirty: false,
      };

      let renderTimer: NodeJS.Timeout | null = null;

      const render = () => {
        if (!ctx.hasUI) return;
        const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
        const hasRecentDelta = Date.now() - state.lastDeltaTime < 2000;

        let label: string;
        if (state.currentTool) {
          const argsText = state.currentTool.argsText;
          label = argsText
            ? `${state.currentTool.toolName}(${argsText})`
            : state.currentTool.toolName;
        } else if (hasRecentDelta) {
          const dots = ".".repeat((state.deltaPulse % 3) + 1);
          label = `reasoning${dots}`;
        } else {
          label = "waiting...";
        }

        const totalText = maxTurns !== undefined ? `/${maxTurns}` : "";
        ctx.ui.setWorkingMessage(
          `${agent.name}: turn ${state.turnCount}${totalText} • ${label} • ${elapsed}s`,
        );
      };

      const scheduleRender = () => {
        if (state.dirty) return;
        state.dirty = true;
        if (!renderTimer) {
          renderTimer = setTimeout(() => {
            renderTimer = null;
            if (state.dirty) {
              state.dirty = false;
              render();
            }
          }, 200);
        }
      };

      const onProgress = (event: SubagentProgressEvent) => {
        switch (event.type) {
          case "turn_start":
            state.turnCount = event.turnCount;
            state.currentTool = null;
            break;
          case "delta":
            state.lastDeltaTime = Date.now();
            state.deltaPulse++;
            state.currentTool = null;
            break;
          case "tool_start":
            state.currentTool = {
              toolName: event.toolName,
              argsText: formatToolArgs(event.toolName, event.args),
            };
            break;
          case "tool_end":
            state.currentTool = null;
            break;
          case "turn_end":
            state.turnCount = event.turnCount;
            state.currentTool = null;
            break;
          case "error":
            state.currentTool = null;
            break;
        }
        scheduleRender();
      };

      const result = await withDelegateDepth(() =>
        executeSubagent(
          agent,
          { goal: params.goal },
          signal,
          onDelegateUpdate,
          onProgress,
        ),
      );

      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }

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
          delegateDepth: depth + 1,
          usage: result.usage,
        },
      };
    },
  });
}
