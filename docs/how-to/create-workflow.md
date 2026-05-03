# Create a Workflow

Workflows are YAML files that define multi-agent execution pipelines. This guide
covers how to write, validate, and test workflow definitions.

## Prerequisites

- pi.agents extension installed
- At least two agents created in `.pi/agents/`

## Step 1: Create the Workflow Directory

```bash
mkdir -p .pi/workflows
```

Workflows can also be defined globally in `~/.pi/agent/workflows/*.yml` or `~/.pi/agent/workflows/*.yaml`.
Project-local workflows take precedence when names collide — the same rule as
agents.

## Step 2: Write a Linear Workflow

Create a workflow with two linear steps that auto-advance:

```yaml
# .pi/workflows/plan-build.yml
name: plan-build
description: "Plan the architecture, then implement it"

steps:
  - id: plan
    agent: planner
    type: linear
    prompt: "Design a REST API for a todo list. Output the plan."

  - id: build
    agent: builder
    type: linear
    prompt: "Implement the todo list API described in the previous step."
```

**Linear step behavior:** The agent performs its task; the engine automatically
advances to the next step when the agent finishes.

> **Initial prompts:** You can pass a custom prompt when starting a workflow:
> ```
> /workflow plan-build "Design a REST API for managing todo lists"
> ```
> The initial text is appended to the first step's `prompt`. If the first step
> has no `prompt`, the initial text becomes the entire message. This makes
> workflows reusable — the same workflow YAML can be used for different tasks
> by varying the initial prompt.

## Step 3: Add a Conditional Step

Add a review step where the agent must explicitly choose what happens next:

```yaml
# .pi/workflows/plan-build-review.yml
name: plan-build-review
description: "Plan, implement, and review"

steps:
  - id: plan
    agent: planner
    type: linear
    prompt: "Design the architecture."

  - id: build
    agent: builder
    type: linear
    prompt: "Implement the plan."

  - id: review
    agent: reviewer
    type: conditional
    prompt: "Review the implementation. Call workflow_signal when done."
    transitions:
      approved:
        target: committer
      changes_needed:
        target: build
        message: "Review feedback: {{feedback}}"
    loop_max: 5

  - id: committer
    agent: committer
    type: linear
    prompt: "Commit the changes."
```

**Conditional step behavior:** The agent performs its task and then calls
`workflow_signal(signal: "approved")` or
`workflow_signal(signal: "changes_needed", feedback: "...")` to choose the next
step.

**Loop limit:** `loop_max` limits how many times the review step can be visited.
Exceeding it pauses the workflow for user direction.

## Step 4: Add Subagent Composition

For complex review steps, delegate to specialized subagents:

```yaml
  - id: review
    agent: reviewer
    type: conditional
    subagents:
      - security-reviewer
      - performance-reviewer
    transitions:
      approved:
        target: committer
      changes_needed:
        target: build
```

When `subagents` is present but `prompt` is absent, the engine auto-generates a
coordinator prompt that lists the available `invoke_*` tools. Provide a custom
`prompt` to override this entirely:

```yaml
    prompt: >
      Only request changes if security or performance reviewers report HIGH
      or CRITICAL issues. Call workflow_signal when done.
```

Each subagent must have `subagent: true` in its frontmatter.

## Step 5: Add a Pause Step

For user intervention points:

```yaml
  - id: user_intervention
    type: pause
    prompt: "The workflow is paused. Provide your direction to continue."
```

Resume with `/workflow resume`.

## Step 6: Validate the Workflow

Start the workflow to trigger structural validation:

```
/workflow plan-build-review
```

The engine checks:

- All transition targets reference existing step IDs
- No steps are unreachable from the start
- Self-loops on conditional steps have `loop_max > 0`
- All cycles have at least one conditional step with `loop_max` protection

If validation fails, the workflow aborts with an error message.

## Step 7: Test Incrementally

1. Start with a simple two-step linear workflow
2. Add one conditional step at a time
3. Test subagents individually before composing them
4. Use `/workflow status` to inspect the current state

## Troubleshooting

**"Agent forgot to call workflow_signal"**

The engine retries once with a system-prompt reminder. If still no signal, the
workflow pauses and a picker shows the available transitions. Pick one to
continue, or abort with `/workflow abort`.

**"Workflow paused unexpectedly"**

Check if a conditional step hit its `loop_max` limit. The status notification
shows the current step and loop count. Resume with `/workflow resume` or abort
with `/workflow abort`.

**"Subagent timed out during review step"**

Increase the subagent's `timeout` in its frontmatter (milliseconds), or reduce
the scope of the subagent's goal.

**"Workflow references unknown agents"**

Ensure all `agent` names in the workflow YAML match basenames of `.md` files in
`.pi/agents/`. Ensure all `subagents` names also match discovered agent files and
have `subagent: true` in their frontmatter.

## Ad-Hoc Linear Chains

For quick one-off pipelines without creating a YAML file:

```
/chain planner builder reviewer committer
```

This runs a linear sequence with auto-transitions and no conditional logic.
