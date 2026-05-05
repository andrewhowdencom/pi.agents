# Agent Frontmatter Reference

Agent capabilities are declared via the `role` array in YAML frontmatter. An agent
can be a **leader** (can be switched to via `switch_agent`), a **delegate** (can
be invoked via `delegate_agent`), both, or neither.

## Agent Roles

Add the `role` array to the agent's frontmatter:

```markdown
---
description: "Reviews code and architecture decisions for risks"
role:
  - delegate
---

You are a code reviewer. Your role is to identify risks, suggest improvements,
and evaluate trade-offs.
```

### Available Roles

| Role | Description |
|---|---|
| `leader` | Agent can be switched to via `switch_agent`. All agents are leaders by default. |
| `delegate` | Agent can be invoked via `delegate_agent`. Must be explicitly declared. |

An agent can declare one or both roles:

- **Leader only** (`role: [leader]`) — a long-running persona that owns a phase
- **Delegate only** (`role: [delegate]`) — a scoped reviewer that is never the session owner
- **Both** (`role: [leader, delegate]`) — a planner that can own planning and also be called for quick checks
- **Neither** (`role: []`) — a deprecated or template agent

When the `role` field is absent, the default is `["leader"]` for backward
compatibility.

## Frontmatter Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `role` | string array | `["leader"]` | Capabilities of this agent: `"leader"` and/or `"delegate"` |
| `model` | string | *(Pi default)* | LLM model for this delegate (e.g., `anthropic/claude-sonnet-4`, `openai/gpt-4.1`). Passed as `--model` to the delegate's RPC process. |
| `timeout` | number | `60000` | RPC idle-timeout in milliseconds. The timer resets on each stdout event from the delegate. The delegate is killed only if it goes silent for longer than this duration. |
| `max_turns` | number | `30` | Maximum turns before the delegate is forcibly stopped. |
| `tool_name` | string | `invoke_{name}` | **Deprecated.** Unused with unified `delegate_agent` tool. |
| `tool_schema` | array | — | **Deprecated.** Custom parameters are no longer supported; embed structured data in the `goal` string instead. |

### Deprecated Boolean Fields

The following boolean fields are deprecated and parsed only when `role` is not
explicitly set:

| Deprecated Field | Maps To |
|---|---|
| `lead: false` | Removes `"leader"` from default role |
| `delegate: true` | Adds `"delegate"` to role |
| `subagent: true` | Adds `"delegate"` to role (oldest alias) |

A console warning is emitted when deprecated fields are used.

## The `delegate_agent` Tool

Agents with `delegate` in their `role` can be invoked via the unified
`delegate_agent(agent, goal)` tool. There are no per-agent individual tools.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent` | string | Yes | Name of the delegate agent to invoke |
| `goal` | string | Yes | The scoped task for the delegate |

**Example invocation:**

```tool
delegate_agent(
  agent="reviewer",
  goal="Review this architecture: we will use PostgreSQL for the primary store and Redis for caching. What are the operational risks?"
)
```

## Tool Result Details

The `delegate_agent` tool result includes the following in `details`:

| Field | Type | Description |
|---|---|---|
| `turnCount` | number | Number of turns the delegate executed |
| `timedOut` | boolean | Whether the delegate hit the timeout limit |
| `delegateDepth` | number | Nesting depth of this delegate invocation |
| `usage` | object | Cumulative token usage and cost |

The `usage` object contains:

| Field | Type | Description |
|---|---|---|
| `input` | number | Total input tokens consumed |
| `output` | number | Total output tokens consumed |
| `cacheRead` | number | Total cache-read tokens |
| `cacheWrite` | number | Total cache-write tokens |
| `totalTokens` | number | Total tokens (input + output + cache) |
| `cost.total` | number | Estimated total cost in USD |

## Complete Examples

### Leader + Delegate

```markdown
---
description: "Planner agent that can own phases and be called for quick checks"
role:
  - leader
  - delegate
model: anthropic/claude-sonnet-4
timeout: 120000
max_turns: 10
---

You are a software architect. You design system architecture, choose technology
stacks, and plan implementation phases.
```

### Delegate Only

```markdown
---
description: "Security-focused code reviewer"
role:
  - delegate
model: anthropic/claude-sonnet-4
timeout: 60000
max_turns: 5
---

You are a security reviewer. Your role is to identify vulnerabilities,
misconfigurations, and security anti-patterns in code and architecture.
Focus on SQL injection, XSS, CSRF, authentication flaws, and data exposure.
```

### Leader Only (Default)

```markdown
---
description: "A helpful general-purpose assistant"
---

You are a helpful assistant focused on answering questions and providing guidance.
```

## Guardrails

- An agent cannot delegate to itself.
- Delegate nesting is limited to 3 levels.
- Delegate processes are killed after the configured timeout.
- Delegates are limited to the configured turn count.
- Delegate costs are tracked independently and are not merged into the parent
  session's cost totals.
