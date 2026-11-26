import type {
  InstructionMutationInput,
  InstructionMutationResult,
  InstructionProfileView,
  InstructionRegistryResult,
} from "@machdoch/fleet-protocol/instruction-contract";

const timestamp = "2026-11-20T09:00:00.000Z";

const profile = (
  id: string,
  name: string,
  body: string,
  options: Partial<InstructionProfileView> = {},
): InstructionProfileView => ({
  id,
  name,
  body,
  createdAt: timestamp,
  updatedAt: timestamp,
  byteLength: new TextEncoder().encode(body).byteLength,
  lineCount: body.split("\n").length,
  digest: id,
  manualAssignmentCount: 0,
  enabled: true,
  global: false,
  tags: [],
  ...options,
});

let previewRegistry: InstructionRegistryResult = {
  schemaVersion: 2,
  revision: 1,
  profiles: [
    profile(
      "coding-standards",
      "Coding standards",
      "## Coding standards\n\n- Keep functions small and focused.\n- Prefer descriptive names.\n- Remove dead code.",
      { global: true, description: "Applies everywhere", tags: ["quality"] },
    ),
    profile(
      "typescript",
      "TypeScript",
      "## TypeScript\n\n- Enable strict mode.\n- Avoid `any`.\n- Prefer type-only imports.",
      {
        tags: ["frontend"],
        match: {
          op: "or",
          rules: [
            { op: "tag", tag: "typescript" },
            { op: "tag", tag: "nestjs" },
          ],
        },
      },
    ),
    profile(
      "release-checklist",
      "Release checklist",
      "## Release\n\n1. Bump the version.\n2. Update the changelog.\n3. Tag the release.",
      { manualAssignmentCount: 1 },
    ),
    profile(
      "legacy-api",
      "Legacy API notes",
      "## Legacy API\n\nUse the v1 client only for migration scripts.",
      { enabled: false, description: "Old endpoints" },
    ),
  ],
  workspaces: [
    {
      id: "preview-machdoch",
      root: "C:\\Projects\\machdoch",
      displayName: "Machdoch",
      tags: ["typescript", "tauri"],
      scopes: [{ path: ".", profiles: ["release-checklist"] }],
    },
    {
      id: "preview-alphartis",
      root: "C:\\Projects\\alphartis",
      displayName: "Alphartis",
      tags: ["nestjs"],
      scopes: [{ path: ".", profiles: [] }],
    },
  ],
};

const commit = (
  profiles: InstructionProfileView[],
  changed?: InstructionProfileView,
): InstructionMutationResult => {
  previewRegistry = {
    ...previewRegistry,
    revision: previewRegistry.revision + 1,
    profiles,
  };
  return {
    library: { revision: previewRegistry.revision },
    ...(changed ? { profile: { id: changed.id, name: changed.name } } : {}),
  };
};

const uniqueId = (name: string): string => {
  const base =
    name
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "instruction";
  const taken = new Set(previewRegistry.profiles.map(({ id }) => id));
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix++) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
};

const findProfile = (profileId: string): InstructionProfileView => {
  const found = previewRegistry.profiles.find(({ id }) => id === profileId);
  if (!found) throw new Error(`Instruction file ${profileId} does not exist.`);
  return found;
};

export const listPreviewInstructions = (): InstructionRegistryResult =>
  structuredClone(previewRegistry);

export const mutatePreviewInstructions = (
  input: InstructionMutationInput,
): InstructionMutationResult => {
  if ("expectedRevision" in input) {
    if (input.expectedRevision !== previewRegistry.revision) {
      throw new Error("The instruction library changed. Refresh and retry.");
    }
  }
  const profiles = previewRegistry.profiles;
  switch (input.operation) {
    case "profile-create": {
      const created = profile(uniqueId(input.name), input.name, input.body, {
        ...(input.description ? { description: input.description } : {}),
        enabled: input.enabled ?? true,
        global: input.global ?? false,
        tags: input.tags ?? [],
        ...(input.match ? { match: input.match } : {}),
      });
      return commit([...profiles, created], created);
    }
    case "profile-edit": {
      const current = findProfile(input.profileId);
      const body = input.body ?? current.body ?? "";
      const match =
        input.match === undefined ? current.match : (input.match ?? undefined);
      const { match: _previousMatch, ...unmatched } = current;
      const edited: InstructionProfileView = {
        ...unmatched,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        body,
        byteLength: new TextEncoder().encode(body).byteLength,
        lineCount: body.split("\n").length,
        enabled: input.enabled ?? current.enabled,
        global: input.global ?? current.global,
        tags: input.tags ?? current.tags,
        updatedAt: new Date().toISOString(),
        ...(match ? { match } : {}),
      };
      return commit(
        profiles.map((candidate) =>
          candidate.id === edited.id ? edited : candidate,
        ),
        edited,
      );
    }
    case "profile-duplicate": {
      const source = findProfile(input.profileId);
      const name = input.name ?? `${source.name} copy`;
      const copy = {
        ...source,
        id: uniqueId(name),
        name,
        manualAssignmentCount: 0,
      };
      return commit([...profiles, copy], copy);
    }
    case "profile-delete":
      findProfile(input.profileId);
      return commit(profiles.filter(({ id }) => id !== input.profileId));
    default:
      throw new Error(
        "Instruction management is only available in the desktop app.",
      );
  }
};
