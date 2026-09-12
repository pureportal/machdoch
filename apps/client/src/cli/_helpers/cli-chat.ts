import process from "node:process";
import { resolve } from "node:path";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../../core/memory.js";
import { handleChatSessionControl } from "./cli-chat-session-controls.js";
import { handleChatContextControl } from "./cli-chat-context-controls.js";
import { createChatInput, type ChatInput } from "./cli-chat-input.js";
import { createChatSession, saveChatSession } from "./cli-chat-sessions.js";
import {
  handleChatRuntimeControl,
  loadChatConfig,
  showChatStatus,
  withChatMenu,
  type ChatState,
} from "./cli-chat-controls.js";
import {
  CHAT_COMMANDS,
  CHAT_HELP,
  InteractiveInputCancelledError,
  splitInteractiveArguments,
} from "./cli-interactive-commands.js";
import { readPastedTask } from "./cli-chat-paste.js";
import { getHelpText, type ParsedCliArgs } from "./cli-args.js";
import { CliUsageError } from "./cli-error.js";
import {
  printTaskPreview,
  resolveConversationContext,
} from "./cli-task-run.js";
import { writeStdoutLine } from "./cli-io.js";
import { createCliStyle } from "./cli-terminal.js";

const MANAGEMENT_COMMANDS = new Set([
  "config",
  "instructions",
  "ralph",
  "scheduler",
  "mcp",
  "fleet",
  "inspect",
  "tools",
]);

