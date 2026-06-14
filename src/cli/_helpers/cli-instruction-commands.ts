import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import {
  generateInstructionFileWithAgent,
  type WritableInstructionScope,
  writeInstructionFile,
} from "../../core/instructions.js";
import type {
  CustomizationDiagnostic,
  DiscoveredInstruction,
  InstructionMode,
  InstructionScope,
} from "../../core/types.js";
import type { InstructionCliOptions, ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";
import { createDiscoveryOptions } from "./cli-output.js";

interface InstructionValidationResult {
  valid: boolean;
  diagnostics: CustomizationDiagnostic[];
}

const fail = (message: string): never => {
  throw new Error(message);
};

const normalizeLookupKey = (value: string): string => {
  return value.trim().replace(/\\/gu, "/").toLowerCase();
};

const inferInstructionScope = (
  instruction: DiscoveredInstruction,
): InstructionScope => {
  if (instruction.scope) {
    return instruction.scope;
  }

  return "workspace";
};

const getInstructionMode = (
  instruction: DiscoveredInstruction,
): InstructionMode => {
  if (instruction.mode) {
    return instruction.mode;
  }

  return instruction.kind === "always-on" ? "always" : "auto";
};

const getApplyToPatterns = (instruction: DiscoveredInstruction): string[] => {
  if (instruction.applyToPatterns && instruction.applyToPatterns.length > 0) {
    return instruction.applyToPatterns;
  }

  return instruction.applyTo ? [instruction.applyTo] : [];
};

const filterInstructionsByScope = (
  instructions: DiscoveredInstruction[],
  options: InstructionCliOptions,
): DiscoveredInstruction[] => {
  return options.scope
    ? instructions.filter(
        (instruction) => inferInstructionScope(instruction) === options.scope,
      )
    : instructions;
};

const filterDiagnosticsByInstructions = (
  diagnostics: CustomizationDiagnostic[] | undefined,
  instructions: DiscoveredInstruction[],
  options: InstructionCliOptions,
): CustomizationDiagnostic[] | undefined => {
  if (!options.scope || !diagnostics) {
    return diagnostics;
  }

  const instructionPaths = instructions.map((instruction) =>
    normalizeLookupKey(instruction.path),
  );

  return diagnostics.filter((diagnostic) => {
    if (!diagnostic.path) {
      return true;
    }

    const diagnosticPath = normalizeLookupKey(diagnostic.path);

    return instructionPaths.some((instructionPath) =>
      diagnosticPath.endsWith(instructionPath),
    );
  });
};

const getWritableInstructionScope = (
  scope: InstructionCliOptions["scope"],
): WritableInstructionScope | undefined => {
  if (!scope) {
    return undefined;
  }

  if (scope === "user" || scope === "workspace") {
    return scope;
  }

  return fail(
    "Compatibility instruction files are read-only; use user or workspace scope.",
  );
};

const findInstruction = (
  instructions: DiscoveredInstruction[],
  subject: string,
): DiscoveredInstruction => {
  const normalizedSubject = normalizeLookupKey(subject);
  const matches = instructions.filter((instruction) => {
    const candidates = [
      instruction.name,
      instruction.path,
      basename(instruction.path),
    ].map(normalizeLookupKey);

    return candidates.includes(normalizedSubject);
  });

  if (matches.length === 0) {
    return fail(`Instruction \`${subject}\` was not found.`);
  }

  if (matches.length > 1) {
    return fail(
      `Instruction \`${subject}\` is ambiguous. Use the file path instead.`,
    );
  }

  const match = matches[0];

  if (!match) {
    return fail(`Instruction \`${subject}\` was not found.`);
  }

  return match;
};

const loadInstructionRegistry = async (args: ParsedCliArgs) => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );

  const customizations = await discoverCustomizations(
    args.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );

  return {
    config,
    customizations,
  };
};

