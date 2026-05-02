# pi.agents

Pi extension plugin for agent selection and lightweight switching.

## Overview

This Pi extension enables users to visually select and switch between specialized
"agents" (personas defined by prompt templates). The extension tracks the active
agent as a visual mode indicator in the status bar. When switching agents, the
active agent name changes and the new agent's system prompt is injected on the
next turn — all within the same session, with full conversation history preserved.

> **Note**: The actual system prompt for each agent is managed externally by the
> user (e.g., via `--system-prompt`, `SYSTEM.md`, or Pi harness configuration),
> not by this extension. This extension only manages agent selection and switching.

## Installation

### Method 1: Project-local (recommended for per-project agents)

```bash
# Clone or symlink the extension into your project's .pi/extensions directory
git clone <repo-url> ~/.pi/agent/extensions/pi-agents
# Or create a symlink from your project
cd your-project
ln -s /path/to/pi.agents .pi/extensions/pi-agents
```

### Method 2: Global installation

```bash
git clone <repo-url> ~/.pi/agent/extensions/pi-agents
cd ~/.pi/agent/extensions/pi-agents
npm install
```

### Activation

After installation, reload Pi with the `/reload` command to discover the extension.

## Agent Directory Convention

Agents are discovered from dedicated agent directories:

- `~/.pi/agent/agents/*.md` (global agents, available in all projects)
- `.pi/agents/*.md` (project-local agents)

Files in these directories use their basename (without `.md`) as the agent name:

- `planner.md` → available as `/agent planner`
- `builder.md` → available as `/agent builder`
- `reviewer.md` → available as `/agent reviewer`

### Backward Compatibility

Existing `agent-*.md` files in the legacy prompt directories (`~/.pi/agent/prompts/`
and `.pi/prompts/`) continue to be discovered. For these legacy files, the
`agent-` prefix is automatically stripped, so `agent-planner.md` is available as
`/agent planner`.

If an agent exists in both a new `agents/` location and an old `prompts/`
location with the same name, the new location takes precedence.

To migrate an existing agent, simply move the file:

```bash
mv .pi/prompts/agent-planner.md .pi/agents/planner.md
```

### Prompt Template Format

Each agent prompt template is a Markdown file with optional YAML frontmatter:

```markdown
---
description: "Focuses on high-level architecture and planning"
---

You are a software architect. Your role is to design systems, evaluate trade-offs,
and create implementation plans before code is written. Focus on clarity,
scalability, and maintainability.
```

- The **frontmatter** can include a `description` field (shown in the selector UI)
- The **body** (after frontmatter) captures the agent's role description and is
  used during agent switching to understand the agent's responsibilities

> **Important**: This extension does NOT inject the prompt body into the system
> prompt. You must configure the system prompt externally before starting the new
> session. For example:
>
> ```bash
> # Using --system-prompt flag
> pi --system-prompt ./.pi/agents/planner.md
>
> # Or place SYSTEM.md in your project root
> pi
> ```

## Usage

### Selecting an Agent

Run the `/agent` command without arguments to open a picker:

```
/agent
```

Select an agent from the list. The active agent name appears in the status bar.

### Direct Agent Selection

Run `/agent` with an agent name to select it directly:

```
/agent planner
/agent builder
```

### Switching Agents

When an agent is already active and you select a different one, the extension
performs an instant lightweight switch:

1. The active agent name is updated in the status bar
2. A custom `agent-state` entry is appended to the current session
3. The new agent's system prompt is injected on the next turn via the
   `before_agent_start` handler

The conversation history remains fully intact. The new agent sees all prior
user and assistant messages, allowing it to continue from where the previous
agent left off.

Example:

```
# Currently using planner, switch to builder
/agent builder
```

> **Context fidelity trade-off**: Because the full conversation history is
> preserved, the new agent may see reasoning from a previous agent that used a
> different approach or made contradictory decisions. This is an accepted trade-off
> in exchange for simplicity and complete history preservation. Pi's built-in
> compaction automatically trims older context as it grows, and you can always
> start a fresh Pi session if a completely clean break is needed.

### Autonomous Agent Handoff

Agents can autonomously hand off control to another agent by calling the
`switch_agent` tool. This eliminates the need for human intervention at every
workflow transition.

When an agent finishes its role, it can call:

```tool
switch_agent(agent="builder")
```

**Tool parameters:**

| Parameter | Required | Description |
|---|---|---|
| `agent` | Yes | Name of the target agent to switch to |
| `style` | No | `"lightweight"` (default) or `"summarize"` (not yet implemented) |

**Guardrails:**

- **Discovery validation**: The target agent must be discovered from the
  `agents/` directories. Unknown agents are rejected with a list of available
  agents.
- **Self-switch prevention**: An agent cannot switch to itself. The tool
  returns an error if the target is already the active agent.
- **User confirmation**: By default, the user is prompted to confirm the handoff:
  `"planner wants to switch to builder. Allow?"`. Denying it aborts the switch
  and the current agent continues.
- **Non-interactive mode**: In print/JSON mode (`-p`, `--mode json`), confirmation
  is skipped and the switch proceeds automatically.
- **Flag override**: Pass `--agent-switch-confirm false` to disable confirmation
  in interactive mode.

**Example scenario:**

The Planner agent finishes architectural planning and decides the Builder should
implement the plan:

