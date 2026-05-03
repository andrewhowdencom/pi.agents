# Install the pi.agents Extension

## Prerequisites

- [Pi](https://github.com/mariozechner/pi) installed and running
- Node.js 18 or higher

## Method 1: Project-Local Installation (Recommended)

Install the extension inside your project so agents and workflows are
project-specific and version-controlled alongside your code.

```bash
cd your-project
git clone https://github.com/andrewhowdencom/pi.agents.git .pi/extensions/pi-agents
cd .pi/extensions/pi-agents
npm install
```

After installation, reload Pi:

```
/reload
```

### Symlink Alternative

If you maintain the extension in a separate directory, create a symlink:

```bash
cd your-project
ln -s /path/to/pi.agents .pi/extensions/pi-agents
```

## Method 2: Global Installation

Install the extension once for all projects:

```bash
git clone https://github.com/andrewhowdencom/pi.agents.git ~/.pi/agent/extensions/pi-agents
cd ~/.pi/agent/extensions/pi-agents
npm install
```

Agents from both global (`~/.pi/agent/agents/`) and project-local
(`.pi/agents/`) directories are discovered. Project-local agents take
precedence when names collide.

## Verification

After reloading Pi, verify the extension is loaded:

1. Run `/agent` — you should see "No agents found" (until you create some)
2. Run `/workflow list` — you should see "No workflows found"

If you see extension errors instead, check that:

- `npm install` completed without errors in the extension directory
- Node.js is version 18 or higher (`node --version`)

## Agent and Workflow Directories

Create these directories in your project (or globally) to store agents and
workflows:

```bash
mkdir -p .pi/agents      # Agent prompt templates (*.md)
mkdir -p .pi/workflows   # Workflow definitions (*.yml)
```

After creating files in these directories, run `/reload` to refresh the
discovery cache.
