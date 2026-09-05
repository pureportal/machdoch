import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  redactedRunValue,
  runDocumentSchema,
  type RunDocument,
  type RunTask,
} from "@machdoch/fleet-protocol";
import { FleetRunManager } from "./fleet-runs.ts";

const roots: string[] = [];
const managers: FleetRunManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});
async function setup(script = "setInterval(() => {}, 1000)") {
  const root = await mkdtemp(join(tmpdir(), "machdoch-runs-test-"));
  roots.push(root);
  await writeFile(join(root, "server.cjs"), script);
  const manager = new FleetRunManager(async (workspace) => {
    if (workspace !== root) throw new Error("Unknown workspace");
    return workspace;
  });
  managers.push(manager);
  return { root, manager };
}
function task(overrides: Partial<RunTask> = {}): RunTask {
  return {
    id: "web",
    name: "Web",
    kind: "task",
    primary: true,
    command: `"${process.execPath}" server.cjs`,
    workingDirectory: ".",
    environment: {},
    hotReload: true,
    ports: [],
    urls: [],
    healthCheck: null,
    restartPolicy: {
      onCrash: false,
      maxRestarts: 1,
      windowMs: 60000,
      backoffMs: 100,
      maxBackoffMs: 100,
    },
    ...overrides,
  };
}
async function save(
  manager: FleetRunManager,
  root: string,
  configurations: RunDocument["configurations"],
) {
  await manager.execute(root, {
    action: "save",
    commandId: randomUUID(),
    expectedRevision: (await manager.snapshot(root)).revision,
    document: { schemaVersion: 2, configurations },
  });
}
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
describe.sequential("headless project services", () => {
  it("redacts multiline secrets and drops the complete tail of oversized output lines", async () => {
    const f = await setup(
      'console.log(process.env.MULTILINE); process.stdout.write("x".repeat(17000)+"secret-"); setTimeout(()=>console.log("tail"),50); setInterval(()=>{},1000)',
    );
    await save(f.manager, f.root, [
      task({
        environment: {
          MULTILINE: "private-one\nprivate-two",
          SECRET: "secret-tail",
        },
      }),
    ]);
    await f.manager.execute(f.root, {
      action: "start",
      commandId: randomUUID(),
      configurationId: "web",
    });
    await vi.waitFor(async () =>
      expect(
        (await f.manager.snapshot(f.root)).statuses[0]!.logs.some(
          (line) => line.line === "Oversized output line omitted.",
        ),
      ).toBe(true),
    );
    const logs = JSON.stringify(
      (await f.manager.snapshot(f.root)).statuses[0]!.logs,
    );
    expect(logs).not.toContain("private-one");
    expect(logs).not.toContain("private-two");
    expect(logs).not.toContain("secret-");
    expect(logs).toContain("[redacted]");
  });
  it("saves without executing, redacts split output and environment, deduplicates starts, and stops process trees", async () => {
    const f = await setup(
      'process.stdout.write("top-"); setTimeout(() => console.log("secret"), 30); setInterval(() => {}, 1000)',
    );
    await save(f.manager, f.root, [
      task({ environment: { SECRET: "top-secret" } }),
    ]);
    const first = await f.manager.snapshot(f.root);
    expect(first.statuses[0]?.pid).toBeNull();
    expect(first.document.configurations[0]).toMatchObject({
      environment: { SECRET: redactedRunValue },
    });
    const start = {
      action: "start" as const,
      commandId: randomUUID(),
      configurationId: "web",
    };
    await f.manager.execute(f.root, start);
    await f.manager.execute(f.root, start);
    await vi.waitFor(
      async () =>
        expect(
          (await f.manager.snapshot(f.root)).statuses[0]?.logs.some(
            (entry) => entry.line === "[redacted]",
          ),
        ).toBe(true),
      { timeout: 10000 },
    );
    const pid = (await f.manager.snapshot(f.root)).statuses[0]!.pid!;
    expect((await f.manager.snapshot(f.root, false)).statuses[0]!.logs).toEqual(
      [],
    );
    expect(pid).toBeGreaterThan(0);
    await expect(
      f.manager.execute(f.root, { ...start, action: "restart" }),
    ).rejects.toThrow("Command id");
    await f.manager.execute(f.root, {
      action: "stop",
      commandId: randomUUID(),
      configurationId: "web",
    });
    expect((await f.manager.snapshot(f.root)).statuses[0]).toMatchObject({
      state: "stopped",
      pid: null,
    });
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15000);
  it("blocks stale saves, active edits, escaping paths, and symlinked configuration directories", async () => {
    const f = await setup();
    const initial = await f.manager.snapshot(f.root);
    await save(f.manager, f.root, [task()]);
    await expect(
      f.manager.execute(f.root, {
        action: "save",
        commandId: randomUUID(),
        expectedRevision: initial.revision,
        document: initial.document,
      }),
    ).rejects.toThrow("changed");
    await expect(
      save(f.manager, f.root, [task({ workingDirectory: "../" })]),
    ).rejects.toThrow("inside");
    await f.manager.execute(f.root, {
      action: "start",
      commandId: randomUUID(),
      configurationId: "web",
    });
    await expect(save(f.manager, f.root, [task()])).rejects.toThrow("Stop all");
    const other = await setup();
    await mkdir(join(other.root, "outside"));
    await symlink(
      join(other.root, "outside"),
      join(other.root, ".machdoch"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(other.manager.snapshot(other.root)).rejects.toThrow(
      "regular project directory",
    );
    await expect(f.manager.snapshot("/unknown")).rejects.toThrow(
      "Unknown workspace",
    );
  }, 15000);
  it("preserves stored secrets during redacted edits and detects external file changes", async () => {
    const f = await setup();
    await save(f.manager, f.root, [
      task({ environment: { TOKEN: "stored-value" } }),
    ]);
    const snapshot = await f.manager.snapshot(f.root);
    snapshot.document.configurations[0]!.name = "Updated";
    await f.manager.execute(f.root, {
      action: "save",
      commandId: randomUUID(),
      expectedRevision: snapshot.revision,
      document: snapshot.document,
    });
    expect(
      await readFile(join(f.root, ".machdoch", "run.json"), "utf8"),
    ).toContain("stored-value");
    const stale = await f.manager.snapshot(f.root);
    await writeFile(
      join(f.root, ".machdoch", "run.json"),
      JSON.stringify({ schemaVersion: 2, configurations: [] }),
    );
    await expect(
      f.manager.execute(f.root, {
        action: "save",
        commandId: randomUUID(),
        expectedRevision: stale.revision,
        document: stale.document,
      }),
    ).rejects.toThrow("changed");
  });
  it("only opens declared ports of live services and disconnects previews on restart", async () => {
    const port = await unusedPort();
    const f = await setup(
      `require('node:http').createServer((req,res)=>res.end('ok')).listen(${port},'127.0.0.1')`,
    );
    await save(f.manager, f.root, [
      task({ ports: [port], urls: [`http://127.0.0.1:${port}`] }),
    ]);
    const target = { workspace: f.root, configurationId: "web", port };
    await expect(f.manager.previewTarget(target)).rejects.toThrow(
      "running service",
    );
    await f.manager.execute(f.root, {
      action: "start",
      commandId: randomUUID(),
      configurationId: "web",
    });
    await vi.waitFor(
      async () =>
        expect(
          await fetch(`http://127.0.0.1:${port}`).then((res) => res.text()),
        ).toBe("ok"),
      { timeout: 10000 },
    );
    const endpoint = await f.manager.previewTarget(target);
    const close = vi.fn();
    endpoint.track(close);
    await expect(
      f.manager.previewTarget({
        ...target,
        port: port === 65535 ? port - 1 : port + 1,
      }),
    ).rejects.toThrow("declared");
    await f.manager.execute(f.root, {
      action: "restart",
      commandId: randomUUID(),
      configurationId: "web",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(endpoint.signal.aborted).toBe(true);
    await vi.waitFor(
      async () =>
        expect(
          await fetch(`http://127.0.0.1:${port}`).then((res) => res.text()),
        ).toBe("ok"),
      { timeout: 10000 },
    );
  }, 20000);
  it("rejects occupied ports without adopting another server", async () => {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const f = await setup();
      const port = (server.address() as { port: number }).port;
      await save(f.manager, f.root, [task({ ports: [port] })]);
      await expect(
        f.manager.execute(f.root, {
          action: "start",
          commandId: randomUUID(),
          configurationId: "web",
        }),
      ).rejects.toThrow("already in use");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  it("bounds logs and crash restarts", async () => {
    const f = await setup(
      'for(let i=0;i<400;i++) console.log("line "+i); process.exit(7)',
    );
    await save(f.manager, f.root, [
      task({
        restartPolicy: {
          onCrash: true,
          maxRestarts: 1,
          windowMs: 60000,
          backoffMs: 100,
          maxBackoffMs: 100,
        },
      }),
    ]);
    await f.manager.execute(f.root, {
      action: "start",
      commandId: randomUUID(),
      configurationId: "web",
    });
    await vi.waitFor(
      async () =>
        expect((await f.manager.snapshot(f.root)).statuses[0]).toMatchObject({
          state: "crashed",
          restartCount: 1,
          exitCode: 7,
        }),
      { timeout: 15000 },
    );
    const status = (await f.manager.snapshot(f.root)).statuses[0]!;
    expect(status.logs.length).toBeLessThanOrEqual(80);
    expect(status.logs.at(-1)?.line).toContain("Restart limit reached");
  }, 20000);
  it("validates composite graphs and rejects network and protocol escapes", () => {
    expect(
      runDocumentSchema.safeParse({
        schemaVersion: 2,
        configurations: [
          task(),
          {
            id: "group",
            name: "Group",
            primary: false,
            kind: "composite",
            children: ["group"],
            startOrder: "parallel",
          },
        ],
      }).success,
    ).toBe(false);
    for (const url of [
      "http://169.254.169.254:8080/",
      "file:///secret",
      "http://localhost:80",
      "https://localhost:3000",
    ])
      expect(
        runDocumentSchema.safeParse({
          schemaVersion: 2,
          configurations: [task({ urls: [url] })],
        }).success,
      ).toBe(false);
  });
  it("keeps Unicode logs within the snapshot byte budget", async () => {
    const f = await setup(
      'for(let i=0;i<300;i++) console.log("界".repeat(1024)); setInterval(()=>{},1000)',
    );
    await save(f.manager, f.root, [task()]);
    await f.manager.execute(f.root, {
      action: "start",
      commandId: randomUUID(),
      configurationId: "web",
    });
    await vi.waitFor(async () =>
      expect(
        (await f.manager.snapshot(f.root)).statuses[0]!.logs.at(-1)?.sequence,
      ).toBeGreaterThan(100),
    );
    expect(
      Buffer.byteLength(
        JSON.stringify((await f.manager.snapshot(f.root)).statuses[0]!.logs),
      ),
    ).toBeLessThan(66 * 1024);
  });
  it("cancels and restarts a sequential startup without letting stale children start", async () => {
    const f = await setup();
    const port = await unusedPort();
    await save(f.manager, f.root, [
      task({
        id: "first",
        primary: false,
        healthCheck: { kind: "tcp", port, restartOnFailure: false },
      }),
      task({ id: "second", primary: false }),
      {
        id: "group",
        name: "Group",
        kind: "composite",
        primary: true,
        children: ["first", "second"],
        startOrder: "sequence",
      },
    ]);
    await f.manager.execute(f.root, {
      action: "start",
      commandId: randomUUID(),
      configurationId: "group",
    });
    await vi.waitFor(async () =>
      expect(
        (await f.manager.snapshot(f.root)).statuses.find(
          (s) => s.id === "first",
        )?.pid,
      ).toBeGreaterThan(0),
    );
    const pid = (await f.manager.snapshot(f.root)).statuses[0]!.pid;
    await f.manager.execute(f.root, {
      action: "restart",
      commandId: randomUUID(),
      configurationId: "group",
    });
    await vi.waitFor(async () => {
      const status = (await f.manager.snapshot(f.root)).statuses[0]!;
      expect(status.pid).toBeGreaterThan(0);
      expect(status.pid).not.toBe(pid);
    });
    expect(
      (await f.manager.snapshot(f.root)).statuses.find((s) => s.id === "second")
        ?.pid,
    ).toBeNull();
    await f.manager.execute(f.root, {
      action: "stop",
      commandId: randomUUID(),
      configurationId: "group",
    });
    await f.manager.shutdown();
    expect(f.manager.isInUse(f.root)).toBe(false);
  }, 15000);
});
