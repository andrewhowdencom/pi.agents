# Switch Between Agents

Pi.agents provides three patterns for moving work between agents: manual
switching, autonomous handoff, and subagent invocation. Each serves a different
use case.

## Manual Switching with `/agent`

Use the `/agent` command when you want to explicitly choose which agent
continues the conversation.

Open the picker:

```
/agent
```

Or select directly by name:

```
/agent builder
```

The active agent name updates in the status bar. On the next turn, the new
agent's prompt template content is injected into the system prompt. The full
conversation history is preserved.

### When to Start a Fresh Session

Because the full history is preserved, the new agent may see reasoning from a
previous agent that used a different approach. Start a fresh Pi session when:

- The conversation exceeds ~8,000 tokens (Pi's built-in compaction handles
  smaller contexts automatically)
- Agents have made contradictory architectural decisions
- You need a completely clean context for a new task

## Autonomous Handoff with `switch_agent`

An agent can trigger a handoff to another agent by calling the `switch_agent`
tool. This eliminates the need for manual intervention at every transition.

**Tool parameters:**

| Parameter | Required | Description |
|---|---|---|
| `agent` | Yes | Name of the target agent to switch to |
| `style` | No | `"lightweight"` (default) or `"summarize"` (not yet implemented) |

**Example:**

```tool
switch_agent(agent="builder")
```

**Guardrails:**

- **Discovery validation:** The target agent must exist in the `agents/`
  directories. Unknown agents are rejected with a list of available agents.
- **Self-switch prevention:** An agent cannot switch to itself.
- **User confirmation:** By default, the user is prompted to confirm the handoff:
  `"planner wants to switch to builder. Allow?"`. Denying it aborts the switch
  and the current agent continues.
- **Non-interactive mode:** In print/JSON mode (`-p`, `--mode json`),
  confirmation is skipped.
- **Flag override:** Pass `--agent-switch-confirm false` to disable
  confirmation in interactive mode.

### When to Use Autonomous Handoff

Use `switch_agent` when an agent has completed its role and the next agent
should take over permanently. For example:

- The Planner finishes architectural design and the Builder should implement
- The Builder finishes implementation and the Reviewer should audit the code
- The Reviewer approves the work and the Committer should commit it

### Distinction from Subagents

`switch_agent` is a **permanent transfer** — the caller agent is replaced and
does not resume. For a **call-and-return** pattern where the caller resumes after
receiving output, use subagents instead.

## Subagent Invocation

Subagents allow an active agent to invoke another agent as a tool for a scoped
task, receive its output, and resume its own workflow.

### Declaring a Subagent

Mark an agent as invocable by adding `subagent: true` to its YAML frontmatter:

```markdown
---
description: "Reviews code and architecture decisions for risks"
subagent: true
---

You are a code reviewer. Your role is to identify risks, suggest improvements,
and evaluate trade-offs.
```

When `subagent: true` is present, the extension automatically registers a tool
named `invoke_{agent-name}`. The tool always accepts a `goal` parameter.

**Optional per-agent execution configuration:**

| Frontmatter field | Type | Default | Description |
|---|---|---|---|
| `model` | string | *(Pi default)* | LLM model for this subagent |
| `timeout` | number | `60000` | RPC timeout in milliseconds |
| `max_turns` | number | `30` | Maximum turns before forced stop |
| `tool_schema` | array | — | Additional tool parameters |
| `tool_name` | string | `invoke_{name}` | Override the generated tool name |

### Invoking a Subagent

Call the subagent like any other tool:

```tool
invoke_reviewer(goal="Review this architecture decision. Do you see any risks?")
```

The subagent spawns in an isolated `pi --mode rpc` process with its own system
prompt, executes the scoped goal, and returns its final response. The caller's
identity, session, and history are unchanged.

### Guardrails

- **Self-invocation prevention:** An agent cannot invoke itself as a subagent.
- **Depth limit:** Subagent nesting is limited to 3 levels.
- **Timeout:** Subagent processes are killed after the configured timeout.
- **Max turns:** Subagents are limited to the configured turn count.

### Cost Tracking

The tool result `details` include cumulative token usage and cost across all
subagent turns. Note that subagent costs are tracked independently and are **not**
merged into the parent session's built-in cost totals.

### When to Use Subagents

Use subagents when the active agent needs specialized input but should remain
in control. For example:

- The Planner invokes a Security Reviewer to audit a specific architecture
  decision, then continues planning
- The Builder invokes a Performance Reviewer to check a critical path, then
  continues implementing

## Choosing a Pattern

| Pattern | Direction | Caller Resumes? | Use Case |
|---|---|---|---|
| `/agent` | User-initiated | N/A | Explicit control over which agent is active |
| `switch_agent` | Agent-initiated | No | Permanent handoff when one agent's role ends |
| Subagent | Agent-initiated | Yes | Scoped task delegation with caller continuing |
