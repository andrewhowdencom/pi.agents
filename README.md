# pi.agents

Pi extension plugin for agent selection, switching, and multi-agent workflows.

## Overview

This Pi extension enables users to visually select and switch between specialized
agents (personas defined by prompt templates), and to run automated multi-agent
workflows. The extension tracks the active agent in the status bar and handles
lightweight same-session agent switches with full conversation history preserved.

## Features

- **Visual agent selection** — Browse and select agents via a picker UI
- **Lightweight agent switching** — Switch agents within the same session, preserving full history
- **Autonomous handoffs** — Agents can transfer control to another agent via the `switch_agent` tool
- **Subagents** — Invoke specialized agents as scoped tools and resume the caller's workflow
- **Workflows** — Define multi-agent pipelines as YAML files with linear, conditional, and pause steps
- **Ad-hoc chains** — Run quick linear agent sequences without creating a YAML file
- **Session persistence** — Active agent and workflow state are restored across sessions

## Prerequisites

- [Pi coding agent](https://github.com/mariozechner/pi) installed
- Node.js 18 or higher

## Quick Start

### 1. Install the extension

```bash
# Project-local (recommended)
git clone https://github.com/andrewhowdencom/pi.agents.git .pi/extensions/pi-agents
cd .pi/extensions/pi-agents
npm install

# Or reload Pi to auto-discover
```

### 2. Create your first agent

```bash
mkdir -p .pi/agents
cat > .pi/agents/helper.md << 'EOF'
---
description: "A helpful general-purpose assistant"
---

You are a helpful assistant focused on answering questions and providing guidance.
EOF
```

### 3. Select the agent

In Pi, run:

```
/agent
```

Select **helper** from the picker. The agent name appears in the status bar.

## Documentation

Full documentation is available at [https://andrewhowdencom.github.io/pi.agents/](https://andrewhowdencom.github.io/pi.agents/).

| Resource | Description |
|---|---|
| [Getting Started Tutorial](docs/tutorial/getting-started.md) | Step-by-step first-time setup |
| [Installation Guide](docs/how-to/install.md) | Detailed installation options |
| [Switching Agents](docs/how-to/switch-agents.md) | Manual, autonomous, and subagent patterns |
| [Creating Workflows](docs/how-to/create-workflow.md) | How to write workflow YAML files |
| [Command Reference](docs/reference/commands.md) | All commands and tools |
| [Workflow YAML Reference](docs/reference/workflow-yaml.md) | Complete workflow schema |
| [Subagent Configuration](docs/reference/subagent-frontmatter.md) | Subagent frontmatter fields |
| [Architecture](docs/explanation/architecture.md) | How the extension works internally |

## License

See [LICENSE](LICENSE) for details.
