import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRalphRunArtifactPaths } from "./create-ralph-storage-paths.helper.js";
import { isRalphRunOwnerAlive } from "./is-ralph-run-owner-alive.helper.js";
import {
  RALPH_INITIALIZATION_ARTIFACT_PREFIX,
  publishRalphInitializationRecord,
  reserveRalphRunInitialization,
} from "./ralph-run-initialization.helper.js";

describe("Ralph run initialization ownership", () => {
  const roots: string[] = [];
  const prepare = async () => {
    const root = await mkdtemp(
      join(tmpdir(), "machdoch-ralph-initialization-"),
    );
    roots.push(root);
    const paths = createRalphRunArtifactPaths(root, "unused", "run");
    return {
      root,
      paths,
      marker: join(root, `${RALPH_INITIALIZATION_ARTIFACT_PREFIX}run.json`),
    };
  };

  const abandonedClaim = async (
    marker: string,
    directory?: string,
    flowId = "flow",
  ) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs");
const input = JSON.parse(process.argv[1]);
const ownerId = process.pid + ":" + require("node:crypto").randomUUID();
fs.writeFileSync(input.marker, JSON.stringify({ schemaVersion: 1, runId: "run", flowId: input.flowId, ownerId }));
if (input.directory) fs.mkdirSync(input.directory);
process.stdout.write(ownerId);`,
        JSON.stringify({ marker, directory, flowId }),
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    expect(isRalphRunOwnerAlive(stdout)).toBe(false);
    return stdout;
  };

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps ownership until the first record is committed", async () => {
    const { root, paths, marker } = await prepare();
    await reserveRalphRunInitialization(paths, "flow");
    const claim = JSON.parse(await readFile(marker, "utf8"));
    expect(claim).toMatchObject({
      schemaVersion: 1,
      runId: paths.id,
      flowId: "flow",
    });
    expect(isRalphRunOwnerAlive(claim.ownerId)).toBe(true);
    expect(await readdir(paths.directory)).toEqual([]);
    await expect(reserveRalphRunInitialization(paths, "flow")).rejects.toThrow(
      "already has reserved artifacts",
    );
    await publishRalphInitializationRecord(paths, "flow", () =>
      writeFile(paths.recordPath, JSON.stringify({ committed: true })),
    );
    expect(await readdir(root)).toEqual([paths.id]);
    await expect(reserveRalphRunInitialization(paths, "flow")).rejects.toThrow(
      "already has reserved artifacts",
    );
  });

  it("retains ownership after a failed record write", async () => {
    const { paths, marker } = await prepare();
    await reserveRalphRunInitialization(paths, "flow");
    const claim = await readFile(marker, "utf8");
    await expect(
      publishRalphInitializationRecord(paths, "flow", async () => {
        throw new Error("Record commit failed");
      }),
    ).rejects.toThrow("Record commit failed");
    expect(await readFile(marker, "utf8")).toBe(claim);
    await expect(readFile(paths.recordPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([true, false])(
    "reclaims a dead initializer with directory present=%s",
    async (directoryPresent) => {
      const { paths, marker } = await prepare();
      const deadOwner = await abandonedClaim(
        marker,
        directoryPresent ? paths.directory : undefined,
      );
      await reserveRalphRunInitialization(paths, "flow");
      const current = JSON.parse(await readFile(marker, "utf8"));
      expect(current.ownerId).not.toBe(deadOwner);
      expect(current.ownerId).toMatch(new RegExp(`^${process.pid}:`));
      expect(await readdir(paths.directory)).toEqual([]);
      await publishRalphInitializationRecord(paths, "flow", () =>
        writeFile(paths.recordPath, "committed"),
      );
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves a committed record after its initializer dies", async () => {
    const { paths, marker } = await prepare();
    await abandonedClaim(marker, paths.directory);
    await writeFile(paths.recordPath, "committed");
    const original = await readFile(marker, "utf8");
    await expect(reserveRalphRunInitialization(paths, "flow")).rejects.toThrow(
      "already has reserved artifacts",
    );
    expect(await readFile(paths.recordPath, "utf8")).toBe("committed");
    expect(await readFile(marker, "utf8")).toBe(original);
    await publishRalphInitializationRecord(paths, "flow", () =>
      writeFile(paths.recordPath, "resumed"),
    );
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an unknown reserved directory", async () => {
    const { paths, marker } = await prepare();
    await mkdir(paths.directory);
    await expect(reserveRalphRunInitialization(paths, "flow")).rejects.toThrow(
      "already has reserved artifacts",
    );
    expect(await readdir(paths.directory)).toEqual([]);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses ownership belonging to another flow", async () => {
    const { paths, marker } = await prepare();
    await abandonedClaim(marker, paths.directory, "other-flow");
    const original = await readFile(marker, "utf8");
    await expect(reserveRalphRunInitialization(paths, "flow")).rejects.toThrow(
      "already has reserved artifacts",
    );
    await expect(
      publishRalphInitializationRecord(paths, "flow", () =>
        writeFile(paths.recordPath, "wrong"),
      ),
    ).rejects.toThrow("already has reserved artifacts");
    expect(await readFile(marker, "utf8")).toBe(original);
    await expect(readFile(paths.recordPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a record writer while another live process initializes", async () => {
    const { paths, marker } = await prepare();
    await mkdir(paths.directory);
    expect(process.ppid).toBeGreaterThan(0);
    const ownerId = `${process.ppid}:${randomUUID()}`;
    expect(isRalphRunOwnerAlive(ownerId)).toBe(true);
    await writeFile(
      marker,
      JSON.stringify({
        schemaVersion: 1,
        runId: paths.id,
        flowId: "flow",
        ownerId,
      }),
    );
    await expect(
      publishRalphInitializationRecord(paths, "flow", () =>
        writeFile(paths.recordPath, "wrong"),
      ),
    ).rejects.toThrow("already has reserved artifacts");
    await expect(readFile(paths.recordPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses malformed ownership without modifying artifacts", async () => {
    const { paths, marker } = await prepare();
    await mkdir(paths.directory);
    const original = JSON.stringify({
      schemaVersion: 1,
      runId: paths.id,
      flowId: "flow",
      ownerId: "invalid",
    });
    await writeFile(marker, original);
    await expect(reserveRalphRunInitialization(paths, "flow")).rejects.toThrow(
      "Invalid Ralph initialization ownership",
    );
    expect(await readFile(marker, "utf8")).toBe(original);
    expect(await readdir(dirname(paths.recordPath))).toEqual([]);
  });
});