const createValidationResult = (
  instructions: DiscoveredInstruction[],
  discoveryDiagnostics: CustomizationDiagnostic[] | undefined,
): InstructionValidationResult => {
  const diagnostics = [...(discoveryDiagnostics ?? [])];
  const instructionsByName = new Map<string, DiscoveredInstruction[]>();

  for (const instruction of instructions) {
    const normalizedName = normalizeLookupKey(instruction.name);
    const existing = instructionsByName.get(normalizedName) ?? [];
    existing.push(instruction);
    instructionsByName.set(normalizedName, existing);

    if (instruction.body.trim().length === 0) {
      diagnostics.push({
        level: "warning",
        code: "empty-instruction-body",
        message: `Instruction "${instruction.name}" has an empty body.`,
        path: instruction.path,
      });
    }

    const mode = getInstructionMode(instruction);
    const applyToPatterns = getApplyToPatterns(instruction);

    if (
      (mode === "auto" || mode === "agent-requested") &&
      applyToPatterns.length === 0 &&
      instruction.keywords.length === 0 &&
      !instruction.description
    ) {
      diagnostics.push({
        level: "warning",
        code: "weak-instruction-activation",
        message: `Instruction "${instruction.name}" has no applyTo, keywords, or description metadata.`,
        path: instruction.path,
      });
    }
  }

  for (const [name, matches] of instructionsByName) {
    if (matches.length <= 1) {
      continue;
    }

    diagnostics.push({
      level: "warning",
      code: "duplicate-instruction-name",
      message: `Instruction name "${name}" is used by ${matches.length} files.`,
    });
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.level !== "error"),
    diagnostics,
  };
};

const resolvePromptFilePath = (workspaceRoot: string, filePath: string): string => {
  return isAbsolute(filePath) ? filePath : resolve(workspaceRoot, filePath);
};

const readInstructionBodyFromCli = async (
  args: ParsedCliArgs,
  options: InstructionCliOptions,
): Promise<string> => {
  return options.promptFile
    ? await readFile(
        resolvePromptFilePath(args.workspaceRoot, options.promptFile),
        "utf8",
      )
    : options.prompt ?? fail("No instruction body was provided.");
};

