# Plan: Implement Subagent Support

## Objective

Expose agent definitions as callable tools ("subagents") that allow an active agent to invoke another agent with a scoped goal, receive its output as a tool result, and resume its own workflow — all without the permanent handoff that `switch_agent` performs. This implements GitHub Issue #3.

## Context

### Repository Layout
- `src/index.ts` — Main Pi extension entrypoint; registers `/agent` command, `switch_agent` tool, event handlers for `session_start`, `before_agent_start`, `session_shutdown`
- `src/agent-discovery.ts` — Agent discovery from `~/.pi/agent/agents/*.md`, `.pi/agents/*.md`, and legacy `prompts/` directories; parses YAML frontmatter via `parseFrontmatter()`
- `package.json` — Extension manifest with `pi.extensions` pointing to `./src/index.ts`
- README.md — User-facing documentation covering agent directory conventions, `/agent` command, and `switch_agent` tool

### Current Architecture
- Agents are discovered as Markdown files with YAML frontmatter (`description`) and a body `content` (role description)
- `switch_agent` tool performs a **permanent handoff**: updates `activeAgentName`, appends an `agent-state` entry, and the next `before_agent_start` injects the new agent's content into the system prompt
- There is **no call-and-return mechanism**: once `switch_agent` fires, the caller agent is gone

### Pi Extension API Constraints
- `pi.registerTool()` can dynamically register tools at runtime
- `pi.sendMessage()` / `pi.sendUserMessage()` can inject messages and trigger turns, but there is **no native "run subagent within same session" API**
- `before_agent_start` is a global event handler; it cannot target a specific turn as "subagent mode"
- Extensions **cannot directly invoke the LLM** — there is no `callLLM(systemPrompt, prompt)` API
- `ctx.newSession()` creates a **replacement** session (caller is lost), not a nested subagent session
- `pi.exec()` can spawn external processes synchronously from within a tool `execute()` handler

### Tree-of-Thought: Subagent Execution Strategies

**Path A: Separate Pi Process via RPC Mode**
- Spawn a new `pi` CLI process with `--mode rpc`, set the subagent's system prompt via `--system-prompt <agent-file>`, send the scoped goal as a `prompt` command over stdin, consume the JSONL event stream from stdout, and extract the final assistant response from the `agent_end` event
- Pros: True isolated subagent execution with correct system prompt; subagent can use tools (read, bash, etc.); accurate bounded execution via `turn_end` event counting; clean output extraction from structured `agent_end.messages`; natural timeout and abort support via `abort` command and `ctx.signal`
- Cons: Heavyweight; separate token billing; requires `pi` binary available in PATH; more complex JSONL client implementation
- Verdict: **Selected as MVP** — RPC mode is the richest subprocess-based approach available within current API constraints

**Path B: Prompt Injection / Simulation**
- Temporarily inject subagent content into `before_agent_start` for one turn, capture the assistant response, restore caller agent
- Pros: Lightweight; same session; no external process
- Cons: Cannot reliably "restore caller" after a single turn — `before_agent_start` fires for every turn indiscriminately; would require complex turn-tracking state machine that is fragile
- Verdict: Rejected — too fragile given current event model

**Path C: Wait for Pi Core Subagent API**
- Do nothing now; document the requirement for a future Pi core API
- Pros: Cleanest eventual architecture
- Cons: Delivers zero value now; timeline unknown
- Verdict: Partial — document what Pi core would need, but implement Path A as MVP

## Architectural Blueprint

### Phase 1: Metadata & Discovery
Extend `AgentDefinition` and agent frontmatter schema to declare subagent capability, tool parameters, and execution bounds.

### Phase 2: Dynamic Tool Registration
At extension load and on `/reload`, discover all agents marked `subagent: true` and register each as a Pi tool via `pi.registerTool()`. The tool name is derived from the agent name (e.g., `invoke_reviewer`).

### Phase 3: Subagent Tool Execution via RPC
When a subagent tool is called:
1. Validate the target agent exists and is subagent-capable
2. Enforce guardrails (depth limit, max turns / timeout)
3. Spawn a `pi` CLI process with `--mode rpc --system-prompt <agent-file> --no-session`
4. Send JSON commands over stdin:
   - `prompt` with the scoped goal
   - `abort` if timeout or `ctx.signal` fires
