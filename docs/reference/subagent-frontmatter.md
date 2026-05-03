# Subagent Frontmatter Reference

Agents marked with `subagent: true` in their YAML frontmatter are automatically
registered as invocable tools. The calling agent can invoke them with a scoped
`goal` and resume its own workflow after receiving the result.

## Enabling Subagent Mode

Add `subagent: true` to the agent's frontmatter:

```markdown
---
description: "Reviews code and architecture decisions for risks"
subagent: true
---

You are a code reviewer. Your role is to identify risks, suggest improvements,
and evaluate trade-offs.
```

## Frontmatter Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `subagent` | boolean | `false` | Set to `true` to enable subagent mode |
| `model` | string | *(Pi default)* | LLM model for this subagent (e.g., `anthropic/claude-sonnet-4`, `openai/gpt-4.1`). Passed as `--model` to the subagent's RPC process. |
| `timeout` | number | `60000` | RPC timeout in milliseconds. The subagent process is killed if it exceeds this. |
| `max_turns` | number | `30` | Maximum turns before the subagent is forcibly stopped. |
| `tool_name` | string | `invoke_{name}` | Override the generated tool name |
| `tool_schema` | array | — | Additional tool parameters beyond `goal` |

## Custom Tool Parameters

Declare additional parameters via `tool_schema`:

```markdown
---
description: "Reviews code and architecture decisions for risks"
subagent: true
tool_schema:
  - name: files_to_review
    type: string
    description: "Comma-separated list of file paths to review"
    required: false
---
```

The tool always accepts `goal` (string, required). Custom parameters are added
to the generated JSON Schema and passed through to the subagent process.

## Generated Tool

For an agent named `reviewer` with `subagent: true`, the extension registers a
tool named `invoke_reviewer` (or the value of `tool_name` if overridden).

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `goal` | string | Yes | The scoped task for the subagent |
| *(custom)* | *(schema-defined)* | Per schema | Additional parameters from `tool_schema` |

**Example invocation:**

```tool
invoke_reviewer(
  goal="Review this architecture: we will use PostgreSQL for the primary store and Redis for caching. What are the operational risks?"
)
```

## Tool Result Details

The tool result includes the following in `details`:

| Field | Type | Description |
|---|---|---|
| `turnCount` | number | Number of turns the subagent executed |
| `timedOut` | boolean | Whether the subagent hit the timeout limit |
| `subagentDepth` | number | Nesting depth of this subagent invocation |
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

## Complete Example

```markdown
---
description: "Security-focused code reviewer"
subagent: true
model: anthropic/claude-sonnet-4
timeout: 120000
max_turns: 10
tool_name: invoke_security_reviewer
tool_schema:
  - name: severity_threshold
    type: string
    description: "Minimum severity to report: LOW, MEDIUM, HIGH, CRITICAL"
    required: false
---

You are a security reviewer. Your role is to identify vulnerabilities,
misconfigurations, and security anti-patterns in code and architecture.
Focus on SQL injection, XSS, CSRF, authentication flaws, and data exposure.
```

## Guardrails

- An agent cannot invoke itself as a subagent.
- Subagent nesting is limited to 3 levels.
- Subagent processes are killed after the configured timeout.
- Subagents are limited to the configured turn count.
- Subagent costs are tracked independently and are not merged into the parent
  session's cost totals.
