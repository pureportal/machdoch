import { getHelpText, parseCliArgs } from "./_helpers/cli-args.js";
import { writeStdoutLine } from "./_helpers/cli-io.js";

export const runCli = async (argv: string[]): Promise<void> => {
  const args = parseCliArgs(argv);

  switch (args.command) {
    case "help": {
      writeStdoutLine(getHelpText());
      return;
    }
    case "set-api": {
      const { printSetApiSummary } = await import(
        "./_helpers/cli-summary-commands.js"
      );
      await printSetApiSummary(args);
      return;
    }
    case "set-config": {
      const { printSetConfigSummary } = await import(
        "./_helpers/cli-summary-commands.js"
      );
      await printSetConfigSummary(args);
      return;
    }
    case "set-global-memory": {
      const { printSetGlobalMemorySummary } = await import(
        "./_helpers/cli-summary-commands.js"
      );
      await printSetGlobalMemorySummary(args);
      return;
    }
    case "set-default-model": {
      const { printDefaultModelSummary } = await import(
        "./_helpers/cli-summary-commands.js"
      );
      await printDefaultModelSummary(args);
      return;
    }
    case "config": {
      const { printConfigSummary } = await import(
        "./_helpers/cli-summary-commands.js"
      );
      await printConfigSummary(args);
      return;
    }
    case "chat": {
      const { runInteractiveChat } = await import("./_helpers/cli-task-run.js");
      await runInteractiveChat(args);
      return;
    }
    case "interview": {
      const { printTaskInterviewSummary } = await import(
        "./_helpers/cli-interview-commands.js"
      );
      await printTaskInterviewSummary(args);
      return;
    }
    case "inspect": {
      const { printCustomizationSummary } = await import(
        "./_helpers/cli-summary-commands.js"
      );
      await printCustomizationSummary(args);
      return;
    }
    case "instructions": {
      const { printInstructionSummary } = await import(
        "./_helpers/cli-instruction-commands.js"
      );
      await printInstructionSummary(args);
      return;
    }
    case "tools": {
      const { printToolSummary } = await import(
        "./_helpers/cli-summary-commands.js"
      );
      await printToolSummary(args);
      return;
    }
    case "ralph": {
      const { printRalphSummary } = await import(
        "./_helpers/cli-ralph-commands.js"
      );
      await printRalphSummary(args);
      return;
    }
    case "scheduler": {
      const { printSchedulerSummary } = await import(
        "./_helpers/cli-scheduler-commands.js"
      );
      await printSchedulerSummary(args);
      return;
    }
    case "mcp": {
      const { printMcpSummary } = await import("./_helpers/cli-mcp-commands.js");
      await printMcpSummary(args);
      return;
    }
    case "run": {
      const { printTaskPreview } = await import("./_helpers/cli-task-run.js");
      await printTaskPreview(args);
      return;
    }
  }
};