5. Consume JSONL events from stdout, tracking `turn_end` events for max-turns enforcement
6. On `agent_end`, extract the assistant's response text from `messages`
7. Kill the RPC process and return the response text as the tool result

### Phase 4: Guardrails & Polish
- Depth tracking (prevent nested subagent loops)
- Configurable timeout and max-turns enforcement via CLI flags
- Self-invocation prevention
- Clean error handling for missing binary, timeout, or agent-not-found

### Phase 5: Documentation
- README section on subagent usage
- Example agent frontmatter with `subagent: true` and `tool_schema`
- Example: Planner calling Reviewer as subagent

## Requirements

1. Agent frontmatter supports `subagent: true` to mark an agent as callable as a subagent [explicit]
2. Agent frontmatter supports optional `tool_schema` field declaring tool parameters (e.g., `goal`, `files_to_review`) [explicit]
3. Subagent-capable agents are auto-registered as Pi tools at extension load and on reload [explicit]
4. An agent can invoke another agent via the generated tool call [explicit]
5. Subagent execution is bounded by timeout (enforced via `AbortSignal` + process kill) and max turns (enforced by counting `turn_end` events in the RPC stream) [explicit]
6. Subagent output is returned to caller as a tool result text block [explicit]
7. Caller agent identity, history, and context are preserved (process isolation guarantees this) [explicit]
8. Nested subagent depth is limited to prevent infinite loops [inferred]
9. Subagent tool registration is refreshed on `/reload` [inferred]
10. Subagent tool names must not collide with existing tools or the `switch_agent` tool [inferred]

## Task Breakdown

### Task 1: Extend Agent Frontmatter Schema
- **Goal**: Add `subagent`, `tool_schema`, and `tool_name` fields to agent definitions.
- **Dependencies**: None.
- **Files Affected**: `src/agent-discovery.ts`
- **New Files**: None.
- **Interfaces**:
  ```typescript
  interface AgentDefinition {
    name: string;
    path: string;
    description: string;
    content: string;
    subagent?: boolean;
    toolName?: string;          // override derived tool name
    toolSchema?: ToolParameter[]; // params beyond the default "goal"
  }

  interface ToolParameter {
    name: string;
    type: "string" | "number" | "boolean";
    description: string;
    required?: boolean;
  }
  ```
- **Details**: Update `discoverAgents()` to parse `subagent`, `tool_name`, and `tool_schema` from YAML frontmatter. If `tool_name` is absent, derive it as `invoke_${agentName}` with kebab-case normalization. Store the parsed fields in `AgentDefinition`.

### Task 2: Build TypeBox Schema from Agent Tool Schema
- **Goal**: Convert `toolSchema` into a `typebox` `Type.Object()` schema for dynamic tool registration.
- **Dependencies**: Task 1.
- **Files Affected**: `src/index.ts` (or new `src/subagent-tools.ts`)
- **New Files**: `src/subagent-tools.ts`
- **Interfaces**: `function buildSubagentToolSchema(agent: AgentDefinition): TObject`
- **Details**: Map custom `toolSchema` fields plus a mandatory `goal: Type.String()` into a TypeBox object. Handle `string`, `number`, and `boolean` types. Required fields become `Type.String()` (no `Type.Optional()`).

### Task 3: Register Subagent Tools at Extension Load
- **Goal**: After agent discovery, auto-register each `subagent: true` agent as a Pi tool.
- **Dependencies**: Task 1, Task 2.
- **Files Affected**: `src/index.ts`
- **New Files**: None.
- **Interfaces**:
  ```typescript
  pi.registerTool({
    name: derivedToolName,
    label: `Invoke ${agentName}`,
    description: agent.description || `Invoke ${agentName} as a subagent`,
    promptSnippet: `Invoke ${agentName} with a scoped goal`,
    parameters: builtSchema,
    execute: subagentExecuteFactory(agent),
  });
  ```
