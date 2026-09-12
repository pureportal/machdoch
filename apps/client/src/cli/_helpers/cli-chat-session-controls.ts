import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ParsedCliArgs } from "./cli-args.js";
import type { ChatInput } from "./cli-chat-input.js";
import {
  createChatSession,
  exportChatContext,
  listChatSessions,
} from "./cli-chat-sessions.js";
import {
  loadChatConfig,
  showChatStatus,
  withChatMenu,
  type ChatState,
} from "./cli-chat-controls.js";
import { CliUsageError } from "./cli-error.js";

export const handleChatSessionControl = async (
  command: string,
  values: string[],
  state: ChatState,
  input: ChatInput,
  write: (line: string) => void,
): Promise<boolean> => {
  const usage = (message: string): never => {
    throw new CliUsageError(`Usage: /${command} ${message}`.trim());
  };
  if (command === "new") {
    if (values.length > 1) usage("[workspace]");
    const workspaceRoot = await realpath(
      resolve(state.args.workspaceRoot, values[0] ?? "."),
    );
    if (!(await stat(workspaceRoot)).isDirectory())
      throw new CliUsageError("Choose a workspace folder.");
    const {
      contextPaths: _context,
      imagePaths: _images,
      conversationContextFile: _file,
      ...args
    } = state.args;
    const nextArgs = { ...args, workspaceRoot };
    const config = await loadChatConfig(nextArgs);
    state.args = nextArgs;
    state.config = config;
    state.session = createChatSession(workspaceRoot, {
      history: [],
      sessionMemoryEnabled: state.session.context.sessionMemoryEnabled ?? true,
      ...(state.session.context.globalMemoryEnabled !== undefined
        ? { globalMemoryEnabled: state.session.context.globalMemoryEnabled }
        : {}),
    });
    delete state.lastTask;
    write("New conversation.");
    showChatStatus(state, write);
    return true;
  }
  if (command === "sessions") {
    const { sessions, errors } = await listChatSessions();
    for (const error of errors) write(`Could not read session: ${error}`);
    const search = values.join(" ").toLowerCase();
    const matches = sessions.filter(
      (session) =>
        session.id !== state.session.id &&
        `${session.workspaceRoot} ${session.context.history.map((entry) => entry.content).join(" ")}`
          .toLowerCase()
          .includes(search),
    );
    if (!matches.length) {
      write("No saved conversations match.");
      return true;
    }
    const id = await withChatMenu(input, (prompter) =>
      prompter.select(
        "Resume conversation",
        matches.map((session) => ({
          value: session.id,
          label: `${new Date(session.updatedAt).toLocaleDateString()} · ${
            session.context.history
              .find((entry) => entry.role === "user")
              ?.content.replace(/\s+/gu, " ")
              .slice(0, 65) ?? "Conversation"
          } · ${session.workspaceRoot}`,
        })),
      ),
    );
    const session = matches.find((entry) => entry.id === id);
    if (!session) return true;
    if (!(await stat(session.workspaceRoot)).isDirectory())
      throw new CliUsageError(
        "The conversation workspace is no longer a folder.",
      );
    const args: ParsedCliArgs = {
      command: "chat",
      json: false,
      verbose: state.args.verbose,
      workspaceRoot: session.workspaceRoot,
      ...(session.provider ? { runtimeProvider: session.provider } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.mode ? { mode: session.mode } : {}),
      ...(session.reasoning ? { reasoning: session.reasoning } : {}),
      ...(session.agentLimits ? { agentLimits: session.agentLimits } : {}),
    };
    const config = await loadChatConfig(args);
    state.args = args;
    state.config = config;
    state.session = session;
    delete state.lastTask;
    write("Conversation resumed.");
    showChatStatus(state, write);
    const latest = session.context.history.at(-1);
    if (latest) write(`\n${latest.role}: ${latest.content}`);
    return true;
  }
  if (command === "history") {
    const search = values.join(" ").toLowerCase();
    const entries = state.session.context.history.filter((entry) =>
      entry.content.toLowerCase().includes(search),
    );
    for (const entry of entries) write(`${entry.role}: ${entry.content}\n`);
    if (!entries.length) write("No messages match.");
    return true;
  }
  if (command === "export") {
    if (values.length !== 1) usage("<file>");
    const path = resolve(state.args.workspaceRoot, values[0]!);
    await exportChatContext(path, state.session.context);
    write(`Exported ${path}`);
    return true;
  }
  return false;
};
