import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  type WorkflowDefinition,
  type WorkflowState,
  type WorkflowStep,
  type ConditionalStep,
  isConditionalStep,
  isLinearStep,
  isPauseStep,
  getStepById,
  getStepIndex,
  getNextLinearStep,
} from "./workflow-types.js";

/**
 * Workflow engine — manages execution state for a declarative agent workflow graph.
 *
 * Holds in-memory workflow state and provides transition logic. All Pi-specific
 * operations (setActiveAgent, sendUserMessage, UI notifications) are handled
 * by the caller (src/index.ts) based on the engine's return values.
 */
export class WorkflowEngine {
  private currentWorkflow: WorkflowState | null = null;
  private currentDefinition: WorkflowDefinition | null = null;

  /** Start a new workflow from a definition. */
  start(definition: WorkflowDefinition): WorkflowState {
    const state: WorkflowState = {
      workflowName: definition.name,
      currentStepId: definition.steps[0].id,
      stepHistory: [definition.steps[0].id],
      loopCounts: {},
      status: "running",
      retryCount: 0,
    };
    this.currentWorkflow = state;
    this.currentDefinition = definition;
    return state;
  }

  /** Start an ad-hoc chain workflow from agent names. */
  startChain(agentNames: string[]): WorkflowState {
    const steps: WorkflowStep[] = agentNames.map((name, idx) => ({
      id: `step-${idx}`,
      agent: name,
      type: "linear",
    }));

    const definition: WorkflowDefinition = {
      name: `chain-${Date.now()}`,
      description: `Ad-hoc chain: ${agentNames.join(" → ")}`,
      steps,
    };

    const state: WorkflowState = {
      workflowName: definition.name,
      currentStepId: steps[0].id,
      stepHistory: [steps[0].id],
      loopCounts: {},
      status: "running",
      retryCount: 0,
      chainId: definition.name,
    };

    this.currentWorkflow = state;
    this.currentDefinition = definition;
    return state;
  }

  getState(): WorkflowState | null {
    return this.currentWorkflow;
  }

  getDefinition(): WorkflowDefinition | null {
    return this.currentDefinition;
  }

  isActive(): boolean {
    return this.currentWorkflow !== null && this.currentWorkflow.status === "running";
  }

  isPaused(): boolean {
    return this.currentWorkflow !== null && this.currentWorkflow.status === "paused";
  }

  isAnyWorkflowActive(): boolean {
    return this.currentWorkflow !== null &&
      (this.currentWorkflow.status === "running" || this.currentWorkflow.status === "paused");
  }

  getCurrentStep(): WorkflowStep | null {
    if (!this.currentDefinition || !this.currentWorkflow) return null;
    return getStepById(this.currentDefinition, this.currentWorkflow.currentStepId);
  }

  /** Validate a transition signal against the current conditional step. */
  validateSignal(signal: string): string | null {
    const step = this.getCurrentStep();
    if (!step || !isConditionalStep(step)) return null;
    const transition = step.transitions[signal];
    return transition ? transition.target : null;
  }

  /** Record a pending transition signal from the workflow_signal tool. */
  recordSignal(signal: string, feedback?: string): boolean {
    if (!this.currentWorkflow) return false;
    const target = this.validateSignal(signal);
    if (!target) return false;
    this.currentWorkflow.pendingTransition = { signal, feedback };
    return true;
  }

  /** Get the feedback from the last recorded pending transition. */
  getPendingFeedback(): string | undefined {
    return this.currentWorkflow?.pendingTransition?.feedback;
  }

  /** Check if the current conditional step has exceeded its loop limit. */
  checkLoopLimit(): { exceeded: boolean; message?: string } {
    const step = this.getCurrentStep();
    if (!step || !isConditionalStep(step)) return { exceeded: false };
    const count = this.currentWorkflow!.loopCounts[step.id] || 0;
    if (step.loop_max !== undefined && count >= step.loop_max) {
      return { exceeded: true, message: step.loop_message };
    }
    return { exceeded: false };
  }

