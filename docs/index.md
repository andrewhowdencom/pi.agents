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

### Workflows

Workflows are declarative YAML files that define multi-agent execution pipelines. Pi automatically hands off between agents in sequence, with conditional transitions driven by explicit tool calls.

#### Workflow Discovery

Workflow files are discovered from:
- `.pi/workflows/*.yml` (project-local, takes precedence)
- `~/.pi/agent/workflows/*.yml` (global)

Files use their basename (without `.yml`) as the workflow name. Reserved keywords (`pause`, `resume`, `abort`, `status`, `list`) cannot be used as workflow names.

#### Step Types

**`linear`** — The agent performs its task; the engine automatically advances to the next step when the agent finishes.

```yaml
- id: executor
  agent: executor
  type: linear
  prompt: "Implement the plan described in the previous step."
```

**`conditional`** — The agent performs its task and then calls `workflow_signal(signal, feedback?)` to choose the next step. The engine validates the signal against the `transitions` map.

```yaml
- id: reviewer
  agent: reviewer
  type: conditional
  transitions:
    approved:
      target: committer
    changes_needed:
      target: executor
      message: "Review feedback: {{feedback}}"
  loop_max: 5
```

**`pause`** — The workflow unconditionally stops. The user can continue the conversation normally, then resume with `/workflow resume`.

```yaml
- id: user_intervention
  type: pause
  prompt: "Provide your direction to continue the workflow."
```

#### Subagent Composition

Conditional steps can declare `subagents` to leverage specialized reviewers without complicating the workflow graph:

```yaml
- id: reviewer
  agent: reviewer
  type: conditional
  subagents:
    - security-reviewer
    - performance-reviewer
    - style-reviewer
  transitions:
    approved: committer
    changes_needed: executor
```

When `subagents` is present but `prompt` is absent, the engine **auto-generates a coordinator prompt** that:
- Lists the available `invoke_*` subagent tools
- Instructs the agent to call each with a scoped goal
- Reminds the agent to synthesize findings and call `workflow_signal`

**User override**: Provide a custom `prompt` to replace the auto-generated one entirely. This is useful for customizing decision criteria (e.g., *"Only block on HIGH or CRITICAL security findings"*) or skipping certain subagents for an MVP.

```yaml
- id: reviewer
  agent: reviewer
  type: conditional
  subagents:
    - security-reviewer
    - performance-reviewer
  prompt: >
    Skip style review for this MVP. Only request changes if
    security or performance reviewers report HIGH or CRITICAL issues.
    Call workflow_signal when done.
  transitions:
    approved: committer
    changes_needed: executor
```

Each subagent runs in an isolated RPC process with its own system prompt and optional model override (via the subagent file's frontmatter `model:` field), so a lightweight model can handle style while a heavy model handles security.

#### Commands

| Command | Description |
|---|---|
| `/workflow` | Show status if active, otherwise show workflow picker |
| `/workflow <name>` | Start a workflow by name |
| `/workflow list` | Show picker with available workflows |
| `/workflow pause` | Pause the current workflow |
| `/workflow resume` | Resume a paused workflow |
| `/workflow abort` | Abort the current workflow with confirmation |
| `/workflow status` | Show detailed workflow status |
| `/chain <agents...>` | Run an ad-hoc linear chain (e.g., `/chain planner executor reviewer`) |

#### Visual Progress

The status bar shows the current workflow step:
```
Agent: executor | Workflow: plan-build-review (Step 2/5)
Agent: reviewer | Workflow: plan-build-review (Step 3/5 — awaiting signal)
Agent: reviewer | Workflow: plan-build-review (Step 3/5, loop 2/5)
```

#### Troubleshooting

**"Agent forgot to call workflow_signal"**
- The engine retries once with a system-prompt reminder
- If still no signal, the workflow pauses and a picker dialog shows the available transitions
- Pick one to continue, or abort with `/workflow abort`

**"Workflow paused unexpectedly"**
- Check if a conditional step hit its `loop_max` limit
- The status notification shows the current step and loop count
- Resume with `/workflow resume` or abort with `/workflow abort`

**"Subagent timed out during review step"**
- Increase the subagent's `timeout` in its frontmatter (milliseconds)
- Or reduce the scope of the subagent's goal in the coordinator prompt

**"Workflow references unknown agents"**
- Ensure all `agent` names in the workflow YAML match basenames of `.md` files in `.pi/agents/`
- Ensure all `subagents` names also match discovered agent files and have `subagent: true` in their frontmatter

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

Agent switching is a same-session operation. When the user runs `/agent <name>`:

1. The module-level `activeAgentName` is updated
2. The status bar is updated to show the new agent
3. A custom `agent-state` entry is appended to the current session
4. On the next `before_agent_start` event, the new agent's content is injected
   into the system prompt

No summarization, no new session creation, no history loss. Context growth is
managed entirely by Pi's built-in compaction.

## License

See [LICENSE](LICENSE) file for details.
