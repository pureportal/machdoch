import { CliUsageError } from "./cli-error.js";

export const CHAT_COMMANDS = [
  ["help", "[command]", "Show help"],
  ["commands", "", "Choose a command"],
  ["status", "", "Show session settings"],
  ["model", "[provider model]", "Choose a model"],
  ["mode", "[ask|machdoch]", "Change mode"],
  ["reasoning", "[level]", "Change reasoning"],
  ["new", "[workspace]", "Start a conversation"],
  ["sessions", "[search]", "Resume a saved CLI conversation"],
  ["history", "[search]", "Show conversation messages"],
  ["export", "<file>", "Export conversation context"],
  ["attach", "<path> [...]", "Attach files or folders to the next task"],
  ["image", "<path> [...]", "Attach images to the next task"],
  ["attachments", "", "Show pending attachments"],
  ["detach", "[number|all]", "Remove pending attachments"],
  [
    "memory",
    "[session|workspace|global] [on|off|inherit]",
    "Inspect or change memory",
  ],
  ["forget", "<session|workspace|global> <id>", "Remove a memory fact"],
  [
    "paste",
    "[ask|machdoch]",
    "Enter multiline text; /end sends, /cancel discards",
  ],
  ["retry", "", "Retry the last task"],
  ["config", "[arguments]", "Edit settings"],
  ["instructions", "[arguments]", "Manage instruction files and workspaces"],
  ["ralph", "[arguments]", "Manage and run flows"],
  ["scheduler", "[arguments]", "Manage scheduled work"],
  ["mcp", "[arguments]", "Manage MCP connections"],
  ["fleet", "[arguments]", "Manage Fleet"],
  ["inspect", "", "List prompts and skills"],
  ["tools", "", "List tools"],
  ["exit", "", "Exit chat"],
] as const;

export const CHAT_HELP = CHAT_COMMANDS.map(
  ([name, args, description]) =>
    `  ${`/${name}${args ? ` ${args}` : ""}`.padEnd(55)} ${description}`,
).join("\n");

export const completeChatCommand = (line: string): [string[], string] => {
  if (!line.startsWith("/") || /\s/u.test(line)) return [[], line];
  return [
    CHAT_COMMANDS.map(([name]) => `/${name}`).filter((name) =>
      name.startsWith(line),
    ),
    line,
  ];
};

export const splitInteractiveArguments = (text: string): string[] => {
  const args: string[] = [];
  let value = "";
  let quote: string | undefined;
  let started = false;
  for (const character of text) {
    if (quote) {
      if (character === quote) quote = undefined;
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) args.push(value);
      value = "";
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) throw new CliUsageError(`Close the ${quote} quote and try again.`);
  if (started) args.push(value);
  return args;
};

export class InteractiveInputCancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "InteractiveInputCancelledError";
  }
}
