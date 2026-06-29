import { getHelpText, parseCliArgs } from "./_helpers/cli-args.js";
import { writeStdoutLine } from "./_helpers/cli-io.js";
import {
  printConfigSummary,
  printCustomizationSummary,
  printDefaultModelSummary,
  printSetApiSummary,
  printSetConfigSummary,
  printSetGlobalMemorySummary,
  printToolSummary,
} from "./_helpers/cli-summary-commands.js";
import {
  printTaskPreview,
  runInteractiveChat,
} from "./_helpers/cli-task-run.js";
import { printInstructionSummary } from "./_helpers/cli-instruction-commands.js";
import { printMcpSummary } from "./_helpers/cli-mcp-commands.js";
import { printRalphSummary } from "./_helpers/cli-ralph-commands.js";
import { printSchedulerSummary } from "./_helpers/cli-scheduler-commands.js";

export const runCli = async (argv: string[]): Promise<void> => {
  const args = parseCliArgs(argv);

  switch (args.command) {
    case "help": {
      writeStdoutLine(getHelpText());
      return;
    }
    case "set-api": {
      await printSetApiSummary(args);
      return;
    }
    case "set-config": {
      await printSetConfigSummary(args);
      return;
    }
    case "set-global-memory": {
      await printSetGlobalMemorySummary(args);
      return;
    }
    case "set-default-model": {
      await printDefaultModelSummary(args);
      return;
    }
    case "config": {
      await printConfigSummary(args);
      return;
    }
    case "chat": {
      await runInteractiveChat(args);
      return;
    }
    case "inspect": {
      await printCustomizationSummary(args);
      return;
    }
    case "instructions": {
      await printInstructionSummary(args);
      return;
    }
    case "tools": {
      await printToolSummary(args);
      return;
    }
    case "ralph": {
      await printRalphSummary(args);
      return;
    }
    case "scheduler": {
      await printSchedulerSummary(args);
      return;
    }
    case "mcp": {
      await printMcpSummary(args);
      return;
    }
    case "run": {
      await printTaskPreview(args);
      return;
    }
  }
};
