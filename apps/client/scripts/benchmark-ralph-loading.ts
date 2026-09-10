import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { loadRalphSnapshot } from "../src/core/ralph-snapshot.js";

const directory = await mkdtemp(join(tmpdir(), "machdoch-ralph-benchmark-"));
const target = resolve(directory);
if (!target.startsWith(join(resolve(tmpdir()), "machdoch-ralph-benchmark-"))) {
  throw new Error("Unexpected benchmark directory");
}
const previousConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
process.env.MACHDOCH_USER_CONFIG_DIR = join(directory, "user-config");
const workspaces = Array.from({ length: 6 }, (_, index) =>
  join(directory, `workspace-${index}`),
);

try {
  for (const root of [
    ...workspaces.map((workspace) => join(workspace, ".machdoch", "ralph")),
    join(directory, "user-config", "ralph"),
  ]) {
    await mkdir(join(root, "flows"), { recursive: true });
    await mkdir(join(root, "runs"), { recursive: true });
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        writeFile(
          join(root, "flows", `flow-${index}.json`),
          JSON.stringify({
            schemaVersion: 1,
            id: `flow-${index}`,
            name: `Flow ${index}`,
            blocks: [
              { id: "start", type: "START", title: "Start" },
              { id: "end", type: "END", title: "End", status: "success" },
            ],
            edges: [
              { id: "edge", from: "start", fromOutput: "SUCCESS", to: "end" },
            ],
          }),
        ),
      ),
    );
    for (let batch = 0; batch < 8; batch++) {
      await Promise.all(
        Array.from({ length: 16 }, async (_, offset) => {
          const index = batch * 16 + offset;
          const runDirectory = join(root, "runs", `run-${index}`);
          await mkdir(runDirectory);
          await writeFile(
            join(runDirectory, "run.json"),
            JSON.stringify({
              schemaVersion: 1,
              id: `run-${index}`,
              createdAt: new Date(
                1_700_000_000_000 + index * 1_000,
              ).toISOString(),
              flowId: `flow-${index % 24}`,
              flowName: `Flow ${index % 24}`,
              status: index === 0 ? "running" : "completed",
              summary: "Run result",
              events: [],
              blockResults: [{ summary: "result ".repeat(2_000) }],
            }),
          );
        }),
      );
    }
  }
  const rounds = [];
  for (let round = 0; round < 4; round++) {
    const start = performance.now();
    const snapshots = [];
    for (const workspace of workspaces) {
      snapshots.push(await loadRalphSnapshot(workspace));
    }
    rounds.push({
      milliseconds: Math.round(performance.now() - start),
      running: snapshots.reduce(
        (count, snapshot) =>
          count +
          snapshot.scopes
            .flatMap((scope) => scope.runs)
            .filter((run) => run.status === "running").length,
        0,
      ),
    });
  }
  process.stdout.write(
    `${JSON.stringify({ workspaces: 6, flowsPerScope: 24, runsPerScope: 128, rounds }, null, 2)}\n`,
  );
} finally {
  if (previousConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = previousConfig;
  await rm(target, { recursive: true, force: true });
}