> "The architecture looks solid. I'll hand this off to the Builder to implement."
> ```tool
> switch_agent(agent="builder")
> ```

Pi confirms with the user, then updates the active agent. On the next turn, the
Builder's system prompt is injected via `before_agent_start` and the Builder
continues from the full conversation history.

**Distinction from `/agent`**: The `/agent` command is user-initiated. The
`switch_agent` tool is agent-initiated. Both converge on the same
`setActiveAgent()` path.

**Distinction from subagents** (Issue #3): Subagents are a call-and-return
pattern — the caller resumes after the subagent finishes. `switch_agent` is a
permanent transfer — the caller agent is replaced and does not resume.

### Subagents

Subagents allow an active agent to **invoke another agent as a tool** for a
scoped task, receive its output, and **resume its own workflow** — all without
changing identity or losing context. This is the call-and-return pattern,
distinct from the permanent handoff of `switch_agent`.

#### Declaring a Subagent

Mark an agent as invocable as a subagent by adding `subagent: true` to its
YAML frontmatter. You can optionally declare additional tool parameters
via `tool_schema`:

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

You are a code reviewer. Your role is to identify risks, suggest improvements,
and evaluate trade-offs in software architecture and implementation.
```

When `subagent: true` is present, the extension automatically registers a
tool named `invoke_{agent-name}` (override with `tool_name`). The tool
always accepts a `goal` parameter, plus any custom parameters declared in
`tool_schema`.

#### Invoking a Subagent

The active agent calls the subagent like any other tool:

```tool
invoke_reviewer(goal="Review this architecture decision. Do you see any risks?")
```

The subagent spawns in an isolated `pi --mode rpc` process with its own
system prompt, executes the scoped goal (including any tool calls it needs,
such as `read` or `bash`), and returns its final response as a tool result.
The caller agent's identity, session, and history are completely unchanged.

**Example scenario:**

The **Planner** agent is designing a system and wants the **Reviewer** to
critique a specific decision:

> "Before I commit to this approach, let me get a second opinion."
> ```tool
> invoke_reviewer(
>   goal="Review this architecture: we will use PostgreSQL for the primary store and Redis for caching. What are the operational risks?"
> )
> ```

The Reviewer runs in its own process, analyzes the architecture, and
returns feedback. Each completed turn's output is streamed back to the parent
session in real time, so you can watch the subagent's progress. The Planner
receives the final result and continues planning.

#### Guardrails

- **Self-invocation prevention**: An agent cannot invoke itself as a subagent.
- **Depth limit**: Subagent nesting is limited to 3 levels. Deeper nesting
  returns an error.
- **Timeout**: Subagent RPC processes are killed after a configurable timeout
  (default 60 seconds). Pass `--subagent-timeout <ms>` to override.
- **Max turns**: Subagents are limited to a configurable number of turns
  (default 5). Pass `--subagent-max-turns <n>` to override.

#### Live Progress and Cost Tracking

While a subagent is running, its output is streamed back to the parent
session after each completed turn. You can see the subagent's reasoning
and tool calls as they happen, rather than waiting for the entire execution
to finish.

The tool result `details` include:

| Field | Description |
|---|---|
| `turnCount` | Number of turns the subagent executed |
| `timedOut` | Whether the subagent hit the timeout limit |
| `subagentDepth` | Nesting depth of this subagent invocation |
| `usage` | Cumulative token usage and cost across all turns |

The `usage` object contains:

| Field | Description |
|---|---|
| `input` | Total input tokens consumed |
| `output` | Total output tokens consumed |
| `cacheRead` | Total cache-read tokens |
| `cacheWrite` | Total cache-write tokens |
| `totalTokens` | Total tokens (input + output + cache) |
| `cost.total` | Estimated total cost in USD |

**Known limitation**: Subagent costs are tracked independently and are **not**
merged into the parent session's built-in cost totals. The subagent runs in a
separate `pi --mode rpc` process, and Pi does not expose an API to inject
external usage data into the parent's `SessionStats`. The `usage` field in the
tool result details provides the complete subagent cost breakdown.

### Session Persistence

The active agent is persisted in the session file and restored when you:
- Resume a previous session (`/resume`)
- Restart Pi in the same project

### No Agents Found?

If you run `/agent` and see "No agents found", create agent files in your
project's `.pi/agents/` directory:

```bash
mkdir -p .pi/agents
cat > .pi/agents/helper.md << 'EOF'
---
description: "A helpful general-purpose assistant"
---

You are a helpful assistant focused on answering questions and providing guidance.
EOF
```

Then reload Pi with `/reload`.

## Architecture

### State Persistence

The active agent name is stored as a custom entry (`agent-state`) in the session
via `pi.appendEntry()`. On `session_start`, the extension scans entries and
restores the active agent, updating the status bar.

### Agent Switching

Agent switching is a same-session operation. It can be initiated by the user via
`/agent <name>` or by the active agent via the `switch_agent` tool. Both paths
converge on the same `setActiveAgent()` helper:

1. The module-level `activeAgentName` is updated
2. The status bar is updated to show the new agent
3. A custom `agent-state` entry is appended to the current session
4. On the next `before_agent_start` event, the new agent's content is injected
   into the system prompt

No summarization, no new session creation, no history loss. Context growth is
managed entirely by Pi's built-in compaction.

## License

See [LICENSE](LICENSE) file for details.
