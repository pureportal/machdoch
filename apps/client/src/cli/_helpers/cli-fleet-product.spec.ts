import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productSnapshotSchema } from "@machdoch/fleet-protocol";
import { FleetCliProductRuntime } from "./cli-fleet-product.ts";
import { getFleetCliStatePath } from "./cli-fleet-state.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("Fleet CLI product runtime", () => {
  it("hosts persistent product snapshots and idempotent commands without Tauri", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-product-"));
    roots.push(root);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
    const workspace = join(root, "workspace");
    const runtime = await FleetCliProductRuntime.create(workspace);

    const first = await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "create-session",
        commandId: "command-create-session",
      },
    });
    const duplicate = await runtime.handleRequest({
      type: "executeProductCommand",
      command: {
        kind: "create-session",
        commandId: "command-create-session",
      },
    });
    expect(first).toEqual({
      type: "commandAccepted",
      receipt: { commandId: "command-create-session", duplicate: false },
    });
    expect(duplicate).toEqual({
      type: "commandAccepted",
      receipt: { commandId: "command-create-session", duplicate: true },
    });

    const response = await runtime.handleRequest({
      type: "getProductSnapshot",
    });
    expect(response.type).toBe("productSnapshot");
    if (response.type !== "productSnapshot") return;
    expect(productSnapshotSchema.safeParse(response.snapshot).success).toBe(
      true,
    );
    expect(response.snapshot.shell?.sessions).toHaveLength(2);
    expect(response.snapshot.shell?.workspaces).toEqual([
      expect.objectContaining({ root: workspace, sessionCount: 2 }),
    ]);
    await expect(
      readFile(getFleetCliStatePath(workspace), "utf8"),
    ).resolves.toContain("command-create-session");
    await runtime.shutdown();
  });
});
