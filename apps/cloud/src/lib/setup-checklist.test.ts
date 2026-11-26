import { describe, expect, it } from "vitest";
import { builtinRoles, type PermissionHolder } from "./cloud-permissions";
import { setupChecklist, type SetupFacts } from "./setup-checklist";

const holder = (role: keyof typeof builtinRoles): PermissionHolder => ({
  owner: role === "owner",
  permissions: builtinRoles[role].permissions,
});

const fresh: SetupFacts = {
  gitConnections: 0,
  repositories: 0,
  personalGitAccount: false,
  aiProviders: 0,
  executionProfiles: 0,
  members: 1,
  invitations: 0,
};

describe("setup checklist", () => {
  it("starts a new workspace with connecting GitHub", () => {
    const steps = setupChecklist(holder("owner"), fresh);
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["git", false],
      ["ai", false],
      ["execution", false],
      ["members", false],
    ]);
    expect(steps[0]!.href).toBe("/cloud/settings/integrations?connect=github");
  });

  it("adds repository and personal account steps once GitHub is connected", () => {
    const steps = setupChecklist(holder("owner"), {
      ...fresh,
      gitConnections: 1,
      aiProviders: 1,
      invitations: 2,
    });
    expect(steps.map((step) => [step.id, step.done])).toEqual([
      ["git", true],
      ["repositories", false],
      ["account", false],
      ["ai", true],
      ["execution", false],
      ["members", true],
    ]);
  });

  it("marks everything done for a fully configured workspace", () => {
    const steps = setupChecklist(holder("owner"), {
      gitConnections: 1,
      repositories: 3,
      personalGitAccount: true,
      aiProviders: 1,
      executionProfiles: 1,
      members: 4,
      invitations: 0,
    });
    expect(steps.every((step) => step.done)).toBe(true);
  });

  it("shows members only the steps they can complete", () => {
    expect(
      setupChecklist(holder("member"), fresh).map((step) => step.id),
    ).toEqual([]);
    expect(
      setupChecklist(holder("member"), { ...fresh, gitConnections: 1 }).map(
        (step) => [step.id, step.href],
      ),
    ).toEqual([["account", "/cloud/settings/connected-accounts"]]);
  });
});
