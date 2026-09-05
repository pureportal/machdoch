import { runStreamingCommand } from "./streaming-command.js";

const MAX_ACTIVE_GIT_COMMANDS = 4;
let activeCommands = 0;
const waitingCommands: Array<() => void> = [];

export const runTaskGitCommand = async (
  args: readonly string[],
  options: Parameters<typeof runStreamingCommand>[2],
): ReturnType<typeof runStreamingCommand> => {
  await new Promise<void>((resolve) => {
    if (activeCommands < MAX_ACTIVE_GIT_COMMANDS) {
      activeCommands += 1;
      resolve();
    } else {
      waitingCommands.push(resolve);
    }
  });
  try {
    return await runStreamingCommand(
      "git",
      ["--no-optional-locks", "-c", "core.quotePath=false", ...args],
      options,
    );
  } finally {
    const next = waitingCommands.shift();
    if (next) next();
    else activeCommands -= 1;
  }
};
