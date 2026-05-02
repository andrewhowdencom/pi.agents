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