- **Details**: Call registration inside a new helper `registerSubagentTools(pi, agents)` invoked after `discoverAgents()` in the `session_start` handler and also from a `/reload` listener (if available; otherwise rely on `session_shutdown` cache clearing). Ensure no collisions: skip registration if `pi.getAllTools()` already contains the derived name.

### Task 4: Implement Subagent Tool Execution via RPC Mode
- **Goal**: Spawn a `pi --mode rpc` child process, drive it via JSONL commands, and extract the subagent's final response.
- **Dependencies**: Task 3.
- **Files Affected**: `src/subagent-tools.ts` (or `src/index.ts`)
- **New Files**: `src/subagent-tools.ts`, `src/rpc-client.ts`
- **Interfaces**:
  ```typescript
  // Lightweight JSONL RPC client for subagent invocation
  class PiRpcClient {
    constructor(args: string[], options: SpawnOptions);
    async start(): Promise<void>;
    async sendPrompt(message: string): Promise<void>;
    async abort(): Promise<void>;
    async waitForCompletion(options: { signal?: AbortSignal; timeoutMs: number; maxTurns?: number }): Promise<AgentEndEvent>;
    kill(): void;
  }

  async function executeSubagent(
    agent: AgentDefinition,
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
    maxTurns: number,
  ): Promise<{ output: string; turnCount: number; timedOut: boolean }>
  ```
- **Details**:
  1. Read the agent's content from `agent.path` (or use `agent.content` if in-memory)
  2. Compose the prompt: combine `goal` + any additional `toolSchema` parameters into a single prompt string
  3. Spawn `pi` with `child_process.spawn("pi", ["--mode", "rpc", "--system-prompt", agent.path, "--no-session"], { stdio: ["pipe", "pipe", "pipe"] })`
  4. Implement `PiRpcClient` in `src/rpc-client.ts`:
     - **Stdin**: write JSON commands (`prompt`, `abort`) followed by `\n`
     - **Stdout**: read JSONL lines, parse each as `RpcEvent`
     - **Event handling**: track `turn_start`/`turn_end` for turn counting; on `agent_end`, capture `messages` array
     - **Cancellation**: listen to `signal` and send `abort`; also kill the process on timeout
  5. Extract the assistant's response from the last `assistant` message in `agent_end.messages`
  6. If `maxTurns` is exceeded, send `abort` and return an error result
  7. If the process exits without `agent_end`, return an error result
  8. If `pi` binary is not found, return a graceful error
  9. Return the extracted text as the subagent response

### Task 5: Add Guardrails (Depth Limit, Timeout, Self-Invocation)
- **Goal**: Prevent runaway subagent invocations.
- **Dependencies**: Task 4.
- **Files Affected**: `src/subagent-tools.ts`, `src/index.ts`
- **New Files**: None.
- **Interfaces**:
  ```typescript
  const MAX_SUBAGENT_DEPTH = 3;
  ```
- **Details**:
  1. Track subagent depth via an `AsyncLocalStorage` or module-level `subagentDepth` counter incremented/decremented around `executeSubagent`
  2. If `depth > MAX_SUBAGENT_DEPTH`, return error: "Subagent depth limit exceeded"
  3. Register a new CLI flag `subagent-timeout` with default `60000` (ms)
  4. If a subagent tries to invoke itself (name matches active agent and `switch_agent`-style self-check), return error
  5. On timeout, return error result with `isError: true`

### Task 6: Refresh Subagent Tools on `/reload`
- **Goal**: Ensure newly added/removed subagent agents are reflected without restarting Pi.
- **Dependencies**: Task 3.
- **Files Affected**: `src/index.ts`
- **New Files**: None.
- **Details**: In the existing `session_shutdown` handler (which already calls `clearAgentCache()`), also clear any registered subagent tool state. On the next `session_start`, `discoverAgents()` will re-run and `registerSubagentTools()` will re-register. Note: Pi may require re-binding; if `pi.registerTool()` at runtime causes immediate refresh (per docs), this should work.

