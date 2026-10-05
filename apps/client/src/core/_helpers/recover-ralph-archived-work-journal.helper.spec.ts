import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recoverRalphArchivedWorkJournal } from "./recover-ralph-archived-work-journal.helper.js";

it("recovers the exact run-owned journal and retains its archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralph-archive-recovery-"));
  try {
    const archivePath = join(directory, "archive.json");
    const path = join(directory, "tasks.json");
    const raw = JSON.stringify(
      {
        previousGoal: "Preserve existing records",
        research: "https://example.com/reference",
        tasks: [
          {
            id: "feature",
            status: "deferred",
            runId: "run",
            stateHistory: [{ from: "verifying", to: "deferred", runId: "run" }],
          },
        ],
      },
      null,
      2,
    );
    await writeFile(archivePath, raw);
    await recoverRalphArchivedWorkJournal({
      path,
      archivePath,
      jsonPath: "tasks",
      taskIds: ["feature"],
      runId: "run",
    });
    expect(await readFile(path, "utf8")).toBe(raw);
    expect(await readFile(archivePath, "utf8")).toBe(raw);
    await writeFile(path, "new canonical journal");
    await expect(
      recoverRalphArchivedWorkJournal({
        path,
        archivePath,
        jsonPath: "tasks",
        taskIds: ["feature"],
        runId: "run",
      }),
    ).rejects.toThrow("reappeared");
    expect(await readFile(path, "utf8")).toBe("new canonical journal");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects foreign and missing selected work before creating a journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ralph-archive-ownership-"));
  try {
    const archivePath = join(directory, "archive.json");
    const path = join(directory, "tasks.json");
    await writeFile(
      archivePath,
      JSON.stringify({
        tasks: [
          {
            id: "feature",
            runId: "foreign",
            stateHistory: [{ runId: "foreign" }],
          },
        ],
      }),
    );
    for (const taskIds of [["feature"], ["missing"]]) {
      await expect(
        recoverRalphArchivedWorkJournal({
          path,
          archivePath,
          jsonPath: "tasks",
          taskIds,
          runId: "run",
        }),
      ).rejects.toThrow("does not belong");
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
