import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  type WorkflowDefinition,
  type DiscoveredWorkflow,
  isReservedWorkflowName,
  type WorkflowStep,
} from "./workflow-types.js";

interface SearchPath {
  path: string;
  scope: string;
}

function getWorkflowSearchPaths(cwd: string): SearchPath[] {
  return [
    {
      path: join(homedir(), ".pi", "agent", "workflows"),
      scope: "global",
    },
    {
      path: join(cwd, ".pi", "workflows"),
      scope: "project",
    },
  ];
}

/** Module-level cache for discovered workflows within a session. */
let workflowCache: DiscoveredWorkflow[] | null = null;

function validateStep(
  step: unknown,
  index: number,
  workflowName: string,
): WorkflowStep | null {
  if (!step || typeof step !== "object") {
    console.warn(
      `[pi-agents] Workflow "${workflowName}": step ${index} is not an object, skipping`,
    );
    return null;
  }

  const s = step as Record<string, unknown>;

  if (typeof s.id !== "string" || !s.id) {
    console.warn(
      `[pi-agents] Workflow "${workflowName}": step ${index} missing or invalid "id", skipping`,
    );
    return null;
  }

  if (typeof s.type !== "string") {
    console.warn(
      `[pi-agents] Workflow "${workflowName}": step "${s.id}" missing "type", skipping`,
    );
    return null;
  }

  const type = s.type;

  if (type === "linear") {
    if (typeof s.agent !== "string" || !s.agent) {
      console.warn(
        `[pi-agents] Workflow "${workflowName}": linear step "${s.id}" missing "agent", skipping`,
      );
      return null;
    }
    return {
      id: s.id,
      agent: s.agent,
      type: "linear",
      prompt: typeof s.prompt === "string" ? s.prompt : undefined,
    };
  }

  if (type === "conditional") {
    if (typeof s.agent !== "string" || !s.agent) {
      console.warn(
        `[pi-agents] Workflow "${workflowName}": conditional step "${s.id}" missing "agent", skipping`,
      );
      return null;
    }

    if (!s.transitions || typeof s.transitions !== "object") {
      console.warn(
        `[pi-agents] Workflow "${workflowName}": conditional step "${s.id}" missing "transitions", skipping`,
      );
      return null;
    }

    const transitions = s.transitions as Record<string, unknown>;
    const parsedTransitions: Record<string, { target: string; message?: string }> = {};

    for (const [signal, t] of Object.entries(transitions)) {
      if (!t || typeof t !== "object") {
        console.warn(
          `[pi-agents] Workflow "${workflowName}": transition "${signal}" in step "${s.id}" is invalid, skipping`,
        );
        continue;
      }
      const tx = t as Record<string, unknown>;
      if (typeof tx.target !== "string" || !tx.target) {
        console.warn(
          `[pi-agents] Workflow "${workflowName}": transition "${signal}" in step "${s.id}" missing "target", skipping`,
        );
        continue;
      }
      parsedTransitions[signal] = {
        target: tx.target,
        message: typeof tx.message === "string" ? tx.message : undefined,
      };
    }

    if (Object.keys(parsedTransitions).length === 0) {
      console.warn(
        `[pi-agents] Workflow "${workflowName}": conditional step "${s.id}" has no valid transitions, skipping`,
      );
      return null;
    }

    let subagents: string[] | undefined;
    if (Array.isArray(s.subagents)) {
      subagents = s.subagents.filter((a): a is string => typeof a === "string");
    }

    let loopMax: number | undefined;
    if (typeof s.loop_max === "number") {
      loopMax = s.loop_max;
    } else if (typeof s.loop_max === "string" && s.loop_max) {
      const parsed = parseInt(s.loop_max, 10);
      if (!isNaN(parsed)) loopMax = parsed;
    }

    return {
      id: s.id,
      agent: s.agent,
      type: "conditional",
      prompt: typeof s.prompt === "string" ? s.prompt : undefined,
      subagents: subagents && subagents.length > 0 ? subagents : undefined,
      transitions: parsedTransitions,
      loop_max: loopMax,
      loop_message: typeof s.loop_message === "string" ? s.loop_message : undefined,
    };
  }

  if (type === "pause") {
    return {
      id: s.id,
      type: "pause",
      prompt: typeof s.prompt === "string" ? s.prompt : undefined,
    };
  }

  console.warn(
    `[pi-agents] Workflow "${workflowName}": step "${s.id}" has unknown type "${type}", skipping`,
  );
  return null;
}

/**
 * Discovers workflow definitions from .pi/workflows/*.yml and *.yaml,
 * and ~/.pi/agent/workflows/*.yml and *.yaml.
 *
 * Parses YAML, validates basic structure, and skips files with reserved names.
 * Agent existence validation is done separately at workflow start time.
 */
export async function discoverWorkflows(
  _pi: ExtensionAPI,
  cwd: string,
): Promise<DiscoveredWorkflow[]> {
  if (workflowCache !== null) {
    return workflowCache;
  }

  const searchPaths = getWorkflowSearchPaths(cwd);
  const workflowsByName = new Map<string, DiscoveredWorkflow>();

  for (const searchPath of searchPaths) {
    let entries;
    try {
      entries = await readdir(searchPath.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !(entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
        continue;
      }

      const workflowName = entry.name.replace(/\.ya?ml$/, ""); // strip .yml or .yaml

      if (isReservedWorkflowName(workflowName)) {
        console.warn(
          `[pi-agents] Workflow file "${entry.name}" uses reserved keyword "${workflowName}", skipping`,
        );
        continue;
      }

      // Project-local takes precedence over global
      if (workflowsByName.has(workflowName) && searchPath.scope === "global") {
        continue;
      }

      const filePath = join(searchPath.path, entry.name);

      try {
        const fileContent = await readFile(filePath, "utf-8");
        const parsed = parseYaml(fileContent) as Record<string, unknown>;

        if (!parsed || typeof parsed !== "object") {
          console.error(`[pi-agents] Workflow file ${filePath} is not a valid YAML object`);
          continue;
        }

        if (typeof parsed.name !== "string" || !parsed.name) {
          console.error(`[pi-agents] Workflow file ${filePath} missing "name" field`);
          continue;
        }

        if (!Array.isArray(parsed.steps)) {
          console.error(`[pi-agents] Workflow file ${filePath} missing or invalid "steps" array`);
          continue;
        }

        const steps: WorkflowStep[] = [];
        for (let i = 0; i < parsed.steps.length; i++) {
          const validated = validateStep(parsed.steps[i], i, parsed.name);
          if (validated) {
            steps.push(validated);
          }
        }

        if (steps.length === 0) {
          console.warn(`[pi-agents] Workflow file ${filePath} has no valid steps, skipping`);
          continue;
        }

        const definition: WorkflowDefinition = {
          name: parsed.name,
          description: typeof parsed.description === "string" ? parsed.description : undefined,
          version: typeof parsed.version === "string" ? parsed.version : undefined,
          steps,
        };

        workflowsByName.set(workflowName, {
          name: workflowName,
          path: filePath,
          definition,
        });
      } catch (err) {
        console.error(
          `[pi-agents] Failed to read or parse workflow file ${filePath}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  const workflows = Array.from(workflowsByName.values());
  workflowCache = workflows;
  return workflows;
}

/** Clears the workflow discovery cache. */
export function clearWorkflowCache(): void {
  workflowCache = null;
}
