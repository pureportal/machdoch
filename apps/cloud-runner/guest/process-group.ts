import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export class GuestProcessStopError extends Error {
  constructor(cause: unknown) {
    super("The guest process tree did not confirm termination", { cause });
  }
}

export async function stopGuestWorkload(): Promise<void> {
  try {
    await writeFile("/sys/fs/cgroup/agent/cgroup.kill", "1");
    const deadline = performance.now() + 5000;
    while (
      !/^populated 0$/mu.test(
        await readFile("/sys/fs/cgroup/agent/cgroup.events", "utf8"),
      )
    ) {
      if (performance.now() >= deadline)
        throw new Error("The guest process tree did not stop");
      await delay(20);
    }
  } catch (error) {
    throw new GuestProcessStopError(error);
  }
}