### Task 7: Update README with Subagent Documentation
- **Goal**: Document how to declare, invoke, and configure subagents.
- **Dependencies**: Task 1–Task 5.
- **Files Affected**: `README.md`
- **New Files**: None.
- **Details**: Add a "Subagents" section covering:
  - Adding `subagent: true` and `tool_schema` to agent frontmatter
  - Example: Planner invoking Reviewer
  - Distinction from `switch_agent` (permanent handoff vs. call-and-return)
  - CLI flags: `--subagent-timeout`, `--agent-switch-confirm`
  - Guardrails: depth limits, timeout

### Task 8: Update Agent Discovery Unit / Integration Tests
- **Goal**: Verify subagent frontmatter parsing and tool schema generation.
- **Dependencies**: Task 1, Task 2.
- **Files Affected**: `src/agent-discovery.ts`
- **New Files**: `tests/agent-discovery.test.ts` (if test infrastructure exists; otherwise manual verification)
- **Details**: If the project has a test runner (jest, vitest), add tests for `discoverAgents()` parsing `subagent`, `tool_name`, and `tool_schema`. Otherwise, verify manually with sample `.pi/agents/reviewer.md`.

## Dependency Graph

- Task 1 → Task 2 (Task 2 parses schema discovered in Task 1)
- Task 1 → Task 3 (Task 3 registers tools for agents discovered in Task 1)
- Task 2 → Task 3 (Task 3 uses schemas built in Task 2)
- Task 3 → Task 4 (Task 4 implements the execute handler for tools registered in Task 3)
- Task 4 → Task 5 (Task 5 wraps Task 4 with guardrails)
- Task 3 → Task 6 (Task 6 refreshes what Task 3 registers)
- Task 5 → Task 7 (Task 7 documents guardrails from Task 5)
- Task 1 || Task 8 (Task 8 tests Task 1; parallelizable)

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| `pi` binary not in PATH during subagent spawn | High | Medium | Check `which pi` or `pi --version` before spawning; return graceful error with install instructions |
| Token cost double-billing (caller + subagent process) | Medium | High | Document clearly in README; allow `--subagent-dry-run` flag that returns composed prompt instead of spawning |
| `pi.exec()` timeout or cancellation not propagated cleanly to child process | Medium | Medium | Pass `signal` explicitly; test with long-running subagent and Ctrl+C |
| Subagent tool name collision with built-in or other extension tools | Medium | Low | Prefix all subagent tools with `invoke_`; check `pi.getAllTools()` before registration; skip on collision |
| `registerTool()` at runtime does not immediately refresh tool list for current LLM context | High | Low | Test with live Pi session; if needed, call `pi.sendUserMessage("/reload")` after registration (documented workaround) |
| Nested depth tracking with concurrent parallel tool calls is unreliable | Medium | Medium | Use `AsyncLocalStorage` from `node:async_hooks` for per-execution-context depth rather than global counter |
| RPC JSONL protocol parsing errors or malformed events | Medium | Low | Validate each line is valid JSON before parsing; catch and return error result on parse failure |
| RPC subagent hangs waiting for tool call results (e.g., `bash` waiting for input) | High | Low | Use `--no-session` and ensure subagent tools don't require interactive input; enforce strict timeout |
| Concurrent subagent RPC processes exhaust system resources | Medium | Low | Limit concurrent subagents (1 per caller turn); depth guardrails help; document performance implications |

## Validation Criteria

- [ ] An agent file with `subagent: true` in frontmatter is discovered and appears as a callable tool in Pi's tool list
- [ ] Calling the subagent tool (e.g., `invoke_reviewer`) spawns a `pi` child process, returns output text, and the caller agent continues unchanged
- [ ] The caller agent's `activeAgentName` and session history are identical before and after the subagent call
- [ ] Exceeding `MAX_SUBAGENT_DEPTH` returns an error result instead of spawning another process
- [ ] Missing `pi` binary produces a clear error result, not a crash
- [ ] Timeout kills the child process and returns an error result
- [ ] README contains a working example of a Planner invoking a Reviewer subagent
- [ ] `/reload` causes newly added `subagent: true` agents to appear as tools without restarting Pi
