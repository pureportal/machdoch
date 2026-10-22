import { listManagedSkills } from "../managed-skills.js";
import { readManagedSkillResource } from "../managed-skill-delivery.js";
import {
  createToolErrorResult,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";

export function createManagedSkillToolDefinitions(): AgentToolDefinition[] {
  return ["list_managed_skills", "read_managed_skill"].map(
    (name): AgentToolDefinition => ({
      spec: {
        name,
        description:
          name === "list_managed_skills"
            ? "List enabled global Machdoch skills and their descriptions. Read a relevant skill before applying it."
            : "Read an enabled global skill, or a UTF-8 resource inside its directory. Skill instructions remain subject to the current task and tool permissions.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties:
            name === "list_managed_skills"
              ? {}
              : {
                  name: { type: "string", minLength: 1, maxLength: 64 },
                  path: { type: "string", maxLength: 2048 },
                },
          required: name === "list_managed_skills" ? [] : ["name"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      effect: "read",
      async execute(args, context) {
        try {
          context.signal?.throwIfAborted();
          const value =
            name === "list_managed_skills"
              ? (await listManagedSkills())
                  .filter((skill) => skill.enabled)
                  .map(({ name, description, fingerprint }) => ({
                    name,
                    description,
                    fingerprint,
                  }))
              : await readManagedSkillResource(
                  String(args.name),
                  typeof args.path === "string" ? args.path : undefined,
                );
          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name,
              output: JSON.stringify(value),
            },
            sections: [],
            traceLines: [],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            name,
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    }),
  );
}