  /**
   * Advance the workflow to the next step based on the current step type
   * and any pending transition.
   *
   * Returns an instruction object telling the caller what to do next.
   */
  advance():
    | { type: "next"; stepId: string; step: WorkflowStep }
    | { type: "complete" }
    | { type: "retry"; stepId: string }
    | { type: "needs-intervention"; availableTransitions: string[]; message?: string }
    | { type: "error"; message: string }
    | null {
    if (!this.currentWorkflow || !this.currentDefinition) return null;

    const currentStep = this.getCurrentStep();
    if (!currentStep) {
      return { type: "error", message: "Current step not found in workflow definition" };
    }

    // Check if we were just resumed from a pause step
    const wasResumedFromPause = this.currentWorkflow.resumedFromPause;
    if (wasResumedFromPause) {
      delete this.currentWorkflow.resumedFromPause;
    }

    let nextStepId: string | null = null;

    // Pause step: stop and wait for user, or advance if just resumed
    if (isPauseStep(currentStep)) {
      if (wasResumedFromPause) {
        nextStepId = getNextLinearStep(this.currentDefinition, currentStep.id);
      } else {
        this.currentWorkflow.status = "paused";
        return { type: "needs-intervention", availableTransitions: [] };
      }
    }

    // Linear step: next by index
    if (isLinearStep(currentStep)) {
      nextStepId = getNextLinearStep(this.currentDefinition, currentStep.id);
    }

    // Conditional step: use pending transition or retry/intervention
    if (isConditionalStep(currentStep)) {
      if (this.currentWorkflow.pendingTransition) {
        const signal = this.currentWorkflow.pendingTransition.signal;
        const transition = currentStep.transitions[signal];
        if (transition) {
          nextStepId = transition.target;
        } else {
          return {
            type: "error",
            message: `Invalid transition signal "${signal}" for step "${currentStep.id}"`,
          };
        }
        delete this.currentWorkflow.pendingTransition;
      } else {
        // No signal received — check retry count
        if ((this.currentWorkflow.retryCount || 0) < 1) {
          this.currentWorkflow.retryCount = (this.currentWorkflow.retryCount || 0) + 1;
          return { type: "retry", stepId: currentStep.id };
        } else {
          // Exceeded retry limit — pause and ask user
          this.currentWorkflow.status = "paused";
          return {
            type: "needs-intervention",
            availableTransitions: Object.keys(currentStep.transitions),
          };
        }
      }
    }

    // End of workflow
    if (nextStepId === null) {
      this.currentWorkflow.status = "completed";
      return { type: "complete" };
    }

    const nextStep = getStepById(this.currentDefinition, nextStepId);
    if (!nextStep) {
      return {
        type: "error",
        message: `Next step "${nextStepId}" not found in workflow definition`,
      };
    }

    // Check loop limit for the target conditional step BEFORE entering it
    if (isConditionalStep(nextStep)) {
      const currentCount = this.currentWorkflow.loopCounts[nextStep.id] || 0;

      if (nextStep.loop_max !== undefined && currentCount >= nextStep.loop_max) {
        this.currentWorkflow.status = "paused";
        return {
          type: "needs-intervention",
          availableTransitions: Object.keys(nextStep.transitions),
          message: nextStep.loop_message || `Maximum loop iterations (${nextStep.loop_max}) reached`,
        };
      }

      this.currentWorkflow.loopCounts[nextStep.id] = currentCount + 1;
    }

    // Move to next step
    this.currentWorkflow.currentStepId = nextStepId;
    this.currentWorkflow.stepHistory.push(nextStepId);
    this.currentWorkflow.retryCount = 0;
    delete this.currentWorkflow.pendingTransition;

    return { type: "next", stepId: nextStepId, step: nextStep };
  }

  /** Forcibly transition to a specific step (used by user intervention picker). */
  forceTransition(signal: string): boolean {
    const step = this.getCurrentStep();
    if (!step || !isConditionalStep(step)) return false;
    const transition = step.transitions[signal];
    if (!transition) return false;

    if (!this.currentWorkflow) return false;

    // Treat this as if the agent called workflow_signal
    this.currentWorkflow.pendingTransition = { signal };
    this.currentWorkflow.status = "running";
    this.currentWorkflow.retryCount = 0;
    return true;
  }

  pause(): void {
    if (this.currentWorkflow) {
      this.currentWorkflow.status = "paused";
    }
  }

  resume(): void {
    if (this.currentWorkflow && this.currentWorkflow.status === "paused") {
      this.currentWorkflow.status = "running";
      this.currentWorkflow.retryCount = 0;
      this.currentWorkflow.resumedFromPause = true;
    }
  }

  abort(): void {
    if (this.currentWorkflow) {
      this.currentWorkflow.status = "aborted";
    }
  }

  reset(): void {
    this.currentWorkflow = null;
    this.currentDefinition = null;
  }

