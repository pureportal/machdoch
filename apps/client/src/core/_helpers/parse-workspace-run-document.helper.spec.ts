import { parseWorkspaceRunDocument } from "./parse-workspace-run-document.helper.ts";

const versionOneDocument = (): Record<string, unknown> & {
  configurations: Record<string, unknown>[];
} => ({
  schemaVersion: 1,
  primaryConfigurationId: "workspace",
  configurations: [
    {
      id: "server",
      name: "Server",
      kind: "task",
      command: "echo ready",
      workingDirectory: "apps/server",
      environment: { TOKEN: "stored-value" },
      hotReload: true,
      ports: [3000],
      urls: ["http://localhost:3000"],
      healthCheck: {
        kind: "tcp",
        host: "127.0.0.1",
        port: 3000,
        restartOnFailure: true,
        startupDelayMs: 3000,
        intervalMs: 5000,
        timeoutMs: 2000,
        failureThreshold: 3,
      },
      restartPolicy: {
        onCrash: true,
        maxRestarts: 4,
        windowMs: 60000,
        backoffMs: 1000,
        maxBackoffMs: 30000,
      },
    },
    {
      id: "workspace",
      name: "Workspace",
      kind: "composite",
      children: ["server"],
      startOrder: "sequence",
    },
  ],
});

describe("run document migration", () => {
  it.each([false, true])(
    "converts version one fields (snake_case: %s) without changing the input",
    (snakeCase) => {
      const source = versionOneDocument();
      if (snakeCase)
        for (const configuration of source.configurations)
          for (const [current, old] of [
            ["workingDirectory", "working_directory"],
            ["hotReload", "hot_reload"],
            ["healthCheck", "health_check"],
            ["restartPolicy", "restart_policy"],
            ["startOrder", "start_order"],
          ] as const)
            if (Object.hasOwn(configuration, current)) {
              configuration[old] = configuration[current];
              delete configuration[current];
            }
      const original = structuredClone(source);
      const result = parseWorkspaceRunDocument(source);
      expect(source).toEqual(original);
      expect(result).toEqual({
        migrated: true,
        document: {
          schemaVersion: 2,
          configurations: [
            {
              id: "server",
              name: "Server",
              kind: "task",
              primary: false,
              command: "echo ready",
              workingDirectory: "apps/server",
              environment: { TOKEN: "stored-value" },
              hotReload: true,
              ports: [3000],
              urls: ["http://localhost:3000"],
              healthCheck: {
                kind: "tcp",
                host: "127.0.0.1",
                port: 3000,
                restartOnFailure: true,
              },
              restartPolicy: {
                onCrash: true,
                maxRestarts: 4,
                windowMs: 60000,
                backoffMs: 1000,
                maxBackoffMs: 30000,
              },
            },
            {
              id: "workspace",
              name: "Workspace",
              kind: "composite",
              primary: true,
              children: ["server"],
              startOrder: "sequence",
            },
          ],
        },
      });
      expect(parseWorkspaceRunDocument(result.document)).toEqual({
        ...result,
        migrated: false,
      });
    },
  );

  it("migrates empty documents and fills the current defaults", () => {
    for (const source of [
      { schemaVersion: 1, configurations: [] },
      { schemaVersion: 1, primaryConfigurationId: null, configurations: [] },
    ])
      expect(parseWorkspaceRunDocument(source)).toEqual({
        migrated: true,
        document: { schemaVersion: 2, configurations: [] },
      });
    const result = parseWorkspaceRunDocument({
      schemaVersion: 1,
      primaryConfigurationId: "server",
      configurations: [
        {
          id: "server",
          name: "Server",
          kind: "task",
          command: "echo ready",
          health_check: { kind: "tcp", port: 3000 },
        },
      ],
    });
    expect(result.document.configurations[0]).toMatchObject({
      primary: true,
      workingDirectory: ".",
      hotReload: false,
      environment: {},
      ports: [],
      urls: [],
      healthCheck: { restartOnFailure: false },
      restartPolicy: { onCrash: false, maxRestarts: 5 },
    });
  });

  it.each([0, 3, "1", null, undefined])(
    "rejects an unsupported schema version: %s",
    (schemaVersion) => {
      expect(() =>
        parseWorkspaceRunDocument({ schemaVersion, configurations: [] }),
      ).toThrow();
    },
  );

  it.each([null, undefined, 123, "missing"])(
    "rejects invalid primary IDs: %s",
    (primaryConfigurationId) => {
      expect(() =>
        parseWorkspaceRunDocument({
          ...versionOneDocument(),
          primaryConfigurationId,
        }),
      ).toThrow();
    },
  );

  it.each([
    ["primary", true],
    ["working_directory", "."],
    ["command", ""],
    ["kind", "unknown"],
    ["ports", [0]],
  ])("rejects invalid or ambiguous task fields: %s", (field, value) => {
    const source = versionOneDocument();
    source.configurations[0]![field as string] = value;
    expect(() => parseWorkspaceRunDocument(source)).toThrow();
  });
});
