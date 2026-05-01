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
  used during handoff summarization to understand the agent's responsibilities

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

### Switching Agents (Role-Aware Handoff)

When an agent is already active and you select a different one, the extension
performs a role-aware handoff:

1. A loading overlay appears while the conversation is summarized for the new
   agent's role. You can cancel the handoff at any time during this step by
   pressing **Escape** or the loader's cancel action—this aborts the LLM call
   and leaves your current session completely unchanged.
2. The status bar cycles through phase indicators: **"Summarizing for
   {agent}..."** → **"Creating session for {agent}..."** → cleared when the
   handoff completes.
3. Creates a new session file with the old session as `parentSession`
4. Seeds the new session with only the summary and the new agent state
5. Notifies you when the handoff is complete

Example:

```
# Currently using planner, switch to builder
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
