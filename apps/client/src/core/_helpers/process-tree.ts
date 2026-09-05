import { spawn, type ChildProcess } from "node:child_process";

const TREE_KILL_TIMEOUT_MS = 2_000;
const TERMINATION_GRACE_MS = 500;

// The child must have been launched with detached: true on POSIX. Always
// escalate the group, even if the direct child exits before its descendants.
export const terminateProcessTree = async (
  child: Pick<ChildProcess, "pid" | "kill">,
  force = false,
): Promise<void> => {
  const killChild = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // The child may already have exited.
    }
  };
  const pid = child.pid;
  if (pid === undefined || pid <= 0) {
    killChild("SIGKILL");
    return;
  }

  if (process.platform !== "win32") {
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-pid, signal);
      } catch {
        killChild(signal);
      }
    };
    if (!force) {
      signalGroup("SIGTERM");
      await new Promise<void>((resolve) =>
        setTimeout(resolve, TERMINATION_GRACE_MS),
      );
    }
    signalGroup("SIGKILL");
    return;
  }

  await new Promise<void>((resolve) => {
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      killChild("SIGKILL");
      resolve();
      return;
    }
    let settled = false;
    const finish = (failed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed) killChild("SIGKILL");
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killer.kill("SIGKILL");
      } catch {
        // The cleanup helper may already have exited.
      }
      finish(true);
    }, TREE_KILL_TIMEOUT_MS);
    killer.once("error", () => finish(true));
    killer.once("close", (code) => finish(code !== 0));
  });
};
