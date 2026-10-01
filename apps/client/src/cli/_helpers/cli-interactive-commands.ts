import { CliUsageError } from "./cli-error.js";

export const CHAT_COMMANDS = [
  ["help", "[command]", "Show help"],
  ["commands", "", "Choose a command"],
  ["shortcuts", "", "Show keyboard shortcuts"],
  ["clear", "", "Clear the terminal"],
  ["editor", "", "Compose in your text editor"],
  ["verbose", "[on|off]", "Show detailed activity"],
  ["status", "", "Show session settings"],
  ["diff", "[staged]", "Review Git changes"],
  ["model", "[provider model]", "Choose a model"],
  ["mode", "[ask|machdoch]", "Change mode"],
  [
    "parallel",
    "[disabled|read-only|machdoch|native]",
    "Change parallel agent mode",
  ],
  [
    "goal",
    "[--tokens N] [--turns N] [--minutes N] <objective> | pause | resume | clear | mode <machdoch|native>",
    "Work toward a goal",
  ],
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
  ["provider-sync", "[arguments]", "Manage provider integration"],
  ["inspect", "", "List prompts and skills"],
  ["tools", "", "List tools"],
  ["exit", "", "Exit chat"],
] as const;

export const CHAT_HELP = CHAT_COMMANDS.map(
  ([name, args, description]) =>
    `  ${`/${name}${args ? ` ${args}` : ""}`.padEnd(55)} ${description}`,
).join("\n");

export const completeChatCommand = (line: string): [string[], string] => {
  if (!line.startsWith("/")) return [[], line];
  const argumentChoices: Readonly<Record<string, readonly string[]>> = {
    mode: ["ask", "machdoch"],
    parallel: ["disabled", "read-only", "machdoch", "native"],
    reasoning: [
      "default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "aeon",
    ],
    verbose: ["on", "off"],
    memory: ["session", "workspace", "global"],
    config: ["edit", "list", "show", "get", "set", "unset"],
  };
  const argument = /^\/(\S+)\s+(\S*)$/u.exec(line);
  if (argument)
    return [
      (argumentChoices[argument[1]!] ?? [])
        .filter((value) => value.startsWith(argument[2]!))
        .map((value) => `/${argument[1]} ${value}`),
      line,
    ];
  if (/\s/u.test(line)) return [[], line];
  return [
    CHAT_COMMANDS.map(([name]) => `/${name}`).filter((name) =>
      name.startsWith(line),
    ),
    line,
  ];
};

export const CHAT_SHORTCUTS = [
  "Enter              Send prompt",
  "Ctrl+J / Alt+Enter Insert newline",
  "Shift+Enter        Insert newline (terminals with extended keys)",
  "\\ + Enter          Continue on a new line",
  "↑ / ↓              Move between lines, then recall prompt history",
  "Ctrl+R             Search prompt history; Enter accepts, Esc restores draft",
  "Tab                Complete commands and arguments",
  "Ctrl+A / Ctrl+E    Start / end of line",
  "Ctrl+← / Ctrl+→    Move by word (also Alt+B / Alt+F)",
  "Ctrl+Home / End    Start / end of prompt",
  "Ctrl+U / Ctrl+K    Delete to start / end of line",
  "Ctrl+W / Ctrl+Y    Delete word / paste deleted text",
  "Ctrl+_             Undo an input edit",
  "Ctrl+L             Clear terminal and redraw prompt",
  "Ctrl+C / Esc       Cancel task; Ctrl+C discards draft",
  "Ctrl+D             Exit when prompt is empty",
  "Ctrl+G / /editor   Compose with VISUAL or EDITOR",
].join("\n");

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
