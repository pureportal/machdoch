import assert from "node:assert/strict";

export async function verifyDesignInteractions({
  fixture,
  page,
  api,
  data,
  capture,
}) {
  const dialog = page.getByRole("dialog");
  await page.keyboard.press("Control+k");
  await dialog.getByRole("combobox").fill("Projects");
  await capture("command-palette", { audit: true });
  await page.keyboard.press("Enter");
  await page.waitForURL("**/cloud/projects");
  await dialog.waitFor({ state: "hidden" });
  await page.goto(`${fixture.origin}/cloud/issues`);
  await page.getByLabel("Search issues", { exact: true }).fill("Reconnect");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForURL(/query=Reconnect/);
  assert.equal(await page.locator(".cloud-table tbody tr").count(), 1);
  await page.getByRole("button", { name: "Board view", exact: true }).click();
  await page.waitForURL(/view=board/);
  assert.equal(new URL(page.url()).searchParams.get("query"), "Reconnect");
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.waitForURL((url) => !url.searchParams.has("query"));
  await page.getByRole("button", { name: "New issue", exact: true }).click();
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Verify the redesigned workspace");
  await capture("new-issue-dialog", { audit: true });
  await dialog
    .getByRole("button", { name: "Create issue", exact: true })
    .click();
  await page.waitForURL(/\/cloud\/issues\/[a-f0-9-]+$/);
  const createdId = new URL(page.url()).pathname.split("/").at(-1);
  assert.equal(
    (await api(`issues/${createdId}`)).title,
    "Verify the redesigned workspace",
  );
  await page.goto(`${fixture.origin}/cloud/issues/${data.issues[0].id}`);
  await page
    .getByLabel("Comment", { exact: true })
    .fill("Keep this draft while planning.");
  await page.getByRole("tab", { name: "Planning poker", exact: true }).click();
  await page.getByRole("button", { name: "Start poker", exact: true }).click();
  await page.getByRole("button", { name: "Vote 5", exact: true }).click();
  await page
    .locator('button[aria-label="Vote 5"][aria-pressed="true"]')
    .waitFor();
  await capture("planning-poker", { audit: true });
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  assert.equal(
    await page.getByLabel("Comment", { exact: true }).inputValue(),
    "Keep this draft while planning.",
  );
  await page.getByRole("button", { name: "Post comment", exact: true }).click();
  await page
    .getByText("Keep this draft while planning.", { exact: true })
    .waitFor();
  await page.getByRole("tab", { name: "Relationships", exact: true }).click();
  await page.getByRole("button", { name: "Link issue", exact: true }).click();
  await dialog.getByRole("heading").waitFor();
  await capture("issue-relationship-dialog", { audit: true });
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "AI tasks", exact: true }).click();
  await page
    .locator(".cloud-issue-tasks .cloud-task-list li")
    .first()
    .waitFor();
  await capture("issue-tasks", { audit: true });
  await page.goto(`${fixture.origin}/cloud/settings`);
  for (const name of ["Members", "Authentication", "Email"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await capture(`settings-${name.toLowerCase()}`, { audit: true });
  }
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await dialog
    .getByLabel("Email", { exact: true })
    .fill("designer@example.test");
  await capture("invite-member-dialog", { audit: true });
  await page.keyboard.press("Escape");
  await page.goto(`${fixture.origin}/cloud/account`);
  for (const name of ["Security", "Sessions"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await capture(`account-${name.toLowerCase()}`, { audit: true });
  }
  await page.goto(`${fixture.origin}/cloud/schedules`);
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Release review");
  await capture("schedule-dialog", { audit: true });
  await page.keyboard.press("Escape");
  await page.goto(`${fixture.origin}/cloud/providers`);
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Design review");
  await capture("provider-dialog", { audit: true });
  await page.keyboard.press("Escape");
  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("Review environment");
  await capture("execution-dialog", { audit: true });
  await page.keyboard.press("Escape");
}
