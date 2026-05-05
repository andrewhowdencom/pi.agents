import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface SearchPath {
  path: string;
  isNewLocation: boolean;
  scope: string;
}

function getAgentSearchPaths(cwd: string): SearchPath[] {
  return [
    {
      path: join(homedir(), ".pi", "agent", "agents"),
      isNewLocation: true,
      scope: "global",
    },
    {
      path: join(cwd, ".pi", "agents"),
      isNewLocation: true,
      scope: "project",
    },
    {
      path: join(homedir(), ".pi", "agent", "prompts"),
      isNewLocation: false,
      scope: "global",
    },
    {
      path: join(cwd, ".pi", "prompts"),
      isNewLocation: false,
      scope: "project",
    },
  ];
}

/** Parameter declaration for a delegate tool schema. */
export interface ToolParameter {
  /** Parameter name */
  name: string;
  /** Parameter type */
  type: "string" | "number" | "boolean";
  /** Human-readable description for the LLM */
  description: string;
  /** Whether the parameter is required */
  required?: boolean;
}

/** Represents a discovered agent definition from an agent file. */
export interface AgentDefinition {
  /** Agent name (e.g., "planner") */
  name: string;
  /** Absolute path to the agent file */
  path: string;
  /** Description from frontmatter */
  description: string;
  /** Markdown body (frontmatter stripped) capturing the agent's role */
  content: string;
  /** Capabilities of this agent: "leader" (can be switched to) and/or "delegate" (can be invoked as a delegate) */
  role: ("leader" | "delegate")[];
  /** Override for the generated tool name (default: invoke_{kebab-case name}) — deprecated, unused with unified delegate_agent */
  toolName?: string;
  /** Additional tool parameters beyond the default `goal` */
  toolSchema?: ToolParameter[];
  /** LLM model for this delegate (e.g. "anthropic/claude-sonnet-4") */
  model?: string;
  /** RPC idle-timeout in milliseconds. When not specified, defaults to 60000ms (60 seconds). The timer resets on every stdout event; only subagents that go silent for this duration are killed. */
  timeout?: number;
  /** Maximum turns before forcible stop. When not specified, the delegate runs until completion (no limit). */
  maxTurns?: number;
}

/** Module-level cache for discovered agents within a session. */
let agentCache: AgentDefinition[] | null = null;

/**
 * Discovers agent definitions from dedicated agents/ directories and legacy
 * prompts/ directories (backward compatibility).
 *
 * New locations (preferred): `~/.pi/agent/agents/*.md` and `.pi/agents/*.md`
 * Legacy locations: `~/.pi/agent/prompts/agent-*.md` and `.pi/prompts/agent-*.md`
 *
 * Reads each matched file, parses YAML frontmatter, and extracts the full
 * prompt body.
 *
 * The content field is used during handoff summarization to understand each
 * agent's role, and is injected into the system prompt by the
 * `before_agent_start` handler in the main extension when that agent is
 * active.
 */
