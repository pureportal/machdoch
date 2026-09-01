import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceAgentPresenceToolDefinition } from "./workspace-agent-presence-tool.js";
import {
  getWorkspacePresenceEnrollment,
  runWithWorkspaceAgentPresence,
} from "./workspace-agent-presence.js";

const originalAddress = process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
const originalToken = process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN;
const originalAgentId = process.env.MACHDOCH_WORKSPACE_AGENT_ID;

const restoreEnvironment = (): void => {
  if (originalAddress === undefined) {
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
  } else {
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = originalAddress;
  }
  if (originalToken === undefined) {
    delete process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN;
  } else {
    process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN = originalToken;
  }
  if (originalAgentId === undefined) {
    delete process.env.MACHDOCH_WORKSPACE_AGENT_ID;
  } else {
    process.env.MACHDOCH_WORKSPACE_AGENT_ID = originalAgentId;
  }
};

afterEach(restoreEnvironment);

const executePresenceTool = async () => {
  return createWorkspaceAgentPresenceToolDefinition().execute(
    {},
    {
      workspaceRoot: "C:/workspace",
      memory: {
        sessionEnabled: false,
        sessionEntries: [],
        globalEnabled: false,
        globalEntries: [],
      },
    },
  );
};

describe.sequential("workspace agent presence", () => {
  it("reports unknown when the host registry is unavailable", async () => {
    delete process.env.MACHDOCH_RUN_CONTROL_ADDRESS;
    delete process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN;

    const result = await executePresenceTool();

    expect(JSON.parse(result.toolResult.output)).toEqual({ status: "unknown" });
    expect(result.traceLines).toEqual([
      "get_active_workspace_agents -> unknown",
    ]);
  });

  it("continues task execution when presence publication is unavailable", async () => {
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = "127.0.0.1:1";
    process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN = "unavailable-token";

    const result = await runWithWorkspaceAgentPresence(
      "C:/workspace",
      "machdoch",
      "executor",
      async () => "executed",
    );

    expect(result).toBe("executed");
    expect(JSON.parse((await executePresenceTool()).toolResult.output)).toEqual(
      { status: "unknown" },
    );
  });

  it("republishes nested agents after connection loss, discovers peers, and unregisters cleanly", async () => {
    const token = "presence-token";
    const requests: Array<{
      connectionId: number;
      request: Record<string, unknown>;
    }> = [];
    const sockets = new Set<Socket>();
    const socketsByConnectionId = new Map<number, Socket>();
    const agents = new Map<string, Record<string, unknown>>([
      [
        "peer-agent",
        {
          agentId: "peer-agent",
          role: "parent",
          access: "read-only",
          activity: "executor",
          startedAt: 1,
          prompt: "sensitive prompt",
        },
      ],
    ]);
    let nextConnectionId = 1;
    const server = createServer((socket) => {
      const connectionId = nextConnectionId++;
      const ownedAgentIds = new Set<string>();
      sockets.add(socket);
      socketsByConnectionId.set(connectionId, socket);
      socket.on("close", () => {
        sockets.delete(socket);
        socketsByConnectionId.delete(connectionId);
        for (const agentId of ownedAgentIds) agents.delete(agentId);
      });
      socket.setEncoding("utf8");
      let input = "";
      socket.on("data", (chunk: string) => {
        input += chunk;
        let newline = input.indexOf("\n");
        while (newline >= 0) {
          const request = JSON.parse(input.slice(0, newline)) as Record<
            string,
            unknown
          >;
          input = input.slice(newline + 1);
          requests.push({ connectionId, request });
          const action = request.action;
          if (action === "registerPresence") {
            const registration = request.registration as Record<
              string,
              unknown
            >;
            ownedAgentIds.add(registration.agentId as string);
            agents.set(registration.agentId as string, {
              ...registration,
              startedAt: Date.now(),
            });
            socket.write(
              `${JSON.stringify({ ok: true, result: { registered: true } })}\n`,
            );
          } else if (action === "unregisterPresence") {
            ownedAgentIds.delete(request.agentId as string);
            agents.delete(request.agentId as string);
            socket.write(
              `${JSON.stringify({ ok: true, result: { registered: false } })}\n`,
            );
          } else if (action === "getPresence") {
            socket.end(
              `${JSON.stringify({
                ok: true,
                result: {
                  status: "available",
                  agents: [...agents.values()].filter(
                    (agent) => agent.agentId !== request.agentId,
                  ),
                },
              })}\n`,
            );
          }
          newline = input.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test address.");
    }
    process.env.MACHDOCH_RUN_CONTROL_ADDRESS = `127.0.0.1:${address.port}`;
    process.env.MACHDOCH_WORKSPACE_PRESENCE_TOKEN = token;

    let snapshot: Record<string, unknown> | undefined;
    let enrollment: ReturnType<typeof getWorkspacePresenceEnrollment>;
    try {
      await runWithWorkspaceAgentPresence(
        "C:/workspace",
        "machdoch",
        "executor",
        async () => {
          await expect(
            runWithWorkspaceAgentPresence(
              "C:/workspace",
              "ask",
              "validator",
              async () => {
                enrollment = getWorkspacePresenceEnrollment();
                const publisherConnectionId = requests.find(
                  ({ request }) => request.action === "registerPresence",
                )?.connectionId;
                if (publisherConnectionId === undefined) {
                  throw new Error("Expected the publisher connection.");
                }
                socketsByConnectionId.get(publisherConnectionId)?.destroy();
                await expect
                  .poll(
                    () =>
                      requests.filter(
                        ({ request }) => request.action === "registerPresence",
                      ).length,
                  )
                  .toBe(4);
                const result = await executePresenceTool();
                snapshot = JSON.parse(result.toolResult.output) as Record<
                  string,
                  unknown
                >;
                throw new Error("interrupted worker");
              },
            ),
          ).rejects.toThrow("interrupted worker");
        },
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const registrationRequests = requests.filter(
      ({ request }) => request.action === "registerPresence",
    );
    const unregisterRequests = requests.filter(
      ({ request }) => request.action === "unregisterPresence",
    );
    expect(registrationRequests).toHaveLength(4);
    expect(
      new Set(registrationRequests.map(({ connectionId }) => connectionId))
        .size,
    ).toBe(2);
    const parent = registrationRequests[0]?.request.registration as Record<
      string,
      unknown
    >;
    const worker = registrationRequests[1]?.request.registration as Record<
      string,
      unknown
    >;
    expect(
      registrationRequests.map(
        ({ request }) =>
          (request.registration as Record<string, unknown>).agentId,
      ),
    ).toEqual([parent.agentId, worker.agentId, parent.agentId, worker.agentId]);
    expect(
      registrationRequests.map(
        ({ request }) =>
          (request.registration as Record<string, unknown>).registrationKey,
      ),
    ).toEqual([
      parent.registrationKey,
      worker.registrationKey,
      parent.registrationKey,
      worker.registrationKey,
    ]);
    expect(parent).toMatchObject({
      role: "parent",
      access: "write",
      activity: "executor",
      claims: {},
    });
    expect(worker).toMatchObject({
      parentAgentId: parent.agentId,
      role: "worker",
      access: "read-only",
      activity: "validator",
      claims: {},
    });
    expect(parent).not.toHaveProperty("task");
    expect(parent).not.toHaveProperty("prompt");
    expect(enrollment).toEqual({
      address: `127.0.0.1:${address.port}`,
      token,
      agentId: worker.agentId,
    });
    expect(unregisterRequests).toHaveLength(2);
    expect(agents.size).toBe(1);
    expect(snapshot).toMatchObject({
      status: "available",
      agents: expect.arrayContaining([
        expect.objectContaining({ agentId: "peer-agent" }),
        expect.objectContaining({ agentId: parent.agentId }),
      ]),
    });
    expect(JSON.stringify(snapshot)).not.toContain("sensitive prompt");
    expect(JSON.stringify(snapshot)).not.toContain("registrationKey");
    expect(
      ((snapshot?.agents ?? []) as Array<Record<string, unknown>>).some(
        (agent) => agent.agentId === worker.agentId,
      ),
    ).toBe(false);
  });
});
