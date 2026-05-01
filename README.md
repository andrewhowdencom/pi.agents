# pi.agents

Pi extension plugin for agent selection and role-aware handoff switching.

## Overview

This Pi extension enables users to visually select and switch between specialized
"agents" (personas defined by prompt templates). The extension tracks the active
agent as a visual mode indicator in the status bar. When switching agents, it
performs a **role-aware handoff**: it summarizes the current conversation with
explicit knowledge of both the current and new agent's roles, discards the old
history, and instantiates a new Pi session seeded with only that tailored summary.

> **Note**: The actual system prompt for each agent is managed externally by the
> user (e.g., via `--system-prompt`, `SYSTEM.md`, or Pi harness configuration),
> not by this extension. This extension only manages agent switching and handoff
> summaries.

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

## Prompt Template Convention

Agents are discovered from Pi's prompt template directories:

- `~/.pi/agent/prompts/*.md` (global prompts)
- `.pi/prompts/*.md` (project-local prompts)

To mark a prompt template as an agent, name it with the `agent-` prefix:

- `agent-planner.md` → available as `/agent agent-planner`
- `agent-builder.md` → available as `/agent agent-builder`
- `agent-reviewer.md` → available as `/agent agent-reviewer`

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
  used during handoff summarization to understand the agent's responsibilities

> **Important**: This extension does NOT inject the prompt body into the system
> prompt. You must configure the system prompt externally before starting the new
> session. For example:
>
> ```bash
> # Using --system-prompt flag
> pi --system-prompt ./.pi/prompts/agent-planner.md
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
/agent planner        # shorthand, resolves to agent-planner
/agent agent-planner  # full name
```

### Switching Agents (Role-Aware Handoff)

When an agent is already active and you select a different one, the extension
performs a role-aware handoff:

1. Summarizes the current conversation, tailored to the new agent's role
2. Creates a new session file with the old session as `parentSession`
3. Seeds the new session with only the summary and the new agent state
4. Notifies you when the handoff is complete

Example:

```
# Currently using agent-planner, switch to agent-builder
/agent builder
```

The new session will contain a single user message with the handoff summary,
ensuring the builder agent receives only relevant context (decisions, files,
blockers, next steps) without the full planner conversation history.

### Session Persistence

The active agent is persisted in the session file and restored when you:
- Resume a previous session (`/resume`)
- Restart Pi in the same project

### No Agents Found?

If you run `/agent` and see "No agents found", create prompt templates in your
project's `.pi/prompts/` directory:

```bash
mkdir -p .pi/prompts
cat > .pi/prompts/agent-helper.md << 'EOF'
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

### Role-Aware Summarization

When switching agents, the extension:

1. Serializes the current conversation branch (including compaction summaries)
2. Builds a prompt that includes both agents' role descriptions
3. Calls the LLM to generate a focused summary relevant to the target agent
4. Falls back to a naive truncation summary if the LLM is unavailable

### New Session Creation

The handoff creates a clean session break via `ctx.newSession()`:
- `parentSession` links to the original session file
- `setup` appends the summary as a user message and the new agent state
- `withSession` notifies the user that the handoff is complete

## License

See [LICENSE](LICENSE) file for details.