const writeInstructionFromCli = async (
  args: ParsedCliArgs,
  options: InstructionCliOptions,
  overwrite: boolean,
) => {
  const name =
    options.name?.trim() ??
    options.subject?.trim() ??
    fail("No instruction name was provided.");
  const body = await readInstructionBodyFromCli(args, options);
  const scope = getWritableInstructionScope(options.scope);

  return writeInstructionFile(
    args.workspaceRoot,
    {
      name,
      body,
      ...(scope ? { scope } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.audience ? { audience: options.audience } : {}),
      ...(options.applyTo ? { applyTo: options.applyTo } : {}),
      ...(options.exclude ? { exclude: options.exclude } : {}),
      ...(options.keywords ? { keywords: options.keywords } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
    },
    {
      ...(options.path ? { path: options.path } : {}),
      overwrite,
    },
  );
};

const printInstructionList = (
  instructions: DiscoveredInstruction[],
): void => {
  writeStdoutLine(`instructions: ${instructions.length}`);

  for (const instruction of instructions) {
    const scope = inferInstructionScope(instruction);
    const mode = getInstructionMode(instruction);
    const applyToPatterns = getApplyToPatterns(instruction);
    const metadata = [
      `scope=${scope}`,
      `mode=${mode}`,
      instruction.audience ? `audience=${instruction.audience}` : undefined,
      instruction.priority !== undefined
        ? `priority=${instruction.priority}`
        : undefined,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join(", ");

    writeStdoutLine(`  - ${instruction.name} (${instruction.path})`);
    writeStdoutLine(`    ${metadata}`);

    if (applyToPatterns.length > 0) {
      writeStdoutLine(`    applyTo: ${applyToPatterns.join(", ")}`);
    }

    if (instruction.excludePatterns && instruction.excludePatterns.length > 0) {
      writeStdoutLine(`    exclude: ${instruction.excludePatterns.join(", ")}`);
    }

    if (instruction.keywords.length > 0) {
      writeStdoutLine(`    keywords: ${instruction.keywords.join(", ")}`);
    }
  }
};

const printInstructionDetails = (instruction: DiscoveredInstruction): void => {
  writeStdoutLine(`name: ${instruction.name}`);
  writeStdoutLine(`path: ${instruction.path}`);
  writeStdoutLine(`scope: ${inferInstructionScope(instruction)}`);
  writeStdoutLine(`mode: ${getInstructionMode(instruction)}`);

  if (instruction.audience) {
    writeStdoutLine(`audience: ${instruction.audience}`);
  }

  if (instruction.priority !== undefined) {
    writeStdoutLine(`priority: ${instruction.priority}`);
  }

  const applyToPatterns = getApplyToPatterns(instruction);

  if (applyToPatterns.length > 0) {
    writeStdoutLine(`applyTo: ${applyToPatterns.join(", ")}`);
  }

  if (instruction.excludePatterns && instruction.excludePatterns.length > 0) {
    writeStdoutLine(`exclude: ${instruction.excludePatterns.join(", ")}`);
  }

  if (instruction.keywords.length > 0) {
    writeStdoutLine(`keywords: ${instruction.keywords.join(", ")}`);
  }

  writeStdoutLine("");
  writeStdoutLine(instruction.body);
};

export const printInstructionSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const options = args.instructions ?? fail("No instruction command was provided.");

  if (options.action === "create" || options.action === "save") {
    const created = await writeInstructionFromCli(
      args,
      options,
      options.action === "save",
    );

    if (args.json) {
      writeStdoutLine(JSON.stringify(created, null, 2));
      return;
    }

    writeStdoutLine(
      `${created.created ? "created" : "updated"} ${created.scope} instruction: ${created.path}`,
    );
    return;
  }

  if (options.action === "generate") {
    const name =
      options.name?.trim() ??
      options.subject?.trim() ??
      fail("No instruction name was provided.");
    const prompt = options.promptFile
      ? await readFile(
          resolvePromptFilePath(args.workspaceRoot, options.promptFile),
          "utf8",
        )
      : options.prompt ?? fail("No instruction generation prompt was provided.");
    const scope = getWritableInstructionScope(options.scope);
    const result = await generateInstructionFileWithAgent(args.workspaceRoot, {
      name,
      prompt,
      ...(scope ? { scope } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.audience ? { audience: options.audience } : {}),
      ...(options.applyTo ? { applyTo: options.applyTo } : {}),
      ...(options.exclude ? { exclude: options.exclude } : {}),
      ...(options.keywords ? { keywords: options.keywords } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
      ...(options.path ? { path: options.path } : {}),
    });

    if (args.json) {
      writeStdoutLine(JSON.stringify(result, null, 2));
      return;
    }

    writeStdoutLine(result.summary);
    if (result.validation.diagnostics.length > 0) {
      writeStdoutLine(`diagnostics: ${result.validation.diagnostics.length}`);

      for (const diagnostic of result.validation.diagnostics) {
        writeStdoutLine(
          `  - [${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}`,
        );
      }
    }
    return;
  }

  const { customizations } = await loadInstructionRegistry(args);
  const scopedInstructions = filterInstructionsByScope(
    customizations.instructions,
    options,
  );
  const validation = createValidationResult(
    scopedInstructions,
    filterDiagnosticsByInstructions(
      customizations.diagnostics,
      scopedInstructions,
      options,
    ),
  );

  if (options.action === "validate") {
    if (args.json) {
      writeStdoutLine(JSON.stringify(validation, null, 2));
      return;
    }

    writeStdoutLine(`valid: ${validation.valid ? "true" : "false"}`);
    writeStdoutLine(`diagnostics: ${validation.diagnostics.length}`);

    for (const diagnostic of validation.diagnostics) {
      writeStdoutLine(
        `  - [${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}`,
      );

      if (diagnostic.path) {
        writeStdoutLine(`    path: ${diagnostic.path}`);
      }
    }

    return;
  }

  if (options.action === "show") {
    const subject = options.subject ?? fail("No instruction subject was provided.");
    const instruction = findInstruction(scopedInstructions, subject);

    if (args.json) {
      writeStdoutLine(JSON.stringify(instruction, null, 2));
      return;
    }

    printInstructionDetails(instruction);
    return;
  }

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: customizations.workspaceRoot,
          instructions: scopedInstructions,
          diagnostics: validation.diagnostics,
        },
        null,
        2,
      ),
    );
    return;
  }

  printInstructionList(scopedInstructions);
};
