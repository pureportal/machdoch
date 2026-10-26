import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cloudApi,
  cloudBrowserFixture,
  createPasswordInvitation,
} from "./cloud-browser-fixture.mjs";
import { oidcFixture } from "./cloud-oidc-fixture.mjs";

let dropCreation = false,
  dropAcceptance = false;
const fixture = await cloudBrowserFixture({
  serverEntry: "scripts/cloud-email-fixture.ts",
  dropResponse: ({ path, status }) =>
    (dropCreation && path === "/api/v1/invitations" && status === 201) ||
    (dropAcceptance && path === "/api/v1/invitations/accept" && status === 200),
});
const owner = await fixture.ownerContext.newPage();
const providers = [];
const checks = [];
const api = (path, method, data) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data);
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function providerSignIn(page, provider, subject) {
  await page.waitForURL(
    (url) =>
      url.origin === provider.issuer ||
      ["/cloud/sso", "/cloud/join"].includes(url.pathname),
  );
  for (
    let step = 0;
    step < 4 && new URL(page.url()).origin === provider.issuer;
    step++
  ) {
    await page
      .getByRole("heading", { name: /Provider (sign-in|consent)/ })
      .waitFor();
    const previous = page.url();
    await page.getByLabel("Subject", { exact: true }).fill(subject);
    await Promise.all([
      page.waitForURL((url) => url.href !== previous),
      page.getByRole("button", { name: "Continue", exact: true }).click(),
    ]);
  }
  await page.waitForURL((url) =>
    ["/cloud/sso", "/cloud/join"].includes(url.pathname),
  );
  assert.equal(
    new URL(page.url()).searchParams.get("failed"),
    null,
    fixture.logs(),
  );
}
async function configureProvider(context, page, name) {
  const provider = await oidcFixture(fixture);
  providers.push(provider);
  const metadata = await cloudApi(
    fixture,
    context,
    "sso-providers/discover",
    "POST",
    { issuer: provider.issuer },
  );
  const id = randomUUID();
  await cloudApi(fixture, context, `sso-providers/${id}`, "PATCH", {
    name,
    metadata,
    clientId: "cloud-fixture",
    authentication: "client_secret_basic",
    algorithm: "RS256",
    displaySource: "userinfo",
    displayClaim: "email",
    requiredAcr: null,
    maxAge: null,
    revision: 0,
    secret: provider.secret,
    enabled: true,
  });
  const link = await cloudApi(fixture, context, "sso-link", "POST", {
    providerId: id,
  });
  await page.goto(link.url);
  await providerSignIn(page, provider, "owner-subject");
  await page
    .getByRole("button", { name: "Link identity", exact: true })
    .click();
  await page.waitForURL("**/cloud/account");
  await page.getByRole("tab", { name: "Security", exact: true }).click();
  return { ...provider, id, name };
}
async function invitedProviderSignIn(page, provider, subject) {
  await Promise.all([
    page.waitForURL((url) => url.origin === provider.issuer),
    page
      .getByRole("button", {
        name: `Sign in with ${provider.name}`,
        exact: true,
      })
      .click(),
  ]);
  await providerSignIn(page, provider, subject);
}
async function signInSso(context, page, provider, subject) {
  const start = await cloudApi(fixture, context, "auth/sso/start", "POST", {
    providerId: provider.id,
  });
  await page.goto(start.url);
  await providerSignIn(page, provider, subject);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/cloud/issues");
}
async function showInvitation(page, url, email) {
  await page.goto(url);
  await page.getByText(email, { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "");
  assert.ok(new URL(page.url()).searchParams.has("confirmation"));
}
try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const workspace = await api("workspace");
  const organizationId = workspace.organization.id;
  await owner.goto(`${fixture.origin}/cloud/settings`);
  await owner.getByRole("tab", { name: "Members", exact: true }).click();
  let blockOptions = true;
  await owner.route("**/api/v1/invitations/options", (route) =>
    blockOptions
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Sign-in methods are unavailable. Try again.",
            code: "unavailable",
          }),
        })
      : route.continue(),
  );
  await owner
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  const dialog = owner.getByRole("dialog", {
    name: "Invite member",
    exact: true,
  });
  await dialog
    .getByRole("alert")
    .filter({ hasText: "methods are unavailable" })
    .waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "Create invitation", exact: true })
      .isEnabled(),
    false,
  );
  blockOptions = false;
  await dialog
    .getByRole("button", { name: "Load sign-in methods", exact: true })
    .click();
  await dialog.getByLabel("Sign-in method", { exact: true }).waitFor();
  await owner.unroute("**/api/v1/invitations/options");
  await dialog.getByLabel("Email", { exact: true }).fill("local@example.test");
  await dialog
    .getByLabel("Sign-in method", { exact: true })
    .selectOption("password");
  dropCreation = true;
  await dialog
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_invitations WHERE email='local@example.test'",
      )
    ).rows[0].count,
    1,
  );
  dropCreation = false;
  await dialog
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  const localUrl = await owner
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  const serialized = JSON.stringify(
    (await fixture.database.query("SELECT result FROM cloud_command_receipts"))
      .rows,
  );
  assert.equal(serialized.includes(new URL(localUrl).hash.slice(1)), false);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_outbox WHERE kind='member.invited'",
      )
    ).rows[0].count,
    1,
  );
  passed(
    "Creates one encrypted invitation after a lost administrator response and preserves the entered fields for retry",
  );

  const localContext = await fixture.createContext({
    viewport: { width: 390, height: 844 },
  });
  const local = await localContext.newPage();
  assert.equal((await localContext.request.get(localUrl)).status(), 200);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_users WHERE email='local@example.test'",
      )
    ).rows[0].count,
    0,
  );
  await showInvitation(local, localUrl, "local@example.test");
  const confirmationUrl = local.url();
  await local.reload();
  await local.getByLabel("Name", { exact: true }).waitFor();
  await local.getByLabel("Name", { exact: true }).fill("Local member");
  await local.getByLabel("Password", { exact: true }).fill(fixture.password);
  await local.screenshot({
    path: join(fixture.directory, "invitation-mobile.png"),
    animations: "disabled",
  });
  dropAcceptance = true;
  await local
    .getByRole("button", { name: "Join organization", exact: true })
    .click();
  await local
    .locator("p[role=alert]")
    .filter({ hasText: "did not confirm" })
    .waitFor();
  dropAcceptance = false;
  const accepted = (
    await fixture.database.query(
      "SELECT c.session_hash,i.accepted_by FROM cloud_invitation_confirmations c JOIN cloud_invitations i ON i.id=c.invitation_id WHERE i.email='local@example.test'",
    )
  ).rows[0];
  assert.ok(accepted.session_hash);
  assert.ok(accepted.accepted_by);
  await fixture.restart();
  await local.goto(confirmationUrl);
  await local.getByRole("button", { name: "Continue", exact: true }).click();
  await local.waitForURL("**/cloud/issues");
  assert.equal(
    (await cloudApi(fixture, localContext, "workspace")).actor.id,
    accepted.accepted_by,
  );
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_sessions WHERE user_id=$1",
        [accepted.accepted_by],
      )
    ).rows[0].count,
    1,
  );
  passed(
    "Scanner GETs do not join, raw tokens leave the URL, reload preserves confirmation, and restart recovery restores exactly one new-member session",
  );

  const otherOrganization = randomUUID();
  await fixture.database.query(
    "INSERT INTO cloud_organizations(id,name) VALUES($1,'Other company')",
    [otherOrganization],
  );
  await fixture.database.query(
    "INSERT INTO cloud_memberships(organization_id,user_id,role) VALUES($1,$2,'owner')",
    [otherOrganization, workspace.actor.id],
  );
  const otherOwner = await fixture.createContext();
  await cloudApi(fixture, otherOwner, "auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
    organizationId: otherOrganization,
  });
  const otherInvite = await createPasswordInvitation(fixture, otherOwner, {
    email: "local@example.test",
    role: "viewer",
  });
  await showInvitation(local, otherInvite.url, "local@example.test");
  assert.equal(await local.getByLabel("Name", { exact: true }).count(), 0);
  assert.equal(
    await local.getByLabel("Account password", { exact: true }).count(),
    0,
  );
  await local
    .getByRole("button", { name: "Join organization", exact: true })
    .click();
  await local.waitForURL("**/cloud/issues");
  const otherWorkspace = await cloudApi(fixture, localContext, "workspace");
  assert.equal(otherWorkspace.organization.id, otherOrganization);
  assert.equal(otherWorkspace.actor.role, "viewer");
  assert.equal(otherWorkspace.actor.name, "Local member");
  const originalRole = (
    await fixture.database.query(
      "SELECT role FROM cloud_memberships WHERE organization_id=$1 AND user_id=$2",
      [organizationId, accepted.accepted_by],
    )
  ).rows[0].role;
  assert.equal(originalRole, "member");
  passed(
    "An existing password-authenticated account joins another organization without re-entering credentials or changing its original role/profile",
  );

  const navigationContext = await fixture.createContext();
  const navigation = await navigationContext.newPage();
  const first = await createPasswordInvitation(fixture, fixture.ownerContext, {
    email: "navigation-one@example.test",
    role: "member",
  });
  const second = await createPasswordInvitation(fixture, fixture.ownerContext, {
    email: "navigation-two@example.test",
    role: "viewer",
  });
  await showInvitation(navigation, first.url, "navigation-one@example.test");
  await navigation.evaluate((value) => {
    location.hash = new URL(value).hash;
  }, second.url);
  await navigation
    .getByText("navigation-two@example.test", { exact: true })
    .waitFor();
  await navigation.goBack();
  await navigation
    .getByText("navigation-one@example.test", { exact: true })
    .waitFor();
  await navigation.goForward();
  await navigation
    .getByText("navigation-two@example.test", { exact: true })
    .waitFor();
  const secondConfirmation = navigation.url();
  const independent = await fixture.createContext();
  const independentPage = await independent.newPage();
  await independentPage.goto(secondConfirmation);
  await independentPage
    .locator("p[role=alert]")
    .filter({ hasText: "invitation is unavailable" })
    .waitFor();
  await showInvitation(
    independentPage,
    second.url,
    "navigation-two@example.test",
  );
  await independentPage
    .getByLabel("Name", { exact: true })
    .fill("Second member");
  await independentPage
    .getByLabel("Password", { exact: true })
    .fill(fixture.password);
  await independentPage
    .getByRole("button", { name: "Join organization", exact: true })
    .click();
  await independentPage.waitForURL("**/cloud/issues");
  await navigation.reload();
  await navigation
    .locator("p[role=alert]")
    .filter({ hasText: "invitation is unavailable" })
    .waitFor();
  passed(
    "Fragment changes and back/forward navigation select the correct invitation; another device needs the original link and only one confirmation can win",
  );

  const stale = await createPasswordInvitation(fixture, fixture.ownerContext, {
    email: "stale@example.test",
    role: "member",
  });
  await showInvitation(navigation, stale.url, "stale@example.test");
  await navigation.getByLabel("Name", { exact: true }).fill("Stale draft");
  await navigation
    .getByLabel("Password", { exact: true })
    .fill(fixture.password);
  await cloudApi(fixture, navigationContext, "auth/login", "POST", {
    email: "local@example.test",
    password: fixture.password,
    organizationId,
  });
  await navigation
    .getByRole("button", { name: "Join organization", exact: true })
    .click();
  await navigation
    .locator("p[role=alert]")
    .filter({ hasText: "account changed" })
    .waitFor();
  assert.equal(
    (
      await fixture.database.query(
        "SELECT id FROM cloud_users WHERE email='stale@example.test'",
      )
    ).rows.length,
    0,
  );
  await navigation
    .getByRole("button", { name: "Review invitation", exact: true })
    .click();
  await navigation
    .getByText(
      "Joining as stale@example.test will replace local@example.test in this browser.",
      { exact: true },
    )
    .waitFor();
  passed(
    "An account change after preview requires a fresh review before a join can replace the browser's session",
  );

  const targetProvider = await configureProvider(
    fixture.ownerContext,
    owner,
    "Work identity",
  );
  const otherOwnerPage = await otherOwner.newPage();
  const sourceProvider = await configureProvider(
    otherOwner,
    otherOwnerPage,
    "Source identity",
  );
  const existing = await cloudApi(
    fixture,
    otherOwner,
    `sso-providers/${sourceProvider.id}/members`,
    "POST",
    {
      email: "existing-sso@example.test",
      name: "Existing person",
      role: "member",
      subject: "source-subject",
    },
  );
  const sourceContext = await fixture.createContext();
  const sourcePage = await sourceContext.newPage();
  await signInSso(sourceContext, sourcePage, sourceProvider, "source-subject");
  await owner.goto(`${fixture.origin}/cloud/settings`);
  await owner.getByRole("tab", { name: "Members", exact: true }).click();
  await owner
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  const ssoDialog = owner.getByRole("dialog", {
    name: "Invite member",
    exact: true,
  });
  await ssoDialog
    .getByLabel("Email", { exact: true })
    .fill("existing-sso@example.test");
  await ssoDialog
    .getByLabel("Sign-in method", { exact: true })
    .selectOption(targetProvider.id);
  await ssoDialog.getByLabel("Subject", { exact: true }).fill("target-subject");
  await ssoDialog
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await ssoDialog.waitFor({ state: "hidden" });
  const ssoUrl = await owner
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  const targetContext = await fixture.createContext();
  const target = await targetContext.newPage();
  await showInvitation(target, ssoUrl, "existing-sso@example.test");
  assert.equal(await target.getByLabel("Password", { exact: true }).count(), 0);
  await invitedProviderSignIn(target, targetProvider, "wrong-subject");
  await target
    .locator("p[role=alert]")
    .filter({ hasText: "does not match" })
    .waitFor();
  assert.equal(
    await target
      .getByRole("button", { name: "Join organization", exact: true })
      .count(),
    0,
  );
  await invitedProviderSignIn(target, targetProvider, "target-subject");
  await target
    .getByRole("button", { name: "Join organization", exact: true })
    .click();
  await target.waitForURL("**/cloud/issues");
  assert.equal(
    (await cloudApi(fixture, targetContext, "workspace")).actor.id,
    existing.userId,
  );
  const sourceWorkspace = await cloudApi(fixture, sourceContext, "workspace");
  assert.equal(sourceWorkspace.organization.id, otherOrganization);
  assert.equal(sourceWorkspace.actor.id, existing.userId);
  const globalIdentity = (
    await fixture.database.query(
      "SELECT name,password_hash FROM cloud_users WHERE id=$1",
      [existing.userId],
    )
  ).rows[0];
  assert.deepEqual(globalIdentity, {
    name: "Existing person",
    password_hash: null,
  });
  assert.equal(
    (
      await fixture.database.query(
        "SELECT subject FROM cloud_sso_mappings WHERE organization_id=$1 AND user_id=$2",
        [otherOrganization, existing.userId],
      )
    ).rows[0].subject,
    "source-subject",
  );
  passed(
    "An existing SSO-only account joins through an explicit target-realm subject; a different subject is rejected despite the same profile email, and source-realm identity/session remain unchanged",
  );

  await api("sso-policy", "PATCH", { required: true, revision: 0 });
  await signInSso(fixture.ownerContext, owner, targetProvider, "owner-subject");
  await owner.goto(`${fixture.origin}/cloud/settings`);
  await owner.getByRole("tab", { name: "Members", exact: true }).click();
  await owner
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  const requiredDialog = owner.getByRole("dialog", {
    name: "Invite member",
    exact: true,
  });
  await requiredDialog.getByLabel("Sign-in method", { exact: true }).waitFor();
  assert.equal(
    await requiredDialog.locator('option[value="password"]').count(),
    0,
  );
  await requiredDialog
    .getByLabel("Email", { exact: true })
    .fill("required@example.test");
  await requiredDialog
    .getByLabel("Role", { exact: true })
    .selectOption("viewer");
  await requiredDialog
    .getByLabel("Sign-in method", { exact: true })
    .selectOption(targetProvider.id);
  await requiredDialog
    .getByLabel("Subject", { exact: true })
    .fill("required-subject");
  await requiredDialog
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await requiredDialog.waitFor({ state: "hidden" });
  const requiredUrl = await owner
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  const requiredContext = await fixture.createContext();
  const requiredPage = await requiredContext.newPage();
  await showInvitation(requiredPage, requiredUrl, "required@example.test");
  await invitedProviderSignIn(requiredPage, targetProvider, "required-subject");
  await requiredPage
    .getByLabel("Name", { exact: true })
    .fill("Required SSO member");
  assert.equal(
    await requiredPage.getByLabel("Password", { exact: true }).count(),
    0,
  );
  await requiredPage
    .getByRole("button", { name: "Join organization", exact: true })
    .click();
  await requiredPage.waitForURL("**/cloud/issues");
  assert.equal(
    (await cloudApi(fixture, requiredContext, "workspace")).actor.role,
    "viewer",
  );
  assert.equal(
    (
      await fixture.database.query(
        "SELECT password_hash FROM cloud_users WHERE email='required@example.test'",
      )
    ).rows[0].password_hash,
    null,
  );
  passed(
    "Required-SSO invitations create a new passwordless member with the assigned role and no local-password bypass",
  );

  const adminInvite = await api("invitations", "POST", {
    organizationId,
    email: "administrator@example.test",
    role: "admin",
    authentication: {
      kind: "oidc",
      providerId: targetProvider.id,
      subject: "administrator-subject",
    },
  });
  const adminContext = await fixture.createContext();
  const administrator = await adminContext.newPage();
  await showInvitation(
    administrator,
    adminInvite.url,
    "administrator@example.test",
  );
  await invitedProviderSignIn(
    administrator,
    targetProvider,
    "administrator-subject",
  );
  await administrator.getByLabel("Name", { exact: true }).fill("Administrator");
  await administrator
    .getByRole("button", { name: "Join organization", exact: true })
    .click();
  await administrator.waitForURL("**/cloud/issues");
  await administrator.goto(`${fixture.origin}/cloud/settings`);
  await administrator
    .getByRole("tab", { name: "Authentication", exact: true })
    .click();
  await administrator
    .getByRole("button", { name: "Identities for Work identity", exact: true })
    .waitFor();
  assert.equal(
    await administrator
      .getByRole("button", { name: "Add provider", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await administrator
      .getByRole("button", { name: "Edit Work identity", exact: true })
      .count(),
    0,
  );
  await administrator.getByRole("tab", { name: "Email", exact: true }).click();
  assert.equal(
    await administrator
      .getByRole("button", { name: "Configure email", exact: true })
      .count(),
    0,
  );
  const adminCsrf = (await adminContext.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  const adminHeaders = {
    Origin: fixture.origin,
    "x-machdoch-cloud-csrf": adminCsrf,
    "Idempotency-Key": randomUUID(),
  };
  const {
    id: configuredId,
    verified: _configuredVerified,
    ...configured
  } = (await api("sso-providers")).providers[0];
  const deniedProvider = await adminContext.request.patch(
    `${fixture.origin}/api/v1/sso-providers/${configuredId}`,
    {
      headers: adminHeaders,
      data: {
        ...configured,
        secret: "untrusted-secret",
        metadata: {
          ...configured.metadata,
          token_endpoint: "https://untrusted.example.test/token",
          jwks_uri: "https://untrusted.example.test/jwks",
        },
      },
    },
  );
  assert.equal(deniedProvider.status(), 403);
  assert.equal((await deniedProvider.json()).code, "owner_required");
  const deniedEmail = await adminContext.request.patch(
    `${fixture.origin}/api/v1/email-settings`,
    {
      headers: adminHeaders,
      data: {
        revision: 0,
        host: "smtp.example.test",
        port: 465,
        security: "tls",
        tlsName: null,
        username: null,
        from: "signin@example.test",
        enabled: true,
      },
    },
  );
  assert.equal(deniedEmail.status(), 403);
  assert.equal((await deniedEmail.json()).code, "owner_required");
  const ordinary = await cloudApi(
    fixture,
    adminContext,
    "invitations",
    "POST",
    {
      organizationId,
      email: "ordinary@example.test",
      role: "member",
      authentication: {
        kind: "oidc",
        providerId: targetProvider.id,
        subject: "ordinary-subject",
      },
    },
  );
  assert.ok(ordinary.url);
  await administrator
    .getByRole("button", { name: "Identities for Work identity", exact: true })
    .click();
  assert.equal(
    await administrator
      .getByRole("button", {
        name: "Remove identity for owner@example.test",
        exact: true,
      })
      .count(),
    0,
  );
  await administrator
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  passed(
    "Administrators retain ordinary invitations and identity management while owner sign-in roots are protected in both UI and HTTP APIs",
  );

  const raceInvite = await api("invitations", "POST", {
    organizationId,
    email: "race@example.test",
    role: "member",
    authentication: {
      kind: "oidc",
      providerId: targetProvider.id,
      subject: "race-subject",
    },
  });
  const raceContext = await fixture.createContext();
  const racePage = await raceContext.newPage();
  await showInvitation(racePage, raceInvite.url, "race@example.test");
  await invitedProviderSignIn(racePage, targetProvider, "race-subject");
  await racePage
    .getByRole("button", { name: "Join organization", exact: true })
    .waitFor();
  const raceConfirmation = new URL(racePage.url()).searchParams.get(
    "confirmation",
  );
  const racePreview = await cloudApi(
    fixture,
    raceContext,
    "invitations/preview",
    "POST",
    { confirmationId: raceConfirmation },
  );
  const ownerCsrf = (await fixture.ownerContext.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
  ).value;
  const started = Date.now();
  const [joined, revoked] = await Promise.all([
    raceContext.request.post(`${fixture.origin}/api/v1/invitations/accept`, {
      headers: { Origin: fixture.origin },
      data: {
        confirmationId: raceConfirmation,
        sessionId: racePreview.currentSessionId,
        name: "Race person",
      },
    }),
    fixture.ownerContext.request.post(
      `${fixture.origin}/api/v1/invitations/${raceInvite.id}/revoke`,
      {
        headers: {
          Origin: fixture.origin,
          "x-machdoch-cloud-csrf": ownerCsrf,
          "Idempotency-Key": randomUUID(),
        },
        data: {},
      },
    ),
  ]);
  assert.ok(
    (joined.status() === 200 && revoked.status() === 409) ||
      (joined.status() === 410 && revoked.status() === 200),
    `Join/revoke outcome ${joined.status()}/${revoked.status()}: ${fixture.logs()}`,
  );
  assert.ok(Date.now() - started < 5000);
  const joinedMembers = (
    await fixture.database.query(
      "SELECT count(*)::int AS count FROM cloud_memberships m JOIN cloud_users u ON u.id=m.user_id WHERE m.organization_id=$1 AND u.email='race@example.test'",
      [organizationId],
    )
  ).rows[0].count;
  assert.equal(joinedMembers, joined.status() === 200 ? 1 : 0);
  passed(
    "Concurrent invitation acceptance and revocation have one authoritative outcome without a lock timeout or false revocation audit",
  );
  const logoutInvite = await api("invitations", "POST", {
    organizationId,
    email: "logout-race@example.test",
    role: "member",
    authentication: {
      kind: "oidc",
      providerId: targetProvider.id,
      subject: "logout-race-subject",
    },
  });
  const logoutContext = await fixture.createContext();
  await cloudApi(fixture, logoutContext, "auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
    organizationId: otherOrganization,
  });
  const logoutPage = await logoutContext.newPage();
  await showInvitation(
    logoutPage,
    logoutInvite.url,
    "logout-race@example.test",
  );
  await invitedProviderSignIn(
    logoutPage,
    targetProvider,
    "logout-race-subject",
  );
  await logoutPage
    .getByRole("button", { name: "Join organization", exact: true })
    .waitFor();
  const logoutConfirmation = new URL(logoutPage.url()).searchParams.get(
    "confirmation",
  );
  const logoutPreview = await cloudApi(
    fixture,
    logoutContext,
    "invitations/preview",
    "POST",
    { confirmationId: logoutConfirmation },
  );
  const logoutCookies = await logoutContext.cookies();
  const logoutHeaders = {
    Origin: fixture.origin,
    Cookie: logoutCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; "),
    "x-machdoch-cloud-csrf": logoutCookies.find(
      (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
    ).value,
  };
  const logoutStarted = Date.now();
  const [joinResult, logoutResult] = await Promise.all([
    logoutContext.request.post(`${fixture.origin}/api/v1/invitations/accept`, {
      headers: logoutHeaders,
      data: {
        confirmationId: logoutConfirmation,
        sessionId: logoutPreview.currentSessionId,
        name: "Logout race",
      },
    }),
    logoutContext.request.post(`${fixture.origin}/api/v1/auth/logout`, {
      headers: logoutHeaders,
      data: {},
    }),
  ]);
  assert.ok(
    [200, 410].includes(joinResult.status()),
    `${joinResult.status()}: ${fixture.logs()}`,
  );
  assert.equal(logoutResult.status(), 200);
  assert.ok(Date.now() - logoutStarted < 5000);
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_sessions s JOIN cloud_users u ON u.id=s.user_id WHERE u.email='logout-race@example.test'",
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await fixture.database.query(
        "SELECT count(*)::int AS count FROM cloud_invitation_confirmations WHERE id=$1",
        [logoutConfirmation],
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await sourceContext.request.get(`${fixture.origin}/api/v1/workspace`)
    ).status(),
    200,
  );
  passed(
    "A logout racing with invitation completion removes the browser proof and any winning session without affecting the source realm's other browser",
  );

  assert.deepEqual(fixture.pageErrors, []);
  assert.ok(providers.every((provider) => provider.errors.length === 0));
  await writeFile(
    join(fixture.directory, "invitation-results.json"),
    JSON.stringify(
      {
        checks,
        pageErrors: fixture.pageErrors,
        providerErrors: providers.flatMap((provider) => provider.errors),
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${fixture.directory}`);
} catch (error) {
  dropAcceptance = false;
  dropCreation = false;
  await owner.screenshot({
    path: join(fixture.directory, "invitations-failure.png"),
    animations: "disabled",
  });
  const pages = await Promise.allSettled(
    fixture.ownerContext
      .browser()
      .contexts()
      .flatMap((context) => context.pages())
      .map(async (page) => ({
        path: new URL(page.url()).pathname,
        alerts: await page.locator("p[role=alert]").allTextContents(),
      })),
  );
  await writeFile(
    join(fixture.directory, "invitation-failure.json"),
    JSON.stringify(
      {
        checks,
        error: error.stack,
        logs: fixture.logs(),
        pageErrors: fixture.pageErrors,
        pages,
        providerErrors: providers.flatMap((provider) => provider.errors),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const provider of providers) await provider.close();
  await fixture.close();
}
