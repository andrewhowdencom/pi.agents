/**
 * Workflow graph type definitions for declarative multi-agent execution pipelines.
 *
 * Workflows are defined as YAML files in .pi/workflows/*.yml, *.yaml, and
 * ~/.pi/agent/workflows/*.yml, *.yaml. The engine executes them as a state machine
 * with support for linear auto-transitions, conditional tool-call-driven
 * transitions, pause steps, and subagent composition.
 */

/** A linear step auto-advances to the next step when the agent finishes. */
export interface LinearStep {
  id: string;
  agent: string;
  type: "linear";
  prompt?: string;
}

/** A conditional step requires the agent to call workflow_signal to choose the next step. */
export interface ConditionalStep {
  id: string;
  agent: string;
  type: "conditional";
  prompt?: string;
  /** List of subagent names the coordinator should invoke during this step. */
  subagents?: string[];
  transitions: Record<string, { target: string; message?: string }>;
  loop_max?: number;
  loop_message?: string;
}

/** A pause step unconditionally stops the workflow, awaiting user /workflow resume. */
export interface PauseStep {
  id: string;
  type: "pause";
  prompt?: string;
}

export type WorkflowStep = LinearStep | ConditionalStep | PauseStep;

export interface WorkflowDefinition {
  name: string;
  description?: string;
  version?: string;
  steps: WorkflowStep[];
}

/** Runtime state persisted in session entries. */
export interface WorkflowState {
  workflowName: string;
  currentStepId: string;
  stepHistory: string[];
  loopCounts: Record<string, number>;
  status: "running" | "paused" | "completed" | "aborted";
  pendingTransition?: { signal: string; feedback?: string };
  retryCount?: number;
  /** Set to true by resume() so the next advance() skips past a pause step. */
  resumedFromPause?: boolean;
  /** ID of the chain if this is an ad-hoc /chain workflow */
  chainId?: string;
}

/** Discovered workflow with metadata. */
export interface DiscoveredWorkflow {
  name: string;
  path: string;
  definition: WorkflowDefinition;
}

/** Reserved subcommand keywords — workflow files using these names are skipped. */
export const WORKFLOW_RESERVED_KEYWORDS = new Set([
  "pause",
  "resume",
  "abort",
  "status",
  "list",
]);

/** Guardrail: a workflow step cannot use a reserved keyword as its ID. */
export function isReservedWorkflowName(name: string): boolean {
  return WORKFLOW_RESERVED_KEYWORDS.has(name.toLowerCase());
}

/** Get a step by ID from a workflow definition. */
export function getStepById(
  workflow: WorkflowDefinition,
  stepId: string,
): WorkflowStep | undefined {
  return workflow.steps.find((s) => s.id === stepId);
}

/** Check if a step is conditional. */
export function isConditionalStep(step: WorkflowStep): step is ConditionalStep {
  return step.type === "conditional";
}

/** Check if a step is linear. */
export function isLinearStep(step: WorkflowStep): step is LinearStep {
  return step.type === "linear";
}

/** Check if a step is a pause step. */
export function isPauseStep(step: WorkflowStep): step is PauseStep {
  return step.type === "pause";
}

/** Find the index of a step by ID. */
export function getStepIndex(workflow: WorkflowDefinition, stepId: string): number {
  return workflow.steps.findIndex((s) => s.id === stepId);
}

/** Compute the next linear step after the given step ID. Returns null if at end. */
export function getNextLinearStep(
  workflow: WorkflowDefinition,
  currentStepId: string,
): string | null {
  const idx = getStepIndex(workflow, currentStepId);
  if (idx === -1 || idx >= workflow.steps.length - 1) {
    return null;
  }
  return workflow.steps[idx + 1].id;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a workflow graph for structural correctness.
 *
 * Checks:
 * - All transition targets reference existing step IDs
 * - No steps are unreachable from the start
 * - Self-loops on conditional steps have loop_max > 0
 * - All cycles have at least one conditional step with loop_max protection
 */
export function validateWorkflowGraph(
  definition: WorkflowDefinition,
): WorkflowValidationResult {
  const errors: string[] = [];
  const stepIds = new Set(definition.steps.map((s) => s.id));
  const stepMap = new Map(definition.steps.map((s) => [s.id, s] as const));

  // 1. Check all transition targets exist
  for (const step of definition.steps) {
    if (isConditionalStep(step)) {
      for (const [signal, tx] of Object.entries(step.transitions)) {
        if (!stepIds.has(tx.target)) {
          errors.push(
            `Step "${step.id}" transition "${signal}" targets unknown step "${tx.target}"`,
          );
        }
      }

      // Self-loop guard
      for (const [signal, tx] of Object.entries(step.transitions)) {
        if (tx.target === step.id && (!step.loop_max || step.loop_max <= 0)) {
          errors.push(
            `Step "${step.id}" self-transition "${signal}" requires loop_max > 0`,
          );
        }
      }
    }
  }

  // 2. Check for unreachable steps (orphaned from start)
  const reachable = new Set<string>();
  const queue: string[] = [definition.steps[0]?.id].filter(Boolean);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const step = stepMap.get(current);
    if (!step) continue;

    if (isLinearStep(step) || isPauseStep(step)) {
      const nextId = getNextLinearStep(definition, current);
      if (nextId) queue.push(nextId);
    } else if (isConditionalStep(step)) {
      for (const tx of Object.values(step.transitions)) {
        queue.push(tx.target);
      }
    }
  }

  for (const step of definition.steps) {
    if (!reachable.has(step.id)) {
      errors.push(`Step "${step.id}" is unreachable from the workflow start`);
    }
  }

  // 3. Detect cycles without loop protection
  // Build adjacency list
  const adj = new Map<string, string[]>();
  for (const step of definition.steps) {
    if (isConditionalStep(step)) {
      adj.set(
        step.id,
        Object.values(step.transitions).map((tx) => tx.target),
      );
    } else if (isLinearStep(step) || isPauseStep(step)) {
      const nextId = getNextLinearStep(definition, step.id);
      if (nextId) {
        adj.set(step.id, [nextId]);
      }
    }
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of stepIds) {
    color.set(id, WHITE);
  }

  const allCycles: string[][] = [];

  function dfs(node: string, path: string[]) {
    color.set(node, GRAY);
    path.push(node);

    const neighbors = adj.get(node) || [];
    for (const neighbor of neighbors) {
      if (color.get(neighbor) === GRAY) {
        const cycleStart = path.indexOf(neighbor);
        allCycles.push(path.slice(cycleStart));
      } else if (color.get(neighbor) === WHITE) {
        dfs(neighbor, path);
      }
    }

    path.pop();
    color.set(node, BLACK);
  }

  for (const id of stepIds) {
    if (color.get(id) === WHITE) {
      dfs(id, []);
    }
  }

  for (const cycle of allCycles) {
    const hasLoopProtection = cycle.some((id) => {
      const step = stepMap.get(id);
      return (
        step &&
        isConditionalStep(step) &&
        step.loop_max !== undefined &&
        step.loop_max > 0
      );
    });

    if (!hasLoopProtection) {
      errors.push(
        `Cycle detected (${cycle.join(" → ")}) with no loop protection. At least one conditional step in the cycle must have loop_max.`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
