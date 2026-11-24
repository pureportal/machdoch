import { describe, expect, it } from "vitest";
import { builtinRoles, type PermissionHolder } from "./cloud-permissions";
import {
  legacySettingsHref,
  legacySettingsSection,
  settingsNavigation,
  settingsSectionAccess,
  settingsSectionIds,
  settingsTeamTree,
} from "./settings-navigation";

const holder = (role: keyof typeof builtinRoles): PermissionHolder => ({
  owner: role === "owner",
  permissions: builtinRoles[role].permissions,
});

describe("settings navigation", () => {
  it("lists the required groups and sections for owners", () => {
    const navigation = settingsNavigation(holder("owner"));
    expect(
      navigation.map((group) => [
        group.label,
        group.entries.map((entry) => entry.label),
      ]),
    ).toEqual([
      [
        "Personal",
        [
          "Preferences",
          "Profile",
          "Notifications",
          "Code & reviews",
          "Security & access",
          "Connected accounts",
          "Agent personalization",
        ],
      ],
      ["Issues", ["Labels", "Workflow states", "SLAs", "Templates"]],
      ["Projects", ["Labels", "Statuses", "Updates"]],
      [
        "Features",
        [
          "AI & agents",
          "Execution",
          "Loops",
          "Initiatives",
          "Customer requests",
          "Releases",
          "Pulse",
          "Integrations",
        ],
      ],
      [
        "Administration",
        [
          "Members",
          "Roles",
          "Invitations",
          "SSO",
          "Email",
          "Branding",
          "Mimorii",
        ],
      ],
    ]);
  });

  it("finds sections by keyword", () => {
    const found = settingsNavigation(holder("member"), "2FA").flatMap((group) =>
      group.entries.map((entry) => entry.id),
    );
    expect(found).toEqual(["security"]);
    expect(
      settingsNavigation(holder("owner"), "saml").flatMap((group) =>
        group.entries.map((entry) => entry.id),
      ),
    ).toEqual(["sso"]);
    expect(
      settingsNavigation(holder("member"), "connector").flatMap((group) =>
        group.entries.map((entry) => entry.id),
      ),
    ).toEqual(["connected-accounts"]);
  });

  it("filters by role and marks read-only sections", () => {
    const viewer = holder("viewer");
    expect(settingsSectionAccess(viewer, "preferences")).toBe("edit");
    expect(settingsSectionAccess(viewer, "issue-labels")).toBe("read");
    expect(settingsSectionAccess(viewer, "sso")).toBe("hidden");
    expect(settingsSectionAccess(viewer, "ai")).toBe("hidden");
    expect(settingsSectionAccess(holder("member"), "members")).toBe("read");
    expect(settingsSectionAccess(holder("member"), "issue-labels")).toBe(
      "edit",
    );
    expect(settingsSectionAccess(holder("guest"), "releases")).toBe("hidden");
    for (const id of settingsSectionIds)
      expect(settingsSectionAccess(holder("owner"), id)).toBe("edit");
    const viewerIds = settingsNavigation(viewer).flatMap((group) =>
      group.entries.map((entry) => entry.id),
    );
    expect(viewerIds).not.toContain("invitations");
    expect(viewerIds).toContain("loops");
    expect(
      settingsNavigation(viewer)
        .flatMap((group) => group.entries)
        .find((entry) => entry.id === "members")?.access,
    ).toBe("read");
  });

  it("redirects every legacy settings route to a section", () => {
    expect(legacySettingsSection("account")).toBe("preferences");
    expect(legacySettingsSection("account", "security")).toBe("security");
    expect(legacySettingsSection("account", "sessions")).toBe("security");
    expect(legacySettingsSection("account", "git")).toBe("connected-accounts");
    expect(legacySettingsSection("account", "privacy")).toBe("preferences");
    expect(legacySettingsSection("connections")).toBe("security");
    expect(legacySettingsSection("providers")).toBe("ai");
    expect(legacySettingsSection("execution")).toBe("execution");
    expect(legacySettingsSection("settings", "organization")).toBe("branding");
    expect(legacySettingsSection("settings", "authentication")).toBe("sso");
    expect(legacySettingsSection("settings", "git")).toBe("integrations");
    expect(legacySettingsSection("settings", "email")).toBe("email");
    expect(legacySettingsSection("settings", "mimorii")).toBe("mimorii");
    expect(legacySettingsSection("settings", "unknown")).toBe("preferences");
  });

  it("keeps query parameters when redirecting old routes", () => {
    expect(
      legacySettingsHref("account", { tab: "git", gitError: "expired" }),
    ).toBe("/cloud/settings/connected-accounts?gitError=expired");
    expect(legacySettingsHref("execution", { project: "p1" })).toBe(
      "/cloud/settings/execution?project=p1",
    );
    expect(legacySettingsHref("connections", {})).toBe(
      "/cloud/settings/security",
    );
  });

  it("builds the nested team tree", () => {
    const tree = settingsTeamTree([
      { id: "b", name: "AlphaNET Cloud", parentId: "a" },
      { id: "a", name: "Software Engineering", parentId: null },
      { id: "c", name: "Design", parentId: null },
      { id: "d", name: "Orphan", parentId: "missing" },
    ]);
    expect(tree.map((node) => node.path)).toEqual([
      "Design",
      "Orphan",
      "Software Engineering",
    ]);
    expect(tree[2]?.children.map((node) => node.path)).toEqual([
      "Software Engineering › AlphaNET Cloud",
    ]);
  });
});
