# Getting Started with pi.agents

Learn to install pi.agents, create your first agent, switch between agents,
and run a simple multi-agent workflow.

## Learning Objectives

By the end of this tutorial, you will be able to:

1. Install the pi.agents extension into a Pi project
2. Create an agent prompt template and make it discoverable
3. Switch between agents manually and autonomously
4. Define and run a two-step workflow YAML file

## Audience

This tutorial is for Pi users who want to organize their AI-assisted workflow
around specialized personas (e.g., planner, builder, reviewer).

## Prerequisites

- [Pi](https://github.com/mariozechner/pi) installed and running
- Node.js 18 or higher
- A project directory where you run Pi

## Step 1: Install the Extension

Clone the extension into your project's `.pi/extensions` directory:

```bash
cd your-project
git clone https://github.com/andrewhowdencom/pi.agents.git .pi/extensions/pi-agents
cd .pi/extensions/pi-agents
npm install
```

Reload Pi to discover the extension:

```
/reload
```

You should see pi.agents loaded in the extension list.

## Step 2: Create Your First Agent

Create an agent directory and a prompt template file:

```bash
mkdir -p .pi/agents
cat > .pi/agents/planner.md << 'EOF'
---
description: "Focuses on high-level architecture and planning"
---

You are a software architect. Your role is to design systems, evaluate
trade-offs, and create implementation plans before code is written. Focus on
clarity, scalability, and maintainability.
EOF
```

The file basename (`planner`) becomes the agent name. The optional YAML
frontmatter `description` appears in the agent picker UI.

Reload Pi again:

```
/reload
```

## Step 3: Select the Agent

Open the agent picker:

```
/agent
```

Select **planner**. The status bar updates to show `Agent: planner`.

You can also select directly by name:

```
/agent planner
```

## Step 4: Switch to Another Agent

Create a second agent:

```bash
cat > .pi/agents/builder.md << 'EOF'
---
description: "Implements the plan with clean, tested code"
---

You are a software builder. Your role is to implement plans with clean,
well-tested, production-ready code. Prefer small functions, clear naming, and
comprehensive tests.
EOF
```

Reload Pi, then switch from planner to builder:

```
/agent builder
```

The status bar updates to `Agent: builder`. The conversation history is fully
preserved — the builder sees all prior messages from the planner.

## Step 5: Run a Simple Workflow

Create a workflow that chains planner and builder automatically:

```bash
mkdir -p .pi/workflows
cat > .pi/workflows/plan-build.yml << 'EOF'
name: plan-build
description: "Plan the architecture, then implement it"

steps:
  - id: plan
    agent: planner
    type: linear
    prompt: "Design a simple REST API for a todo list. Output the plan."

  - id: build
    agent: builder
    type: linear
    prompt: "Implement the todo list API described in the previous step."
EOF
```

Start the workflow:

```
/workflow plan-build
```

The planner runs first. When it finishes, the workflow automatically advances
to the builder step. The status bar shows real-time progress:

```
Agent: planner | Workflow: plan-build (Step 1/2)
Agent: builder | Workflow: plan-build (Step 2/2)
```

## Step 6: Pause and Resume

If you need to interrupt the workflow, pause it:

```
/workflow pause
```

Continue the conversation normally. When ready, resume:

```
/workflow resume
```

## What You Learned

- Agents are Markdown files in `.pi/agents/` with optional YAML frontmatter
- `/agent` opens a picker; `/agent <name>` selects directly
- Agent switches are lightweight and preserve conversation history
- Workflows are YAML files in `.pi/workflows/` that chain agents automatically
- Workflows can be paused and resumed

## Next Steps

- [Install the Extension](../how-to/install.md) — Explore all installation options
- [Switch Between Agents](../how-to/switch-agents.md) — Learn about autonomous handoffs and subagents
- [Create a Workflow](../how-to/create-workflow.md) — Build conditional workflows with decision points
