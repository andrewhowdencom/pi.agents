# Workflow YAML Reference

Workflow files use YAML syntax and are discovered from:

- `.pi/workflows/*.yml` and `*.yaml` (project-local, takes precedence)
- `~/.pi/agent/workflows/*.yml` and `*.yaml` (global)

Files use their basename (without `.yml`) as the workflow name.

## Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Workflow identifier (must match the filename basename) |
| `description` | string | No | Human-readable description shown in the workflow picker |
| `version` | string | No | Workflow version string |
| `steps` | array | Yes | Ordered list of workflow steps |

## Step Types

### `linear`

Auto-advances to the next step when the agent finishes.

```yaml
- id: executor
  agent: executor
  type: linear
  prompt: "Implement the plan described in the previous step."
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique step identifier |
| `agent` | string | Yes | Name of the agent to run |
| `type` | string | Yes | Must be `"linear"` |
| `prompt` | string | No | Injected into the system prompt for this step |

### `conditional`

Requires the agent to call `workflow_signal` to choose the next step.

```yaml
- id: reviewer
  agent: reviewer
  type: conditional
  prompt: "Review the implementation and call workflow_signal."
  subagents:
    - security-reviewer
    - performance-reviewer
  transitions:
    approved:
      target: committer
    changes_needed:
      target: executor
      message: "Review feedback: {{feedback}}"
  loop_max: 5
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique step identifier |
| `agent` | string | Yes | Name of the agent to run |
| `type` | string | Yes | Must be `"conditional"` |
| `prompt` | string | No | Injected into the system prompt; overrides auto-generated coordinator prompt |
| `subagents` | array of strings | No | Subagent names to make available as `invoke_*` tools |
| `transitions` | map | Yes | Signal-to-target mapping |
| `loop_max` | number | No | Maximum times this step can be visited |
| `loop_message` | string | No | Message shown when `loop_max` is exceeded |

#### Transitions Map

Each key in `transitions` is a signal name the agent can pass to
`workflow_signal`. Each value is:

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | string | Yes | ID of the next step |
| `message` | string | No | Optional message injected into the next step's prompt; supports `{{feedback}}` template |

### `pause`

Unconditionally stops the workflow. The user continues the conversation
normally, then resumes with `/workflow resume`.

```yaml
- id: user_intervention
  type: pause
  prompt: "Provide your direction to continue the workflow."
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Unique step identifier |
| `type` | string | Yes | Must be `"pause"` |
| `prompt` | string | No | Injected into the system prompt during the pause |

## Validation Rules

The engine validates workflow graphs at start time:

1. **Transition target existence:** All `transitions.*.target` values must match
   existing step IDs.
2. **Reachability:** All steps must be reachable from the first step.
3. **Self-loop protection:** Conditional steps with self-transitions must have
   `loop_max > 0`.
4. **Cycle protection:** Every cycle in the graph must contain at least one
   conditional step with `loop_max`.

## Reserved Names

The following cannot be used as workflow filenames (they conflict with
subcommands): `pause`, `resume`, `abort`, `status`, `list`.

## Complete Example

```yaml
name: plan-build-review
description: "Plan, implement, review, and commit changes"

steps:
  - id: planner
    agent: planner
    type: linear
    prompt: "Analyze requirements and produce a detailed implementation plan."

  - id: executor
    agent: executor
    type: linear
    prompt: "Implement the plan described in the previous step."

  - id: reviewer
    agent: reviewer
    type: conditional
    subagents:
      - security-reviewer
      - performance-reviewer
      - style-reviewer
    transitions:
      approved:
        target: committer
      changes_needed:
        target: executor
        message: "Review feedback: {{feedback}}"
      escalate:
        target: user_intervention
    loop_max: 5

  - id: committer
    agent: committer
    type: linear
    prompt: "Commit the changes with an appropriate commit message."

  - id: user_intervention
    type: pause
    prompt: "Workflow paused for user direction. Please provide guidance to continue."
```
