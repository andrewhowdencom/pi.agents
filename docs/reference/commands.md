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
2. Validates the target agent has `"leader"` in its `role` (rejected with error if not)
3. Checks for self-switch (rejected with error)
4. Prompts user for confirmation (unless non-interactive or flag override)
5. Updates the active agent in the status bar
6. Appends an `agent-state` entry to the session
7. Injects the new agent's content on the next `before_agent_start` event

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

### `list_agents`

List all available agents with their capabilities.

**Parameters:** _(none)_

**Example:**

```tool
list_agents()
```

**Result:**

```
- **planner**: Plans software architecture and implementation (role: leader, delegate)
- **reviewer**: Reviews code for risks and quality (role: delegate)
- **archived-legacy**: Old template agent (role: none)
```

**Behavior:**

1. Discovers all agents from `.pi/agents/*.md` and legacy locations
2. Returns a markdown-formatted list of agents with their `role` array
3. The structured `details.agents` array is also available for programmatic use

### `list_delegates`

List all agents that can be invoked as delegates.

**Parameters:** _(none)_

**Example:**

```tool
list_delegates()
```

**Behavior:**

1. Discovers all agents and filters for those with `"delegate"` in their `role`
2. Returns a markdown-formatted list with model information (if configured)
3. The structured `details.delegates` array includes full metadata for selection

### `delegate_agent`

Invoke a delegate agent to perform a scoped task and return its output. The
caller agent resumes after the delegate completes.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `agent` | string | Yes | Name of the delegate agent to invoke |
| `goal` | string | Yes | The scoped goal or task for the delegate |

**Example:**

```tool
delegate_agent(agent="reviewer", goal="Review the authentication module for security risks")
```

**Behavior:**

1. Validates the target agent exists and has `"delegate"` in its `role`
2. Checks for self-invocation guardrail (rejected with error)
3. Checks delegate nesting depth limit (3 levels max)
4. Checks workflow step approval (if in a workflow step with a `delegates` list)
5. Spawns the delegate agent via RPC with the provided goal
6. Returns the delegate's final output in the tool result
7. The caller agent resumes its own workflow after receiving the result

**Tool Result Details:**

The tool result includes the following in `details`:

| Field | Type | Description |
|---|---|---|
| `turnCount` | number | Number of turns the delegate executed |
| `timedOut` | boolean | Whether the delegate hit the timeout limit |
| `delegateDepth` | number | Nesting depth of this delegate invocation |
| `usage` | object | Cumulative token usage and cost |

## CLI Flags

| Flag | Type | Default | Description |
|---|---|---|---|
| `--agent-switch-confirm` | boolean | `true` | Confirm before agent-initiated agent switches |
| `--workflow-confirm` | boolean | `false` | Confirm before starting a workflow |

## Reserved Keywords

The following cannot be used as workflow names: `pause`, `resume`, `abort`,
`status`, `list`.