export const runInteractiveChat = async (
  args: ParsedCliArgs,
  options: {
    input?: ChatInput;
    executeTask?: typeof printTaskPreview;
    write?: (line: string) => void;
  } = {},
): Promise<void> => {
  if (args.json)
    throw new CliUsageError(
      "Interactive chat does not support --json. Use `machdoch run <task> --json`.",
    );
  if (!options.input && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new CliUsageError(
      "Interactive chat requires a terminal. Use `machdoch run <task>` or `machdoch run --task -` in scripts.",
    );
  const write = options.write ?? writeStdoutLine;
  const executeTask = options.executeTask ?? printTaskPreview;
  const style = createCliStyle();
  const initialArgs = { ...args, workspaceRoot: resolve(args.workspaceRoot) };
  const config = await loadChatConfig(initialArgs);
  const context = await resolveConversationContext(args);
  const state: ChatState = {
    args: initialArgs,
    config,
    session: createChatSession(initialArgs.workspaceRoot, context),
  };
  const input = options.input ?? createChatInput();
  let unsaved = false;

  const persist = async (): Promise<void> => {
    if (!state.session.context.history.length) return;
    state.session.updatedAt = Date.now();
    state.session.mode = state.config.mode;
    state.session.model = state.config.model;
    state.session.reasoning = state.config.reasoning;
    if (state.args.agentLimits)
      state.session.agentLimits = state.args.agentLimits;
    if (state.config.provider !== "unconfigured")
      state.session.provider = state.config.provider;
    try {
      await saveChatSession(state.session);
      unsaved = false;
    } catch (error) {
      unsaved = true;
      throw new Error(
        `Conversation could not be saved: ${error instanceof Error ? error.message : String(error)}. Use /export <file> before leaving.`,
      );
    }
  };
  const execute = async (
    task: string,
    taskArgs = state.args,
  ): Promise<void> => {
    state.lastTask = {
      text: task,
      args: { ...taskArgs, mode: taskArgs.mode ?? state.config.mode },
    };
    const previousExitCode = process.exitCode;
    input.setBusy(true);
    write(style.muted("Working… Ctrl+C cancels."));
    try {
      const { execution } = await executeTask(
        { ...taskArgs, command: "run", task },
        {
          conversationContext: {
            ...state.session.context,
            history: state.session.context.history.slice(-60),
          },
          showActionFeedback: true,
        },
      );
      state.session.context.history.push(
        { role: "user", content: task, createdAt: Date.now() },
        {
          role: "assistant",
          content:
            execution.response?.markdown.trim() || execution.summary.trim(),
          createdAt: Date.now(),
        },
      );
      const updates =
        execution.memoryUpdates
          ?.filter((update) => update.scope === "session")
          .map((update) => update.entry) ?? [];
      state.session.context.sessionMemory = mergeConversationMemoryEntries(
        state.session.context.sessionMemory ?? [],
        updates,
        MAX_SESSION_MEMORY_ENTRIES,
      );
      if (execution.status === "executed" || execution.status === "planned") {
        delete state.args.contextPaths;
        delete state.args.imagePaths;
      }
      await persist();
    } finally {
      process.exitCode = previousExitCode;
      input.setBusy(false);
    }
  };
  const handleCommand = async (task: string): Promise<boolean> => {
    const [name = "", ...values] = splitInteractiveArguments(task.slice(1));
    if (["exit", "quit"].includes(name)) {
      if (values.length) throw new CliUsageError(`Usage: /${name}`);
      if (unsaved) await persist();
      return false;
    }
    if (name === "help") {
      if (values.length > 1) throw new CliUsageError("Usage: /help [command]");
      const topic = values[0]?.replace(/^\//u, "");
      const chatCommand = CHAT_COMMANDS.find(([command]) => command === topic);
      write(
        !topic
          ? CHAT_HELP
          : chatCommand && !MANAGEMENT_COMMANDS.has(topic)
            ? `/${chatCommand[0]} ${chatCommand[1]}\n${chatCommand[2]}`
            : getHelpText(topic),
      );
      return true;
    }
    if (name === "commands") {
      if (values.length) throw new CliUsageError("Usage: /commands");
      const selected = await withChatMenu(input, (prompter) =>
        prompter.select(
          "Commands",
          CHAT_COMMANDS.filter(([command]) => command !== "commands").map(
            ([command, , description]) => ({
              value: command,
              label: `/${command}  ${description}`,
            }),
          ),
        ),
      );
      if (selected) {
        const command = CHAT_COMMANDS.find(
          ([command]) => command === selected,
        )!;
        if (command[1].startsWith("<")) write(`/${selected} ${command[1]}`);
        else return await handleCommand(`/${selected}`);
      }
      return true;
    }
    if (name === "paste") {
      if (values.length > 1)
        throw new CliUsageError("Usage: /paste [ask|machdoch]");
      write("/end sends · /cancel discards");
      const result = await readPastedTask(input, values[0]);
      if (result)
        await execute(result.task, {
          ...state.args,
          ...(result.mode ? { mode: result.mode } : {}),
        });
      else write("Paste discarded.");
      return true;
    }
    if (name === "retry") {
      if (values.length) throw new CliUsageError("Usage: /retry");
      if (!state.lastTask)
        throw new CliUsageError("There is no task to retry.");
      await execute(state.lastTask.text, {
        ...state.args,
        ...(state.lastTask.args.mode ? { mode: state.lastTask.args.mode } : {}),
        contextPaths: state.lastTask.args.contextPaths ?? [],
        imagePaths: state.lastTask.args.imagePaths ?? [],
      });
      return true;
    }
    if (MANAGEMENT_COMMANDS.has(name)) {
      const commandArgs =
        values.length || name !== "config" ? values : ["edit"];
      if (
        (name === "mcp" &&
          ["proxy", "broker", "presence", "serve", "connect"].includes(
            commandArgs[0] ?? "",
          )) ||
        (["fleet", "scheduler"].includes(name) && commandArgs[0] === "service")
      )
        throw new CliUsageError(
          `Run \`machdoch ${name} ${commandArgs.join(" ")}\` in a separate terminal.`,
        );
      const previousExitCode = process.exitCode;
      try {
        await input.suspend(async () => {
          const { runCli } = await import("../app.js");
          await runCli([
            name,
            ...commandArgs,
            "--cwd",
            state.args.workspaceRoot,
          ]);
        });
      } finally {
        process.exitCode = previousExitCode;
      }
      state.config = await loadChatConfig(state.args);
      return true;
    }
    if (unsaved && (name === "new" || name === "sessions")) await persist();
    if (
      (await handleChatRuntimeControl(name, values, state, input, write)) ||
      (await handleChatSessionControl(name, values, state, input, write)) ||
      (await handleChatContextControl(name, values, state, write))
    ) {
      if (name === "export") unsaved = false;
      else if (
        ["model", "mode", "reasoning", "memory", "forget"].includes(name)
      )
        await persist();
      return true;
    }
    throw new CliUsageError(
      `Unknown command /${name}. Use /help or /commands. Start with // to send a task beginning with /.`,
    );
  };
  const reportError = (error: unknown): void => {
    write(
      error instanceof InteractiveInputCancelledError
        ? "Cancelled."
        : `${style.error("Error:")} ${error instanceof Error ? error.message : String(error)}`,
    );
  };

  try {
    write(style.heading("Machdoch"));
    showChatStatus(state, write);
    write(
      style.muted(
        "/help commands · Tab completes · /paste multiline · Ctrl+D exits",
      ),
    );
    if (args.contextPaths?.length || args.imagePaths?.length)
      await handleChatContextControl("attachments", [], state, write);
    if (state.config.provider === "unconfigured")
      write("Choose a provider with /config before running a task.");
    if (args.task?.trim()) {
      try {
        await execute(args.task.trim());
      } catch (error) {
        reportError(error);
      }
    }
    while (true) {
      try {
        const line = await input.readLine(`${state.config.mode}> `);
        if (!line) break;
        const task = line.text.trim();
        if (!task) continue;
        if (!line.pasted && task.startsWith("/") && !task.startsWith("//")) {
          if (!(await handleCommand(task))) break;
        } else
          await execute(
            !line.pasted && task.startsWith("//") ? task.slice(1) : task,
          );
      } catch (error) {
        reportError(error);
      }
    }
  } finally {
    input.close();
    if (unsaved) {
      process.exitCode = 1;
      write("Conversation has unsaved changes.");
    }
  }
};
