import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "../../core/config.js";
import { writeRalphFlow } from "../../core/ralph.js";
import { FleetCliProductRuntime } from "./cli-fleet-product.js";

it("runs a stored RALPH flow through the CLI Fleet host and reports its durable result", async () => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-fleet-ralph-"));
  let runtime: FleetCliProductRuntime | undefined;
  try {
    await writeRalphFlow(root, {
      schemaVersion: 1,
      id: "fleet-test",
      name: "Fleet test",
      blocks: [
        { id: "start", type: "START", title: "Start" },
        { id: "end", type: "END", title: "End", status: "success" },
      ],
      edges: [
        { id: "start-end", from: "start", fromOutput: "SUCCESS", to: "end" },
      ],
    });
    runtime = await FleetCliProductRuntime.create(root, {
      loadRuntimeConfig: async (...args) => ({
        ...(await loadRuntimeConfig(...args)),
        provider: "openai",
        model: "gpt-5.4",
        offline: false,
        providerAvailability: [{ provider: "openai", configured: true }],
      }),
    });
    const command = {
      kind: "ralph-run",
      commandId: "ralph-test-command",
      workspace: root,
      scope: "workspace",
      flowId: "fleet-test",
      provider: "openai",
      model: "gpt-5.4",
      reasoning: "default",
      parameters: {},
    } as const;
    await expect(
      runtime.handleRequest({ type: "executeProductCommand", command }),
    ).resolves.toMatchObject({
      type: "commandAccepted",
      receipt: { duplicate: false },
    });
    await expect(
      runtime.handleRequest({ type: "executeProductCommand", command }),
    ).resolves.toMatchObject({
      type: "commandAccepted",
      receipt: { duplicate: true },
    });
    await vi.waitFor(
      async () => {
        const response = await runtime!.handleRequest({
          type: "getProductSnapshot",
        });
        expect(response).toMatchObject({
          type: "productSnapshot",
          snapshot: {
            shell: {
              ralph: {
                flows: expect.arrayContaining([
                  expect.objectContaining({ id: "fleet-test" }),
                ]),
                runs: expect.arrayContaining([
                  expect.objectContaining({
                    flowId: "fleet-test",
                    status: "completed",
                    cancellable: false,
                  }),
                ]),
              },
            },
          },
        });
      },
      { timeout: 15_000 },
    );
  } finally {
    await runtime?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
