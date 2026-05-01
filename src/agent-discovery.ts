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

        agentsByName.set(agentName, {
          name: agentName,
          path: filePath,
          description,
          content: body,
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
