# pi.agents Documentation

Welcome to the pi.agents documentation. This Pi extension enables agent
selection, lightweight switching, subagent invocation, and declarative
multi-agent workflows.

## Getting Started

New to pi.agents? Start with the tutorial:

- [Getting Started](tutorial/getting-started.md) — Install the extension, create
  your first agent, and run a workflow

## How-To Guides

Step-by-step guides for specific tasks:

- [Install the Extension](how-to/install.md) — Project-local, global, and
  activation
- [Switch Between Agents](how-to/switch-agents.md) — Manual switching,
  autonomous handoffs, and subagent invocation
- [Create a Workflow](how-to/create-workflow.md) — Write, validate, and test
  workflow YAML files

## Reference

Lookup information for commands, tools, and configuration:

- [Commands and Tools](reference/commands.md) — `/agent`, `/workflow`, `/chain`,
  `switch_agent`, `workflow_signal`
- [Workflow YAML](reference/workflow-yaml.md) — Complete schema for workflow
  definitions
- [Subagent Frontmatter](reference/subagent-frontmatter.md) — Configuration
  fields for subagent-capable agents

## Explanation

Conceptual background and design rationale:

- [Architecture](explanation/architecture.md) — How state persistence, agent
  switching, the workflow engine, and subagent isolation work