export async function discoverAgents(
  pi: ExtensionAPI,
  _cwd: string,
): Promise<AgentDefinition[]> {
  if (agentCache !== null) {
    return agentCache;
  }

  const searchPaths = getAgentSearchPaths(_cwd);
  const agentsByName = new Map<string, AgentDefinition>();

  for (const searchPath of searchPaths) {
    let entries;
    try {
      entries = await readdir(searchPath.path, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or isn't readable — skip
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const filePath = join(searchPath.path, entry.name);

      // Old locations only include agent-*.md files
      if (!searchPath.isNewLocation && !entry.name.startsWith("agent-")) {
        continue;
      }

      let agentName: string;
      if (searchPath.isNewLocation) {
        agentName = entry.name.slice(0, -3); // strip .md
      } else {
        agentName = entry.name.slice(6, -3); // strip "agent-" and ".md"
      }

      // Skip if already discovered from a preferred (new) location
      if (agentsByName.has(agentName)) {
        if (!searchPath.isNewLocation) {
          console.warn(
            `[pi-agents] Legacy agent "${entry.name}" in ${searchPath.path} shadowed by agent in preferred location`,
          );
        }
        continue;
      }

      try {
        const fileContent = await readFile(filePath, "utf-8");
        const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fileContent);

        const description =
          typeof frontmatter.description === "string"
            ? frontmatter.description
            : "";

        // Parse role field (primary)
        let role: ("leader" | "delegate")[] | undefined;

        if (Array.isArray(frontmatter.role)) {
          role = frontmatter.role
            .filter((r): r is string => typeof r === "string")
            .map((r) => r.toLowerCase())
            .filter(
              (r): r is "leader" | "delegate" =>
                r === "leader" || r === "delegate",
            );
        } else if (typeof frontmatter.role === "string") {
          const r = frontmatter.role.toLowerCase();
          if (r === "leader" || r === "delegate") {
            role = [r];
          } else {
            role = [];
          }
        }

        // Fallback to deprecated boolean fields when role is not explicitly set
        if (!role) {
          role = ["leader"]; // default: all agents are leaders

          if (frontmatter.lead === false || frontmatter.lead === "false") {
            role = role.filter((r) => r !== "leader");
          }

          if (
            frontmatter.delegate === true ||
            frontmatter.delegate === "true"
          ) {
            if (!role.includes("delegate")) role.push("delegate");
          }

          if (
            frontmatter.subagent === true ||
            frontmatter.subagent === "true"
          ) {
            if (!role.includes("delegate")) role.push("delegate");
          }

          const deprecatedKeys: string[] = [];
          if (frontmatter.lead !== undefined) deprecatedKeys.push("lead");
          if (frontmatter.delegate !== undefined)
            deprecatedKeys.push("delegate");
          if (frontmatter.subagent !== undefined)
            deprecatedKeys.push("subagent");

          if (deprecatedKeys.length > 0) {
            console.warn(
              `[pi-agents] Agent "${agentName}" uses deprecated frontmatter key(s) ${deprecatedKeys.join(", ")}. Use "role" instead (e.g., role: [leader, delegate]).`,
            );
          }
        } else if (
          frontmatter.lead !== undefined ||
          frontmatter.delegate !== undefined ||
          frontmatter.subagent !== undefined
        ) {
          console.warn(
            `[pi-agents] Agent "${agentName}" has both "role" and deprecated keys (lead, delegate, subagent). "role" takes precedence.`,
          );
        }

        const toolName =
          typeof frontmatter.tool_name === "string" && frontmatter.tool_name
            ? frontmatter.tool_name
            : `invoke_${agentName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

        const model =
          typeof frontmatter.model === "string" && frontmatter.model
            ? frontmatter.model
            : undefined;

        let timeout: number | undefined;
        if (typeof frontmatter.timeout === "number") {
          timeout = frontmatter.timeout;
        } else if (
          typeof frontmatter.timeout === "string" &&
          frontmatter.timeout
        ) {
          const parsed = parseInt(frontmatter.timeout, 10);
          timeout = isNaN(parsed) ? undefined : parsed;
        }

        let maxTurns: number | undefined;
        if (typeof frontmatter.max_turns === "number") {
          maxTurns = frontmatter.max_turns;
        } else if (
          typeof frontmatter.max_turns === "string" &&
          frontmatter.max_turns
        ) {
          const parsed = parseInt(frontmatter.max_turns, 10);
          maxTurns = isNaN(parsed) ? undefined : parsed;
        }

        let toolSchema: ToolParameter[] | undefined;
        if (
          Array.isArray(frontmatter.tool_schema) &&
          frontmatter.tool_schema.every(
            (p: unknown) =>
              typeof p === "object" &&
              p !== null &&
              "name" in p &&
              typeof (p as Record<string, unknown>).name === "string" &&
              "type" in p &&
              typeof (p as Record<string, unknown>).type === "string" &&
              "description" in p &&
              typeof (p as Record<string, unknown>).description === "string",
          )
        ) {
          toolSchema = (frontmatter.tool_schema as ToolParameter[]).map(
            (p) => ({
              name: p.name,
              type: ["string", "number", "boolean"].includes(p.type)
                ? p.type
                : "string",
              description: p.description,
              required: p.required === true,
            }),
          );
        }

        agentsByName.set(agentName, {
          name: agentName,
          path: filePath,
          description,
          content: body,
          role,
          toolName,
          toolSchema,
          model,
          timeout,
          maxTurns,
        });
      } catch (err) {
        console.error(
          `[pi-agents] Failed to read agent file ${filePath}:`,
          err,
        );
      }
    }
  }

  const agents = Array.from(agentsByName.values());
  agentCache = agents;
  return agents;
}

/** Clears the agent discovery cache. */
export function clearAgentCache(): void {
  agentCache = null;
}
