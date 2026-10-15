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
import { resolveCliWorkspaceRoot } from "./cli-workspace.js";
import { resolveConversationContext } from "./cli-task-run.js";

const resolveChatWorkspace = async (
  root: string,
  path: string,
): Promise<string> => {
  const workspaceRoot = await realpath(resolve(root, path));
  if (!(await stat(workspaceRoot)).isDirectory())
    throw new CliUsageError("Choose a workspace folder.");
  return workspaceRoot;
};

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
    const workspaceRoot = values[0]
      ? await resolveChatWorkspace(state.args.workspaceRoot, values[0])
      : "";
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
    state.session = createChatSession(
      workspaceRoot,
      await resolveConversationContext(nextArgs),
    );
    delete state.lastTask;
    write("New conversation.");
    showChatStatus(state, write);
    return true;
  }
  if (command === "workspace") {
    if (values.length > 1) usage("[folder|none]");
    if (!values.length) {
      write(state.args.workspaceRoot || "Not Set");
      return true;
    }
    const workspaceRoot =
      values[0] === "none"
        ? ""
        : await resolveChatWorkspace(state.args.workspaceRoot, values[0]!);
    const args = { ...state.args, workspaceRoot };
    const config = await loadChatConfig(args);
    state.session.context.earlierWorkspace = state.args.workspaceRoot || null;
    state.session.context.workspace = workspaceRoot
      ? { selection: "selected", root: workspaceRoot }
      : { selection: "not-set" };
    delete state.session.context.workspaceRun;
    delete state.session.context.workspaceMemoryEnabled;
    state.session.workspaceRoot = resolveCliWorkspaceRoot(workspaceRoot);
    state.args = args;
    state.config = config;
    delete state.args.contextPaths;
    delete state.args.imagePaths;
    delete state.lastTask;
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
        `${session.context.workspace?.selection === "not-set" ? "Not Set" : session.workspaceRoot} ${session.context.history.map((entry) => entry.content).join(" ")}`
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
          } · ${session.context.workspace?.selection === "not-set" ? "Not Set" : session.workspaceRoot}`,
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
      workspaceRoot:
        session.context.workspace?.selection === "not-set"
          ? ""
          : session.workspaceRoot,
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
