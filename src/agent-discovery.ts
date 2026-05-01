import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { readFile } from "node:fs/promises";

/** Naming convention for agent prompt templates. Overridable constant. */
const AGENT_NAME_PREFIX = "agent-";

/** Represents a discovered agent definition from a prompt template file. */
export interface AgentDefinition {
  /** Command name (e.g., "agent-planner") */
  name: string;
  /** Absolute path to the prompt template file */
  path: string;
  /** Description from frontmatter or Pi's command listing */
  description: string;
  /** Markdown body (frontmatter stripped) capturing the agent's role */
  content: string;
}

/** Module-level cache for discovered agents within a session. */
let agentCache: AgentDefinition[] | null = null;

/**
 * Discovers agent definitions from Pi's prompt directories.
 *
 * Primary path: uses `pi.getCommands()` to list all prompts and filters by
 * the `agent-*.md` naming convention. Reads each matched file, parses YAML
 * frontmatter, and extracts the full prompt body.
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

  const commands = pi.getCommands();
  const agentCommands = commands.filter(
    (cmd) => cmd.source === "prompt" && cmd.name.startsWith(AGENT_NAME_PREFIX),
  );

  const agents: AgentDefinition[] = [];

  for (const cmd of agentCommands) {
    try {
      const fileContent = await readFile(cmd.sourceInfo.path, "utf-8");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fileContent);

      const description =
        typeof frontmatter.description === "string"
          ? frontmatter.description
          : (cmd.description ?? "");

      agents.push({
        name: cmd.name,
        path: cmd.sourceInfo.path,
        description,
        content: body,
      });
    } catch (err) {
      console.error(
        `[pi-agents] Failed to read agent prompt ${cmd.sourceInfo.path}:`,
        err,
      );
    }
  }

  agentCache = agents;
  return agents;
}

/** Clears the agent discovery cache. */
export function clearAgentCache(): void {
  agentCache = null;
}
