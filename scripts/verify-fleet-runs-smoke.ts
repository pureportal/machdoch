import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { FleetRunManager } from "../apps/client/src/core/fleet-runs.ts";

async function verify(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "machdoch-run-smoke-"));
  const manager = new FleetRunManager(async (workspace) => {
    assert.equal(workspace, root);
    return root;
  });
  const freePort = createServer();
  await new Promise<void>((done) => freePort.listen(0, "127.0.0.1", done));
  const port = (freePort.address() as { port: number }).port;
  await new Promise<void>((done) => freePort.close(() => done()));
  const waitFor = async (check: () => Promise<void>): Promise<void> => {
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        await check();
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise<void>((done) => setTimeout(done, 100));
      }
    }
  };
  const isGone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  try {
    await writeFile(join(root, "worker.cjs"), "setInterval(()=>{},1000)");
    await writeFile(
      join(root, "server.cjs"),
      `const child=require('node:child_process').spawn(process.execPath,['worker.cjs'],{stdio:'ignore'});require('node:fs').writeFileSync('child.pid',String(child.pid));require('node:http').createServer((req,res)=>res.end('ready')).listen(${port},'127.0.0.1');`,
    );
    await manager.execute(root, {
      action: "save",
      commandId: randomUUID(),
      expectedRevision: (await manager.snapshot(root)).revision,
      document: {
        schemaVersion: 2,
        configurations: [
          {
            id: "web",
            name: "Web",
            kind: "task",
            primary: true,
            command: `"${process.execPath}" server.cjs`,
            workingDirectory: ".",
            environment: {},
            hotReload: true,
            ports: [port],
            urls: [`http://127.0.0.1:${port}`],
            healthCheck: null,
            restartPolicy: {
              onCrash: false,
              maxRestarts: 1,
              windowMs: 60000,
              backoffMs: 100,
              maxBackoffMs: 100,
            },
          },
        ],
      },
    });
    await manager.execute(root, {
      action: "start",
      commandId: randomUUID(),
      configurationId: "web",
    });
    const ready = async (): Promise<void> => {
      assert.equal(
        await fetch(`http://127.0.0.1:${port}`).then((res) => res.text()),
        "ready",
      );
    };
    await waitFor(ready);
    const firstChild = Number(await readFile(join(root, "child.pid"), "utf8"));
    assert.ok(firstChild > 0);
    await manager.execute(root, {
      action: "restart",
      commandId: randomUUID(),
      configurationId: "web",
    });
    await waitFor(ready);
    await waitFor(async () =>
      assert.ok(isGone(firstChild), "Previous descendant survived restart"),
    );
    const secondChild = Number(await readFile(join(root, "child.pid"), "utf8"));
    assert.notEqual(firstChild, secondChild);
    await manager.execute(root, {
      action: "stop",
      commandId: randomUUID(),
      configurationId: "web",
    });
    await waitFor(async () =>
      assert.ok(isGone(secondChild), "Descendant survived stop"),
    );
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    console.log(
      `Passed ${process.platform} service start/restart/stop and descendant cleanup.`,
    );
  } finally {
    await manager.shutdown();
    const local = relative(tmpdir(), root);
    assert.ok(local.startsWith("machdoch-run-smoke-") && !local.includes(sep));
    await rm(root, { recursive: true, force: true });
  }
}
void verify().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
