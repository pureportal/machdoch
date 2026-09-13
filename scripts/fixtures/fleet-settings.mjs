import {
  emptySettingsDocument,
  secretDescriptors,
  validateSettingsDocument,
} from "../../apps/fleet-manager/src/server/settings.ts";

const limits = {
  maximumProfiles: 64,
  maximumInstructionsPerProfile: 128,
  maximumPacksPerProfile: 128,
  maximumPromptsPerProfile: 128,
  maximumRevisionsPerProfile: 100,
  maximumDocumentBytes: 1024 * 1024,
  maximumSecretBytes: 8192,
};

export function fleetSettingsFixture() {
  const profiles = ["Alpha", "Beta", "Gamma"].map((name) => ({
    profileId: `profile_${name.toLowerCase()}`,
    name,
    description: `${name} settings`,
    revision: 1,
    document: emptySettingsDocument(),
    secrets: [],
    createdAt: 1789260000,
    updatedAt: 1789260000,
  }));
  const versions = new Map(
    profiles.map((profile) => [
      profile.profileId,
      [{ ...structuredClone(profile), changeSummary: "Created profile" }],
    ]),
  );
  const assignments = [
    {
      instanceId: "instance_settings_review",
      displayName: "Review host",
      instanceStatus: "offline",
      profileId: null,
      profileName: null,
      profileRevision: null,
      assignedAt: null,
      lastAppliedRevision: null,
      lastAppliedAt: null,
      syncStatus: "unassigned",
      lastSyncRevision: null,
      lastSyncAttemptAt: null,
      syncError: null,
    },
  ];
  const holds = new Map();
  const failures = new Map();
  const state = {
    profiles,
    assignments,
    requests: [],
    failNext(method, path, status = 503) {
      failures.set(`${method} ${path}`, status);
    },
    holdNext(method, path) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      holds.set(`${method} ${path}`, promise);
      return release;
    },
    async install(page) {
      await page.route("**/api/settings/**", async (route) => {
        const request = route.request();
        const method = request.method();
        const path = new URL(request.url()).pathname.slice(
          "/api/settings/".length,
        );
        const key = `${method} ${path}`;
        const parts = path.split("/");
        const profile = profiles.find((item) => item.profileId === parts[1]);
        const captured = profile ? structuredClone(profile) : null;
        const failure = failures.get(key);
        failures.delete(key);
        const hold = holds.get(key);
        holds.delete(key);
        state.requests.push({
          method,
          path,
          body: parts[2] === "secrets" ? undefined : request.postDataJSON(),
        });
        if (hold) await hold;
        if (failure)
          return route.fulfill({
            status: failure,
            json: {
              error:
                failure === 409
                  ? "Profile changed. Reload the profile and try again."
                  : "Settings request failed. Try again.",
            },
          });
        if (method === "GET") {
          if (path === "catalog")
            return route.fulfill({
              json: { secrets: secretDescriptors, limits },
            });
          if (path === "assignments")
            return route.fulfill({ json: { assignments } });
          if (path === "profiles")
            return route.fulfill({ json: { profiles: profiles.map(summary) } });
          if (parts[2] === "versions")
            return route.fulfill({
              json: {
                versions: [...versions.get(profile.profileId)].reverse(),
              },
            });
          return route.fulfill({ json: { profile: captured } });
        }
        const body = request.postDataJSON();
        if (parts[0] === "instances") {
          const assignment = assignments.find(
            (item) => item.instanceId === parts[1],
          );
          const assigned = profiles.find(
            (item) => item.profileId === body.profileId,
          );
          Object.assign(assignment, {
            profileId: assigned?.profileId ?? null,
            profileName: assigned?.name ?? null,
            profileRevision: assigned?.revision ?? null,
            syncStatus: assigned ? "pending" : "unassigned",
          });
          return route.fulfill({ json: { ok: true } });
        }
        if (path === "profiles" && method === "POST") {
          const created = {
            ...structuredClone(profiles[0]),
            profileId: `profile_created_${state.requests.length}`,
            name: body.name,
            description: body.description,
            revision: 1,
            document: emptySettingsDocument(),
            secrets: [],
          };
          profiles.push(created);
          versions.set(created.profileId, [
            { ...structuredClone(created), changeSummary: "Created profile" },
          ]);
          return route.fulfill({ json: { profile: created } });
        }
        if (method === "DELETE" && parts.length === 2) {
          profiles.splice(profiles.indexOf(profile), 1);
          return route.fulfill({ json: { ok: true } });
        }
        if (body.expectedRevision !== profile.revision)
          return route.fulfill({
            status: 409,
            json: {
              error: "Profile changed. Reload the profile and try again.",
            },
          });
        if (parts[2] === "secrets") {
          profile.secrets = profile.secrets.filter(
            (item) => item.secretId !== parts[3],
          );
          if (method === "PUT")
            profile.secrets.push({
              secretId: parts[3],
              lastFour: body.value.slice(-4),
              updatedAt: 1789260001,
            });
        } else if (parts[2] === "versions") {
          const restored = versions
            .get(profile.profileId)
            .find((item) => item.revision === Number(parts[3]));
          Object.assign(profile, {
            document: structuredClone(restored.document),
            name: restored.name,
            description: restored.description,
          });
        } else {
          try {
            validateSettingsDocument(body.document, limits);
          } catch (error) {
            return route.fulfill({
              status: 400,
              json: { error: error.message },
            });
          }
          Object.assign(profile, {
            name: body.name,
            description: body.description,
            document: body.document,
          });
        }
        profile.revision++;
        versions.get(profile.profileId).push({
          ...structuredClone(profile),
          changeSummary: body.changeSummary ?? "Updated profile",
        });
        return route.fulfill({ json: { profile } });
      });
    },
  };
  function summary(profile) {
    return {
      ...profile,
      document: undefined,
      secrets: undefined,
      instructionCount: profile.document.instructions.length,
      contextPackCount: profile.document.contextPacks.length,
      promptCount: profile.document.prompts.length,
      secretCount: profile.secrets.length,
      assignmentCount: assignments.filter(
        (item) => item.profileId === profile.profileId,
      ).length,
    };
  }
  return state;
}
