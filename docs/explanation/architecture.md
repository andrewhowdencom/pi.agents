# Architecture

This document explains how pi.agents works internally: state persistence, agent
switching, the workflow engine, and subagent isolation.

## State Persistence

The active agent name is stored as a custom `agent-state` entry in the Pi session
via `pi.appendEntry()`. On `session_start`, the extension scans all session
entries and restores the most recent `agent-state`, updating the status bar.

This means:

- Agent selection survives `/resume` and Pi restarts
- Multiple `agent-state` entries accumulate in the session file; the latest one
  wins
- No external state files are required

## Agent Switching

Agent switching is a same-session operation. It can be initiated by the user
(via `/agent`) or by the active agent (via the `switch_agent` tool). Both paths
converge on the same `setActiveAgent()` helper:

1. The module-level `activeAgentName` is updated
2. The status bar is updated to show the new agent
3. A custom `agent-state` entry is appended to the current session
4. On the next `before_agent_start` event, the new agent's content is injected
   into the system prompt

No summarization, no new session creation, no history loss. Context growth is
managed entirely by Pi's built-in compaction.

### Context Fidelity

Because the full conversation history is preserved, the new agent may see
reasoning from a previous agent that used a different approach or made
contradictory decisions. This is a deliberate trade-off: it preserves complete
context at the cost of potential confusion. Pi's built-in compaction trims older
context automatically, and users can always start a fresh session for a clean
break.

## Workflow Engine

The workflow engine is a deterministic state machine backed by the Pi session.

### State Representation

Workflow state is persisted as a custom entry in the session, containing:

- `workflowName` — The running workflow's identifier
- `currentStepId` — The active step
- `stepHistory` — Ordered list of visited step IDs
- `loopCounts` — Per-step visit counters
- `status` — `running`, `paused`, `completed`, `aborted`
- `pendingTransition` — Recorded `workflow_signal` data awaiting agent turn completion

### Execution Model

On `agent_end`, the engine evaluates the completed step:

- **Linear steps** — Automatically advance to the next step via `sendUserMessage`
  with a steer-delivered prompt
- **Conditional steps** — Wait for `workflow_signal`. If the agent finishes
  without signaling, the engine retries once with a reminder, then pauses for
  user intervention (or aborts in non-interactive mode)
- **Pause steps** — Stop unconditionally; resume via `/workflow resume`

### Dynamic Tool Activation

During workflow execution, the engine modifies the active tool set:

- `workflow_signal` is injected during conditional steps
- `invoke_*` tools are injected for subagents declared in the current step
- The original tool set is restored when the workflow completes or aborts

### Graph Validation

Before starting a workflow, the engine validates the graph:

- All transition targets must reference existing step IDs
- All steps must be reachable from the start
- Self-loops on conditional steps require `loop_max > 0`
- Every cycle must contain at least one conditional step with `loop_max`

## Subagent Isolation

Subagents run in isolated `pi --mode rpc` processes with their own system
prompts. They do not share session state with the parent agent.

### Process Model

1. The caller agent invokes `invoke_{name}(goal="...")`
2. The extension spawns a new `pi --mode rpc` process
3. The subagent's system prompt (from its `.md` file) and the `goal` are passed
   to the process
4. The subagent executes autonomously, making its own tool calls
5. The final response is returned to the caller as a tool result

### Nesting and Depth Tracking

Subagent nesting is tracked via `AsyncLocalStorage`. Each invocation increments
the depth counter. Depths beyond 3 are rejected with an error.

### Cost Independence

Subagent token usage and cost are tracked independently from the parent session.
The `usage` field in the tool result `details` provides the complete breakdown,
but these costs are not merged into Pi's built-in session statistics.