  /** Persist current state to session via appendEntry. */
  persist(pi: ExtensionAPI): void {
    if (this.currentWorkflow) {
      pi.appendEntry("workflow-state", this.currentWorkflow);
    }
  }

  /** Restore state from session entries. Returns true if a running or paused workflow was found. */
  restore(entries: Array<{ type: string; customType?: string; data?: unknown; message?: { customType?: string; details?: unknown } }>): boolean {
    let latest: WorkflowState | undefined;

    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "workflow-state") {
        latest = entry.data as WorkflowState;
      } else if (
        entry.type === "message" &&
        entry.message?.customType === "workflow-state"
      ) {
        latest = entry.message.details as WorkflowState;
      }
    }

    if (latest && (latest.status === "running" || latest.status === "paused")) {
      this.currentWorkflow = latest;
      return true;
    }
    return false;
  }

  /** Attach a discovered definition to a restored workflow state. */
  attachDefinition(definition: WorkflowDefinition): void {
    this.currentDefinition = definition;
  }

  /** Build a human-readable status text for the status bar. */
  getStatusText(): string | undefined {
    if (!this.currentWorkflow || !this.currentDefinition) return undefined;

    const { workflowName, currentStepId, status, loopCounts } = this.currentWorkflow;
    const currentIdx = getStepIndex(this.currentDefinition, currentStepId);
    const totalSteps = this.currentDefinition.steps.length;
    const stepNum = currentIdx >= 0 ? currentIdx + 1 : "?";

    let text: string;
    if (this.currentWorkflow.chainId) {
      text = `Chain: ${stepNum}/${totalSteps}`;
    } else {
      text = `${workflowName} (Step ${stepNum}/${totalSteps}`;

      if (status === "paused") {
        text += " — PAUSED)";
      } else if (status === "running") {
        const step = this.getCurrentStep();
        if (step && isConditionalStep(step)) {
          text += " — awaiting signal)";
        } else {
          text += ")";
        }
      } else {
        text += ` — ${status})`;
      }
    }

    // Append loop count if on a repeated conditional step
    const step = this.getCurrentStep();
    if (step && isConditionalStep(step)) {
      const count = loopCounts[step.id] || 0;
      if (count > 1) {
        const max = step.loop_max ? `/${step.loop_max}` : "";
        text += ` [loop ${count}${max}]`;
      }
    }

    return text;
  }

  /** Build a detailed status message for notifications. */
  getDetailedStatus(): string {
    if (!this.currentWorkflow || !this.currentDefinition) {
      return "No workflow is currently running.";
    }

    const { workflowName, status, currentStepId, stepHistory, loopCounts } = this.currentWorkflow;
    const step = this.getCurrentStep();
    const stepLabel = step ? (isPauseStep(step) ? currentStepId : (step as any).agent || currentStepId) : currentStepId;

    let msg = `Workflow: ${workflowName}\n`;
    msg += `Status: ${status}\n`;
    msg += `Step: ${stepLabel}`;

    const currentIdx = getStepIndex(this.currentDefinition, currentStepId);
    if (currentIdx >= 0) {
      msg += ` (${currentIdx + 1}/${this.currentDefinition.steps.length})`;
    }
    msg += "\n";

    if (step && isConditionalStep(step)) {
      const count = loopCounts[step.id] || 0;
      if (count > 0) {
        msg += `Loop: ${count}${step.loop_max ? `/${step.loop_max}` : ""}\n`;
      }
    }

    msg += `History: ${stepHistory.join(" → ")}`;
    return msg;
  }

  /** Get available transitions for the current conditional step. */
  getAvailableTransitions(): string[] {
    const step = this.getCurrentStep();
    if (!step || !isConditionalStep(step)) return [];
    return Object.keys(step.transitions);
  }

  /** Validate that all agent references in the workflow exist in the given set. */
  validateAgents(validAgentNames: Set<string>): { valid: boolean; missing: string[] } {
    if (!this.currentDefinition) return { valid: true, missing: [] };

    const missing: string[] = [];
    for (const step of this.currentDefinition.steps) {
      if (isLinearStep(step) || isConditionalStep(step)) {
        if (!validAgentNames.has(step.agent)) {
          missing.push(step.agent);
        }
      }
      if ((isLinearStep(step) || isConditionalStep(step)) && step.subagents) {
        for (const sub of step.subagents) {
          if (!validAgentNames.has(sub)) {
            missing.push(sub);
          }
        }
      }
    }

    return { valid: missing.length === 0, missing: [...new Set(missing)] };
  }
}
