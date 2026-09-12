import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadWorkspaceConfigFile } from "../../core/config.js";
import {
  forgetUserGlobalMemory,
  loadUserMemorySettings,
} from "../../core/env.js";
import {
  forgetConversationMemoryEntry,
  resolveWorkspaceMemoryEnabled,
} from "../../core/memory.js";
import {
  forgetWorkspaceMemory,
  loadWorkspaceMemory,
} from "../../core/workspace-memory.js";
import { createImageInputsFromPaths } from "./cli-task-run.js";
import type { ChatState } from "./cli-chat-controls.js";
import { CliUsageError } from "./cli-error.js";

export const handleChatContextControl = async (
  command: string,
  values: string[],
  state: ChatState,
  write: (line: string) => void,
): Promise<boolean> => {
  const usage = (message: string): never => {
    throw new CliUsageError(`Usage: /${command} ${message}`.trim());
  };
  if (["attach", "image", "attachments", "detach"].includes(command)) {
    const attachments = [
      ...(state.args.contextPaths ?? []).map((path) => ({
        path,
        kind: "file",
      })),
      ...(state.args.imagePaths ?? []).map((path) => ({ path, kind: "image" })),
    ];
    if (command === "attachments") {
      if (values.length) usage("");
      for (const [index, entry] of attachments.entries())
        write(`${index + 1}. ${entry.kind}: ${entry.path}`);
      if (!attachments.length) write("No pending attachments.");
    } else if (command === "detach") {
      if (values.length > 1) usage("[number|all]");
      const value = values[0] ?? "all";
      if (value === "all") {
        delete state.args.contextPaths;
        delete state.args.imagePaths;
      } else {
        if (!/^[1-9]\d*$/u.test(value) || !attachments[Number(value) - 1])
          usage("<number|all>");
        attachments.splice(Number(value) - 1, 1);
        state.args.contextPaths = attachments
          .filter((entry) => entry.kind === "file")
          .map((entry) => entry.path);
        state.args.imagePaths = attachments
          .filter((entry) => entry.kind === "image")
          .map((entry) => entry.path);
      }
      write("Attachments removed.");
    } else {
      if (!values.length) usage("<path> [...]");
      const paths = values.map((path) =>
        resolve(state.args.workspaceRoot, path),
      );
      for (const path of paths) {
        const metadata = await stat(path);
        if (!metadata.isFile() && !metadata.isDirectory())
          throw new CliUsageError(`Choose a file or folder: ${path}`);
      }
      if (command === "image")
        await createImageInputsFromPaths(
          paths,
          state.args.workspaceRoot,
          state.config,
        );
      const key = command === "image" ? "imagePaths" : "contextPaths";
      state.args[key] = [...new Set([...(state.args[key] ?? []), ...paths])];
      write(
        `Attached ${paths.length} ${paths.length === 1 ? "path" : "paths"} to the next task.`,
      );
    }
    return true;
  }
  if (command === "memory" || command === "forget") {
    const [scope = "session", value] = values;
    if (
      !["session", "workspace", "global"].includes(scope) ||
      values.length > 2
    )
      usage("<session|workspace|global> [on|off|inherit]");
    const context = state.session.context;
    if (command === "forget") {
      if (values.length !== 2) usage("<session|workspace|global> <id>");
      let removed: boolean;
      if (scope === "session") {
        const entries = forgetConversationMemoryEntry(
          context.sessionMemory ?? [],
          value!,
        );
        removed = entries.length !== (context.sessionMemory ?? []).length;
        context.sessionMemory = entries;
      } else if (scope === "workspace")
        removed = await forgetWorkspaceMemory(state.args.workspaceRoot, value!);
      else {
        removed = await forgetUserGlobalMemory(value!);
        if (context.globalMemory !== undefined) {
          const previous = context.globalMemory;
          context.globalMemory = forgetConversationMemoryEntry(
            previous,
            value!,
          );
          removed ||= previous.length !== context.globalMemory.length;
        }
      }
      if (!removed)
        throw new CliUsageError(
          `Memory fact not found. Use /memory ${scope} to find its id.`,
        );
      write("Memory fact removed.");
      return true;
    }
    const key =
      scope === "session"
        ? "sessionMemoryEnabled"
        : scope === "workspace"
          ? "workspaceMemoryEnabled"
          : "globalMemoryEnabled";
    if (value !== undefined) {
      if (
        !["on", "off", "inherit"].includes(value) ||
        (scope === "session" && value === "inherit")
      )
        usage(`<${scope}> <on|off${scope === "session" ? "" : "|inherit"}>`);
      if (value === "inherit") delete context[key];
      else context[key] = value === "on";
      if (scope === "session") delete state.args.sessionMemoryEnabled;
      if (scope === "global") delete state.args.globalMemoryEnabled;
      write(`${scope} memory: ${value}`);
      return true;
    }
    const settings = await loadUserMemorySettings();
    const entries =
      scope === "session"
        ? (context.sessionMemory ?? [])
        : scope === "workspace"
          ? await loadWorkspaceMemory(state.args.workspaceRoot)
          : (context.globalMemory ?? settings.entries);
    const enabled =
      context[key] ??
      (scope === "session"
        ? true
        : scope === "workspace"
          ? resolveWorkspaceMemoryEnabled(
              settings.workspaceDefaultEnabled,
              (await loadWorkspaceConfigFile(state.args.workspaceRoot)).config
                .workspaceMemoryEnabled,
            )
          : settings.globalEnabled);
    write(`${scope} memory: ${enabled ? "on" : "off"}`);
    for (const entry of entries) write(`${entry.id}  ${entry.content}`);
    if (!entries.length) write("No saved facts.");
    return true;
  }
  return false;
};
