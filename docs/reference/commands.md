# Commands and Tools

## Commands

Commands are user-initiated via the Pi command line.

### `/agent`

Select or switch the active agent.

| Usage | Description |
|---|---|
| `/agent` | Open the agent picker UI |
| `/agent <name>` | Select an agent directly by name |

**Examples:**

```
/agent          # Open picker
/agent planner  # Select "planner" directly
```

### `/workflow`

Manage multi-agent workflows.

| Usage | Description |
|---|---|
| `/workflow` | Show status if active; otherwise show workflow picker |
| `/workflow <name>` | Start a workflow by name |
| `/workflow <name> [prompt]` | Start a workflow by name with an optional initial prompt |
| `/workflow list` | Show picker with available workflows |
| `/workflow pause` | Pause the current workflow |
| `/workflow resume` | Resume a paused workflow |
| `/workflow abort` | Abort the current workflow with confirmation |
| `/workflow status` | Show detailed workflow status |

**Examples:**

```
/workflow plan-build-review                      # Start workflow
/workflow plan-build-review Build a REST API    # Start with initial prompt
/workflow pause                                  # Pause
/workflow resume                                 # Resume
/workflow abort                                  # Abort
```

When an initial prompt is provided, it is appended to the first step's
hardcoded `prompt` (if any). If the first step has no `prompt`, the initial
text becomes the entire message.

### `/chain`

Run an ad-hoc linear chain of agents without creating a YAML file.

| Usage | Description |
|---|---|
| `/chain <agent1> <agent2> ...` | Run a linear sequence with auto-transitions |

**Example:**

```
/chain planner executor reviewer committer
```

## Tools

Tools are agent-initiated via `tool` blocks in the conversation.

### `switch_agent`

Permanently transfer control to a different agent. The caller agent is replaced
and does not resume.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent` | string | Yes | Name of the target agent |
| `style` | enum | No | `"lightweight"` (default) or `"summarize"` |

**Example:**

```tool
switch_agent(agent="builder")
```

**Behavior:**

1. Validates the target agent exists in the discovered agents
2. Checks for self-switch (rejected with error)
3. Prompts user for confirmation (unless non-interactive or flag override)
4. Updates the active agent in the status bar
5. Appends an `agent-state` entry to the session
6. Injects the new agent's content on the next `before_agent_start` event

### `workflow_signal`

Signal the outcome of a workflow decision point to advance to the next step.
Only valid during conditional workflow steps.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `signal` | string | Yes | Transition signal name (must match a key in the step's `transitions`) |
| `feedback` | string | No | Optional feedback to pass to the next step |

**Example:**

```tool
workflow_signal(signal="approved")
workflow_signal(signal="changes_needed", feedback="Add more tests")
```

**Behavior:**

1. Validates that a workflow is active and the current step is conditional
2. Validates the signal against the step's `transitions` map
3. Records the signal and schedules the transition
4. Returns confirmation of the target step

## CLI Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--agent-switch-confirm` | boolean | `true` | Confirm before agent-initiated agent switches |
| `--workflow-confirm` | boolean | `true` | Confirm before starting a workflow |

## Reserved Keywords

The following cannot be used as workflow names: `pause`, `resume`, `abort`,
`status`, `list`.
