import process from "node:process";
import { getHelpText, parseCliArgs } from "./_helpers/cli-args.js";
import type { CommandName, ParsedCliArgs } from "./_helpers/cli-args.js";
import { writeStderrLine, writeStdoutLine } from "./_helpers/cli-io.js";
import { createCliStyle } from "./_helpers/cli-terminal.js";
import { readTaskFromStdin } from "./_helpers/cli-task-stdin.js";

const AGENT_RUNTIME_COMMANDS = new Set<CommandName>([
  "run",
  "chat",
  "interview",
  "ralph",
  "scheduler",
  "fleet",
]);

const closeAgentRuntimeResources = async (
  command: CommandName,
): Promise<void> => {
  if (!AGENT_RUNTIME_COMMANDS.has(command)) return;

  const [{ closeAllBrowserSessions }, { mcpClientManager }] = await Promise.all(
    [
      import("../core/_helpers/browser-tool-definitions.js"),
      import("../core/mcp/client.js"),
    ],
  );
  await Promise.all([closeAllBrowserSessions(), mcpClientManager.closeAll()]);
};

const runParsedCliCommand = async (args: ParsedCliArgs): Promise<void> => {
  const isInternalProviderProcess =
    args.command === "provider-sync" ||
    (args.command === "mcp" &&
      (args.mcp?.action === "proxy" ||
        args.mcp?.action === "broker" ||
        args.mcp?.action === "presence"));
  const isSideEffectFreeRalphValidation =
    args.command === "ralph" && args.ralph?.action === "validate-json";
  if (
    args.command !== "help" &&
    args.command !== "memory" &&
    !isInternalProviderProcess &&
    !isSideEffectFreeRalphValidation
  ) {
    const { ensureAutomaticProviderSync } =
      await import("./_helpers/cli-provider-sync-commands.js");
    await ensureAutomaticProviderSync(args.workspaceRoot).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const style = createCliStyle({ isTTY: process.stderr.isTTY === true });
        writeStderrLine(
          `${style.warning("Warning:")} provider synchronization failed: ${message}`,
        );
      },
    );
  }

  switch (args.command) {
    case "help": {
      writeStdoutLine(getHelpText(args.helpTopic));
      return;
    }
    case "set-api": {
      const { printSetApiSummary } =
        await import("./_helpers/cli-summary-commands.js");
      await printSetApiSummary(args);
      return;
    }
    case "set-global-memory": {
      const { printSetGlobalMemorySummary } =
        await import("./_helpers/cli-summary-commands.js");
      await printSetGlobalMemorySummary(args);
      return;
    }
    case "set-default-model": {
      const { printDefaultModelSummary } =
        await import("./_helpers/cli-summary-commands.js");
      await printDefaultModelSummary(args);
      return;
    }
    case "config": {
      const { runConfigCommand } =
        await import("./_helpers/cli-config-commands.js");
      await runConfigCommand(args);
      return;
    }
    case "memory": {
      const { printMemorySummary } =
        await import("./_helpers/cli-summary-commands.js");
      await printMemorySummary(args);
      return;
    }
    case "chat": {
      const { runInteractiveChat } = await import("./_helpers/cli-task-run.js");
      await runInteractiveChat(args);
      return;
    }
    case "interview": {
      const { printTaskInterviewSummary } =
        await import("./_helpers/cli-interview-commands.js");
      await printTaskInterviewSummary(args);
      return;
    }
    case "inspect": {
      const { printCustomizationSummary } =
        await import("./_helpers/cli-summary-commands.js");
      await printCustomizationSummary(args);
      return;
    }
    case "instructions": {
      const { printInstructionSummary } =
        await import("./_helpers/cli-instruction-commands.js");
      await printInstructionSummary(args);
      return;
    }
    case "tools": {
      const { printToolSummary } =
        await import("./_helpers/cli-summary-commands.js");
      await printToolSummary(args);
      return;
    }
    case "ralph": {
      const { printRalphSummary } =
        await import("./_helpers/cli-ralph-commands.js");
      await printRalphSummary(args);
      return;
    }
    case "scheduler": {
      const { printSchedulerSummary } =
        await import("./_helpers/cli-scheduler-commands.js");
      await printSchedulerSummary(args);
      return;
    }
    case "mcp": {
      const { printMcpSummary } =
        await import("./_helpers/cli-mcp-commands.js");
      await printMcpSummary(args);
      return;
    }
    case "provider-sync": {
      const { printProviderSyncSummary } =
        await import("./_helpers/cli-provider-sync-commands.js");
      await printProviderSyncSummary(args);
      return;
    }
    case "fleet": {
      const { printFleetSummary } =
        await import("./_helpers/cli-fleet-commands.js");
      await printFleetSummary(args);
      return;
    }
    case "run": {
      const { printTaskPreview } = await import("./_helpers/cli-task-run.js");
      await printTaskPreview(args);
      return;
    }
  }
};

export const runCli = async (argv: string[]): Promise<void> => {
  let args = parseCliArgs(argv);
  if (args.task === "-") {
    args = { ...args, task: await readTaskFromStdin() };
  }

  try {
    await runParsedCliCommand(args);
  } finally {
    await closeAgentRuntimeResources(args.command);
  }
};
