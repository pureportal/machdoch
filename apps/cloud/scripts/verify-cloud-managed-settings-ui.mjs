import assert from "node:assert/strict";

const uuid = (suffix) => `123e4567-e89b-42d3-a456-4266141741${suffix}`;

export async function run({
  api,
  capture,
  createFleetManagedSettingsEtag,
  eventually,
  fixture,
  fleetManagedSettingsDeliverySchema,
  laptop,
  page,
  passed,
  workstation,
}) {
  const { origin } = fixture;
  const profileByName = async (name) => {
    const { profiles } = await api("/settings/profiles");
    const summary = profiles.find((profile) => profile.name === name);
    assert.ok(summary, `Profile ${name} is missing`);
    return (await api(`/settings/profiles/${summary.profileId}`)).profile;
  };
  const openProfile = async (name) => {
    await page.goto(`${origin}/settings`);
    await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
  };
  const tab = (name) =>
    page
      .getByRole("tablist", { name: "Profile settings" })
      .getByRole("tab", { name, exact: true });
  const setTheme = async (theme) => {
    await page.goto(`${origin}/cloud/account`);
    await page
      .getByRole("button", {
        name: theme === "dark" ? "Dark" : "Light",
        exact: true,
      })
      .click();
  };

  await setTheme("dark");
  await page.goto(`${origin}/settings`);
  await page.getByRole("button", { name: "New profile" }).click();
  const dialog = page.getByRole("dialog", { name: "New profile" });
  await dialog.getByLabel("Name").fill("Business");
  const source = dialog.getByLabel("Start from");
  await eventually(
    async () => (await source.locator("option").count()) === 3,
    () => "Device snapshots were not offered as profile sources.",
  );
  await source.selectOption(workstation.instanceId);
  await capture("create-from-device-dark");
  await dialog.getByRole("button", { name: "Create profile" }).click();
  await page.getByRole("heading", { name: "Business", exact: true }).waitFor();
  let business = await profileByName("Business");
  assert.deepEqual(business.document.policy, { enforced: [] });
  assert.equal(business.document.instructions.length, 2);
  assert.equal(business.document.mcpServers.length, 1);
  assert.equal(business.document.defaults.theme, "dark");
  passed("profile created from a device snapshot keeps values as defaults");

  await tab("Device settings").click();
  await page.getByRole("checkbox", { name: /Workstation/ }).check();
  await page.getByRole("checkbox", { name: /Laptop/ }).check();
  const conflicts = page.getByRole("heading", { name: /^Conflicts \(\d+\)$/ });
  await conflicts.waitFor();
  assert.equal(await conflicts.textContent(), "Conflicts (2)");
  const codeStyle = page.getByRole("group", { name: /Code style/ });
  await codeStyle.getByText("Differs in:").waitFor();
  assert.match(await codeStyle.innerText(), /Use spaces/);
  await codeStyle.getByRole("radio", { name: "Keep both" }).check();
  await page
    .getByRole("group", { name: /Theme/ })
    .getByRole("radio", { name: /^Take (device|Laptop)$/ })
    .check();
  await capture("device-merge-dark");
  await page.getByRole("button", { name: "Merge settings" }).click();
  await eventually(
    async () => (await profileByName("Business")).revision > business.revision,
    () => "Device merge was not saved.",
  );
  business = await profileByName("Business");
  const names = business.document.instructions.map((item) => item.name).sort();
  assert.equal(names.length, 3, JSON.stringify(names));
  assert.ok(names.filter((name) => /^code style/i.test(name)).length === 2);
  assert.ok(names.some((name) => /^security$/i.test(name)));
  assert.equal(business.document.defaults.theme, "light");
  assert.equal(business.document.prompts.length, 1);
  assert.equal(business.document.mcpServers.length, 1);
  passed("multi-device merge dedupes identical items and keeps both versions");

  await tab("General").click();
  await page
    .getByRole("checkbox", { name: "Enforce provider and model" })
    .check();
  await capture("general-policy-dark");
  await page.getByRole("button", { name: "Save profile" }).click();
  await eventually(
    async () =>
      (await profileByName("Business")).document.policy.enforced.includes(
        "model",
      ),
    () => "Enforced model was not saved.",
  );
  passed("enforce toggle saves the policy");

  await tab("MCP servers").click();
  await page.getByText("GitHub", { exact: true }).first().waitFor();
  await capture("mcp-servers-dark");
  await tab("Secrets").click();
  await page.getByText("Referenced but not set").waitFor();
  await page.getByLabel("New MCP secret id").fill("mcp_github_github_token");
  await page
    .getByText("is already listed above. Set its value there.")
    .waitFor();
  const referencedRow = page
    .locator("form")
    .filter({ has: page.getByLabel("mcp_github_github_token value") });
  await referencedRow
    .getByLabel("mcp_github_github_token value")
    .fill("ghp_verification");
  await referencedRow
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.getByLabel("New MCP secret id").fill("mcp_jira");
  await page.getByLabel("Secret value").fill("jira_verification");
  await page.getByRole("button", { name: "Add MCP secret" }).click();
  await eventually(
    async () => {
      const ids = (await profileByName("Business")).secrets.map(
        (secret) => secret.secretId,
      );
      return (
        ids.includes("mcp_github_github_token") && ids.includes("mcp_jira")
      );
    },
    () => "MCP secrets were not saved.",
  );
  await page.getByRole("checkbox", { name: "Enforce mcp_jira" }).waitFor();
  await capture("secrets-dark");
  passed("referenced and new MCP secrets can be stored");

  const { profile: created } = await api("/settings/profiles", "POST", {
    name: "Private",
  });
  const privateDocument = structuredClone(created.document);
  privateDocument.defaults.theme = "dark";
  privateDocument.instructions = [
    {
      id: uuid("21"),
      name: "Code style",
      body: "Personal style.",
      enabled: true,
      global: true,
      tags: [],
    },
  ];
  await api(`/settings/profiles/${created.profileId}`, "PUT", {
    expectedRevision: created.revision,
    name: "Private",
    document: privateDocument,
  });

  await openProfile("Business");
  await tab("Instances").click();
  const region = page.getByRole("region", { name: "Workstation" });
  await region
    .getByLabel("Add profile to Workstation")
    .selectOption({ label: "Business" });
  await region
    .getByRole("button", { name: "Remove Business from Workstation" })
    .waitFor();
  await region
    .getByLabel("Add profile to Workstation")
    .selectOption({ label: "Private" });
  await region
    .getByRole("button", { name: "Move Private up for Workstation" })
    .click();
  const assignment = async () =>
    (await api("/settings/assignments")).assignments.find(
      (item) => item.instanceId === workstation.instanceId,
    );
  await eventually(
    async () =>
      (await assignment()).layers
        .map((layer) => layer.profileName)
        .join(",") === "Private,Business",
    () => "Stacked assignment order was not saved.",
  );
  passed("devices can stack ordered profiles");

  const current = await workstation.call("?schemaVersion=3");
  assert.equal(current.status(), 200, await current.text());
  const delivery = fleetManagedSettingsDeliverySchema.parse(
    await current.json(),
  );
  assert.equal(delivery.schemaVersion, 3);
  assert.deepEqual(
    delivery.layers.map((layer) => layer.name),
    ["Private", "Business"],
  );
  assert.equal(delivery.profile.name, "Private + Business");
  assert.equal(delivery.profile.document.defaults.provider, "openai");
  assert.equal(delivery.profile.document.defaults.theme, "dark");
  assert.ok(delivery.profile.document.policy.enforced.includes("model"));
  assert.equal(
    delivery.profile.document.instructions.find(
      (item) => item.name === "Code style",
    ).body,
    "Personal style.",
  );
  assert.equal(
    delivery.profile.secrets.mcp_github_github_token,
    "ghp_verification",
  );
  assert.equal(
    current.headers().etag,
    createFleetManagedSettingsEtag(delivery),
  );
  const notModified = await workstation.call(
    "?schemaVersion=3",
    "GET",
    undefined,
    {
      "If-None-Match": current.headers().etag,
    },
  );
  assert.equal(notModified.status(), 304);
  const legacy = fleetManagedSettingsDeliverySchema.parse(
    await (await workstation.call("")).json(),
  );
  assert.equal(legacy.schemaVersion, 2);
  assert.equal(legacy.profile.name, "Private");
  assert.equal(legacy.profile.document.policy, undefined);
  assert.equal(legacy.profile.secrets.mcp_github_github_token, undefined);
  passed(
    "devices receive composed v3 settings and old clients the first layer",
  );

  const report = await workstation.call("/sync-status", "PUT", {
    managerId: delivery.managerId,
    status: "applied",
    profileId: delivery.profile.profileId,
    revision: delivery.profile.revision,
    layers: delivery.layers.map(({ profileId, revision }) => ({
      profileId,
      revision,
    })),
    warnings: [
      "Code style: your local version is hidden while Private is active.",
    ],
  });
  assert.equal(report.status(), 204, await report.text());
  await page.reload();
  await tab("Instances").click();
  await region.getByText(/your local version is hidden/).waitFor();
  await capture("instances-dark");
  passed("per-layer status and device warnings appear in the dashboard");

  await region
    .getByRole("button", { name: "Request fresh snapshot from Workstation" })
    .click();
  await eventually(
    async () => (await (await workstation.call("/snapshot")).json()).requested,
    () => "Snapshot refresh was not requested.",
  );
  const reupload = await workstation.call("/snapshot", "PUT", {
    ...(await api(`/settings/instances/${workstation.instanceId}/enrollment`))
      .document,
  });
  assert.equal(reupload.status(), 204, await reupload.text());
  assert.equal(
    (await (await workstation.call("/snapshot")).json()).requested,
    false,
  );
  passed("admins can request a fresh device snapshot");

  for (const proposal of [
    {
      kind: "instruction",
      item: {
        id: uuid("31"),
        name: "Release notes",
        body: "Summarize user-facing changes.",
        enabled: true,
        global: true,
        tags: [],
      },
      note: "Useful for everyone",
    },
    {
      kind: "prompt",
      item: {
        id: uuid("32"),
        relativePath: "review.prompt.md",
        content: "Review this change for security problems.",
      },
    },
    {
      kind: "mcpServer",
      item: {
        id: "jira",
        title: "Jira",
        enabled: true,
        transport: {
          type: "streamable-http",
          url: "https://mcp.example.test/jira",
          headers: { Authorization: "Bearer {{secret:mcp_jira}}" },
        },
      },
    },
  ]) {
    const response = await laptop.call("/proposals", "POST", proposal);
    assert.equal(response.status(), 201, await response.text());
  }
  await page.goto(`${origin}/settings`);
  await page
    .getByRole("heading", { name: /Proposals from devices \(3\)/ })
    .waitFor();
  await capture("proposals-dark");
  const instruction = page.getByRole("article", {
    name: "Instruction Release notes",
  });
  await instruction
    .getByLabel("Profile for Instruction Release notes")
    .selectOption({ label: "Business" });
  await instruction
    .getByRole("button", { name: "Accept Instruction Release notes" })
    .click();
  await page
    .getByRole("heading", { name: /Proposals from devices \(2\)/ })
    .waitFor();
  const prompt = page.getByRole("article", { name: "Prompt review.prompt.md" });
  await prompt.getByLabel("Profile for Prompt review.prompt.md").selectOption({
    label: "Business",
  });
  await prompt.getByRole("radio", { name: "Keep both" }).check();
  await capture("proposal-existing-dark");
  await prompt
    .getByRole("button", { name: "Accept Prompt review.prompt.md" })
    .click();
  await page
    .getByRole("article", { name: "MCP server Jira" })
    .getByRole("button", { name: "Reject MCP server Jira" })
    .click();
  await page
    .getByRole("alertdialog", { name: "Reject MCP server Jira?" })
    .getByRole("button", { name: "Reject proposal" })
    .click();
  await eventually(
    async () => (await api("/settings/proposals")).proposals.length === 0,
    () => "Proposals were not resolved.",
  );
  const accepted = (await profileByName("Business")).document;
  assert.ok(
    accepted.instructions.some((item) => item.name === "Release notes"),
  );
  assert.equal(accepted.prompts.length, 2, JSON.stringify(accepted.prompts));
  assert.ok(!accepted.mcpServers.some((server) => server.id === "jira"));
  passed(
    "device proposals can be accepted, kept next to existing items, or rejected",
  );

  await setTheme("light");
  await openProfile("Business");
  await capture("profile-light");
  await tab("Instances").click();
  await capture("instances-light");
  await tab("Device settings").click();
  await page.getByRole("checkbox", { name: /Laptop/ }).check();
  await capture("device-merge-light");

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${origin}/settings`);
  await page
    .getByRole("combobox", { name: "Profile", exact: true })
    .selectOption({ label: "Business" });
  await page.getByRole("heading", { name: "Business", exact: true }).waitFor();
  await capture("profile-mobile-light");
  const loaded = async () =>
    eventually(
      async () =>
        (await page.getByRole("status").filter({ hasText: /^Loading / }).count()) ===
        0,
      () => "Settings section did not finish loading.",
    );
  for (const [section, name, ready] of [
    ["instances", "instances-mobile-light", "Workstation"],
    ["mcp", "mcp-servers-mobile-light", "GitHub"],
    ["device-settings", "device-merge-mobile-light", /^Conflicts \(\d+\)$/],
  ]) {
    await page
      .getByRole("combobox", { name: "Profile section" })
      .selectOption(section);
    await loaded();
    if (section === "device-settings") {
      await page.getByRole("checkbox", { name: /Laptop/ }).check();
      await loaded();
      await page.getByRole("checkbox", { name: /Workstation/ }).check();
      await loaded();
    }
    await page.getByText(ready).first().waitFor();
    await capture(name);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  passed("settings screens fit a 375px viewport");
}
