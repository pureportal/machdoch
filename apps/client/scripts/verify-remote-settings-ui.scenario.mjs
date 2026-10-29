import assert from "node:assert/strict";

const now = Math.floor(Date.now() / 1000);
const managerId = "manager_MDEyMzQ1Njc4OTAxMjM0NTY3";
const instanceId = "instance_MDEyMzQ1Njc4OTAxMjM0NTY3";
const status = (overrides = {}) => ({
  enabled: true,
  phase: "connected",
  managerUrl: "https://cloud.example.test",
  managerId,
  instanceId,
  displayName: "Workstation",
  settingsSync: {
    phase: "applied",
    profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
    profileName: "Private + Business",
    revision: 4,
    layers: [
      { profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY3", name: "Private", revision: 4 },
      { profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY4", name: "Business", revision: 9 },
    ],
    warnings: [
      'Instruction "Code style" uses the machdoch.cloud version; your version returns when it is unassigned.',
      'MCP server "GitHub" is off until the secret mcp_github_github_token is set in machdoch.cloud.',
    ],
    snapshotCapturedAt: now - 3600,
    lastAttemptAt: now - 30,
    lastAppliedAt: now - 30,
  },
  ...overrides,
});
const localSettings = {
  defaults: {
    provider: "openai",
    model: "gpt-5.6",
    mode: null,
    reasoning: null,
    webSearchProvider: null,
    theme: "dark",
    density: null,
    accent: null,
  },
  agentLimits: { infinite: null, executorTurns: null, autopilotExecutorIterations: null },
  instructions: [
    {
      id: "123e4567-e89b-42d3-a456-426614174101",
      name: "Release notes with a deliberately long name that must wrap cleanly",
      body: "Summarize user-facing changes.",
      enabled: true,
      global: true,
      tags: [],
    },
  ],
  contextPacks: [],
  prompts: [
    {
      id: "123e4567-e89b-42d3-a456-426614174102",
      relativePath: "review.prompt.md",
      content: "Review this change.",
    },
  ],
  mcpServers: [
    {
      id: "github",
      title: "GitHub",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: [],
        env: { GITHUB_TOKEN: "{{secret:mcp_github_github_token}}" },
      },
    },
  ],
};

export async function run({ state, openPanel, capture, passed, calls }) {
  let uploads = 0;
  const proposals = [];
  state.handlers.set("get_fleet_connection_status", () => status());
  state.handlers.set("cloud_workspace_request", () => ({
    ok: true,
    connections: [],
  }));
  state.handlers.set("fixture_upload_fleet_settings", () => {
    uploads++;
    return true;
  });
  state.handlers.set("fixture_export_fleet_settings", () =>
    structuredClone(localSettings),
  );
  state.handlers.set("propose_fleet_setting", (args) => {
    proposals.push(args);
    return "proposal_MDEyMzQ1Njc4OTAxMjM0NTY3";
  });

  for (const [theme, width] of [
    ["dark", 1280],
    ["light", 1280],
    ["dark", 375],
  ]) {
    const { context, page } = await openPanel({ theme, width, height: 900 });
    await page.getByRole("tab", { name: "Remote access" }).click();
    const layers = page.getByRole("list", { name: "Assigned profiles" });
    await layers.waitFor();
    assert.deepEqual(
      await layers.getByRole("listitem").allInnerTexts(),
      ["1. Private", "2. Business"],
    );
    assert.equal(
      await page
        .getByRole("list", { name: "Settings warnings" })
        .getByRole("listitem")
        .count(),
      2,
    );
    await page.getByText(/^Uploaded /).waitFor();
    await capture(page, `remote-access-${theme}-${width}`);

    await page.getByRole("button", { name: "Re-upload device settings" }).click();
    await page.getByRole("status").filter({ hasText: "Device settings uploaded." }).waitFor();

    await page.getByRole("button", { name: "Choose a setting to propose" }).click();
    const type = page.getByLabel("Setting type");
    await type.waitFor();
    assert.deepEqual(await type.locator("option").allInnerTexts(), [
      "Instruction",
      "Prompt",
      "MCP server",
    ]);
    await page.getByLabel("Note (optional)").fill("Our team writes these weekly.");
    await capture(page, `propose-${theme}-${width}`);
    await page.getByRole("button", { name: "Send proposal" }).click();
    await page
      .getByRole("status")
      .filter({ hasText: /^Sent "Release notes/ })
      .waitFor();
    await type.selectOption({ label: "MCP server" });
    await page.getByRole("button", { name: "Send proposal" }).click();
    await page.getByRole("status").filter({ hasText: 'Sent "GitHub"' }).waitFor();
    await capture(page, `proposal-sent-${theme}-${width}`);
    await context.close();
  }
  assert.equal(uploads, 3);
  assert.equal(proposals.length, 6);
  assert.deepEqual(proposals[0], {
    managerId,
    instanceId,
    proposal: {
      kind: "instruction",
      item: localSettings.instructions[0],
      note: "Our team writes these weekly.",
    },
  });
  assert.equal(proposals[1].proposal.kind, "mcpServer");
  assert.equal(proposals[1].proposal.note, undefined);
  passed("remote access shows layers, warnings, re-upload and proposals");

  state.handlers.set("get_fleet_connection_status", () =>
    status({
      settingsSync: {
        phase: "error",
        lastAttemptAt: now - 5,
        lastError: "The assigned profiles exceed the combined settings limits.",
      },
    }),
  );
  const { context, page } = await openPanel({ theme: "light", width: 1280 });
  await page.getByRole("tab", { name: "Remote access" }).click();
  await page.getByRole("alert").filter({ hasText: "combined settings limits" }).waitFor();
  await page.getByText("Not uploaded yet").waitFor();
  await page.getByRole("button", { name: "Retry sync" }).waitFor();
  await capture(page, "remote-access-error-light");
  await context.close();
  passed("sync errors stay readable without layer details");
  assert.ok(calls.length > 0);
}
