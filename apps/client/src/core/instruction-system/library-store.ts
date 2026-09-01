import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getUserConfigPath } from "../env.js";
import {
  sameFileObjectIdentity,
  sameFileSnapshotIdentity,
} from "../_helpers/same-file-identity.helper.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";
import {
  writeFileAtomically,
  writeJsonAtomically,
} from "../_helpers/write-file-atomically.helper.js";
import {
  INSTRUCTION_LIBRARY_SCHEMA_VERSION,
  InstructionSystemError,
  type InstructionLibrary,
  type InstructionLibraryExport,
  type InstructionLibraryImportChoices,
  type InstructionLibraryRecoveryStatus,
  type InstructionProfile,
  type InstructionTagRule,
  type InstructionStoreMutationResult,
  type InstructionWorkspaceBinding,
  type ProfileId,
} from "./types.js";
import {
  normalizeInstructionTagRule,
  normalizeInstructionTags,
} from "./tag-rules.js";
import {
  MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH,
  MAX_INSTRUCTION_PROFILE_NAME_LENGTH,
  MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH,
} from "./limits.js";
import {
  canonicalizeExistingWorkspaceRoot,
  canonicalDigest,
  hasAsciiControlCharacter,
  normalizeInstructionBody,
  normalizeProfileName,
  normalizeScopePath,
  profileNameKey,
  sha256,
  unicodeCodePointLength,
} from "./normalization.js";
import { readOpenedFileExactly } from "../_helpers/read-opened-file-exactly.helper.js";
import { hasUnpairedUtf16Surrogate } from "../../shared/unicode.js";

const MAX_INSTRUCTION_LIBRARY_BYTES = 64 * 1024 * 1024;
const MAX_INSTRUCTION_AUDIT_READ_BYTES = 2 * 1024 * 1024;
const LEGACY_INSTRUCTION_LIBRARY_SCHEMA_VERSION = 1;

export const getInstructionLibraryPath = (): string =>
  join(dirname(getUserConfigPath()), "instruction-library.json");

export const createEmptyInstructionLibrary = (): InstructionLibrary => ({
  schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
  revision: 0,
  profiles: [],
  workspaces: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errorCode = "INSTRUCTION_LIBRARY_INVALID",
): void => {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new InstructionSystemError(
      errorCode,
      `${label} contains unsupported fields: ${unexpected.join(", ")}.`,
    );
  }
};

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const isScopeAncestor = (ancestor: string, descendant: string): boolean =>
  ancestor === "." ||
  descendant === ancestor ||
  descendant.startsWith(`${ancestor}/`);

const assertProfileCanBeAssignedManually = (
  profile: InstructionProfile,
  assignmentLabel: string,
): void => {
  if (profile.global) {
    throw new InstructionSystemError(
      "REDUNDANT_PROFILE_ASSIGNMENT",
      `${assignmentLabel} references global profile ${profile.id}, which is already applied everywhere.`,
    );
  }
  if (profile.match !== undefined) {
    throw new InstructionSystemError(
      "AUTOMATIC_PROFILE_ASSIGNMENT",
      `${assignmentLabel} references tag-matched profile ${profile.id}. Remove its tag rule before assigning it manually.`,
    );
  }
};

const assertManualWorkspaceAssignments = (
  workspaceLabel: string,
  scopes: readonly { path: string; profiles: readonly string[] }[],
  profileById: ReadonlyMap<string, InstructionProfile>,
): void => {
  const pathsByProfile = new Map<string, string[]>();
  for (const scope of scopes) {
    for (const profileId of scope.profiles) {
      const profile = profileById.get(profileId);
      if (!profile) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_INVALID_REFERENCE",
          `${workspaceLabel} references missing profile ${profileId}.`,
        );
      }
      assertProfileCanBeAssignedManually(
        profile,
        `${workspaceLabel} scope "${scope.path}"`,
      );
      const overlap = (pathsByProfile.get(profileId) ?? []).find(
        (path) =>
          isScopeAncestor(path, scope.path) ||
          isScopeAncestor(scope.path, path),
      );
      if (overlap) {
        throw new InstructionSystemError(
          "REDUNDANT_PROFILE_ASSIGNMENT",
          `${workspaceLabel} assigns profile ${profileId} at overlapping scopes "${overlap}" and "${scope.path}".`,
        );
      }
      pathsByProfile.set(profileId, [
        ...(pathsByProfile.get(profileId) ?? []),
        scope.path,
      ]);
    }
  }
};

const isRfc3339DateTime = (value: string): boolean => {
  const match =
    /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})(?:\.\d+)?(?:[Zz]|(?<offsetSign>[+-])(?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/u.exec(
      value,
    );
  if (!match?.groups || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  const second = Number(match.groups.second);
  const offsetHour = Number(match.groups.offsetHour ?? 0);
  const offsetMinute = Number(match.groups.offsetMinute ?? 0);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
};

const requireString = (
  value: unknown,
  field: string,
  options: { optional?: boolean; max?: number } = {},
): string | undefined => {
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} must be a string.`,
    );
  }
  if (
    unicodeCodePointLength(value) > (options.max ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} is too long.`,
    );
  }
  return value;
};

const normalizeWorkspaceDisplayName = (
  value: string,
  field: string,
): string => {
  const normalized = value.trim().normalize("NFKC");
  if (!normalized) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} cannot be empty.`,
    );
  }
  if (
    unicodeCodePointLength(normalized) >
    MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} cannot exceed ${MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH} characters.`,
    );
  }
  if (hasAsciiControlCharacter(normalized)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} cannot contain control characters.`,
    );
  }
  if (hasUnpairedUtf16Surrogate(normalized)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} must contain valid Unicode text.`,
    );
  }
  return normalized;
};

const normalizeProfileDescription = (
  value: string,
  field: string,
): string | undefined => {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (
    unicodeCodePointLength(normalized) >
    MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} cannot exceed ${MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH} characters.`,
    );
  }
  if (hasAsciiControlCharacter(normalized)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} cannot contain control characters.`,
    );
  }
  if (hasUnpairedUtf16Surrogate(normalized)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} must contain valid Unicode text.`,
    );
  }
  return normalized;
};

const parseProfile = (value: unknown, index: number): InstructionProfile => {
  if (!isRecord(value) || !isUuid(value.id)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `profiles[${index}] must contain a UUID id.`,
    );
  }
  assertExactKeys(
    value,
    [
      "id",
      "name",
      "description",
      "body",
      "enabled",
      "global",
      "tags",
      "match",
      "createdAt",
      "updatedAt",
    ],
    `profiles[${index}]`,
  );
  const name = normalizeProfileName(
    requireString(value.name, `profiles[${index}].name`) ?? "",
  );
  const body = normalizeInstructionBody(
    requireString(value.body, `profiles[${index}].body`) ?? "",
    `profile "${name}"`,
  );
  const createdAt =
    requireString(value.createdAt, `profiles[${index}].createdAt`) ?? "";
  const updatedAt =
    requireString(value.updatedAt, `profiles[${index}].updatedAt`) ?? "";
  if (!isRfc3339DateTime(createdAt) || !isRfc3339DateTime(updatedAt)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `Profile "${name}" has an invalid timestamp.`,
    );
  }
  const rawDescription = requireString(
    value.description,
    `profiles[${index}].description`,
    { optional: true, max: MAX_INSTRUCTION_PROFILE_DESCRIPTION_LENGTH },
  );
  const description =
    rawDescription === undefined
      ? undefined
      : normalizeProfileDescription(
          rawDescription,
          `profiles[${index}].description`,
        );
  if (typeof value.enabled !== "boolean") {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `profiles[${index}].enabled must be a boolean.`,
    );
  }
  if (typeof value.global !== "boolean") {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `profiles[${index}].global must be a boolean.`,
    );
  }
  if (!Object.hasOwn(value, "tags")) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `profiles[${index}].tags is required.`,
    );
  }
  const tags = normalizeInstructionTags(value.tags, `profiles[${index}].tags`);
  const match =
    value.match === undefined
      ? undefined
      : normalizeInstructionTagRule(value.match, `profiles[${index}].match`);
  return {
    id: value.id,
    name,
    ...(description === undefined ? {} : { description }),
    body,
    enabled: value.enabled,
    global: value.global,
    tags,
    ...(match === undefined ? {} : { match }),
    createdAt,
    updatedAt,
  };
};

const parseProfileIds = (
  value: unknown,
  field: string,
  knownIds: ReadonlySet<string>,
): string[] => {
  if (!Array.isArray(value)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} must be an array.`,
    );
  }
  if (value.length === 0) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} must contain at least one profile. Remove the empty scope instead.`,
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, id] of value.entries()) {
    if (!isUuid(id) || !knownIds.has(id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID_REFERENCE",
        `${field}[${index}] references unknown profile ${String(id)}.`,
      );
    }
    if (seen.has(id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_REFERENCE",
        `${field} contains profile ${id} more than once.`,
      );
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

const parseWorkspace = (
  value: unknown,
  index: number,
  profileIds: ReadonlySet<string>,
): InstructionWorkspaceBinding => {
  if (!isRecord(value) || !isUuid(value.id)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `workspaces[${index}] must contain a UUID id.`,
    );
  }
  assertExactKeys(
    value,
    ["id", "root", "displayName", "tags", "scopes"],
    `workspaces[${index}]`,
  );
  const root = requireString(value.root, `workspaces[${index}].root`) ?? "";
  if (hasUnpairedUtf16Surrogate(root)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `Workspace root must contain valid Unicode text.`,
    );
  }
  if (!root || resolve(root) !== root) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `Workspace root "${root}" must be absolute.`,
    );
  }
  if (!Array.isArray(value.scopes)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `workspaces[${index}].scopes must be an array.`,
    );
  }
  if (!Object.hasOwn(value, "tags")) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `workspaces[${index}].tags is required.`,
    );
  }
  const scopeKeys = new Set<string>();
  const scopes = value.scopes.map((scope, scopeIndex) => {
    if (!isRecord(scope)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `workspaces[${index}].scopes[${scopeIndex}] must be an object.`,
      );
    }
    assertExactKeys(
      scope,
      ["path", "profiles"],
      `workspaces[${index}].scopes[${scopeIndex}]`,
    );
    const path = normalizeScopePath(
      requireString(
        scope.path,
        `workspaces[${index}].scopes[${scopeIndex}].path`,
      ) ?? "",
    );
    const key =
      process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
    if (scopeKeys.has(key)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_SCOPE",
        `Workspace ${root} contains duplicate scope "${path}".`,
      );
    }
    scopeKeys.add(key);
    return {
      path,
      profiles: parseProfileIds(
        scope.profiles,
        `workspaces[${index}].scopes[${scopeIndex}].profiles`,
        profileIds,
      ),
    };
  });

  const rawDisplayName = requireString(
    value.displayName,
    `workspaces[${index}].displayName`,
    {
      optional: true,
      max: MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH,
    },
  );
  const displayName =
    rawDisplayName === undefined
      ? undefined
      : normalizeWorkspaceDisplayName(
          rawDisplayName,
          `workspaces[${index}].displayName`,
        );
  if (rawDisplayName !== undefined && rawDisplayName !== displayName) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `workspaces[${index}].displayName must use its normalized form.`,
    );
  }
  return {
    id: value.id,
    root,
    ...(displayName === undefined ? {} : { displayName }),
    tags: normalizeInstructionTags(value.tags, `workspaces[${index}].tags`),
    scopes,
  };
};

export const parseInstructionLibrary = (value: unknown): InstructionLibrary => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== INSTRUCTION_LIBRARY_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Array.isArray(value.profiles) ||
    !Array.isArray(value.workspaces)
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `The instruction library does not match schema version ${INSTRUCTION_LIBRARY_SCHEMA_VERSION}.`,
    );
  }
  assertExactKeys(
    value,
    ["schemaVersion", "revision", "profiles", "workspaces"],
    "instruction library",
  );
  const profiles = value.profiles.map(parseProfile);
  const profileIds = new Set<string>();
  const profileNames = new Set<string>();
  for (const profile of profiles) {
    if (profileIds.has(profile.id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_ID",
        `Duplicate profile id ${profile.id}.`,
      );
    }
    const nameKey = profileNameKey(profile.name);
    if (profileNames.has(nameKey)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_NAME",
        `Duplicate normalized profile name "${profile.name}".`,
      );
    }
    profileIds.add(profile.id);
    profileNames.add(nameKey);
  }

  const workspaces = value.workspaces.map((workspace, index) =>
    parseWorkspace(workspace, index, profileIds),
  );
  const workspaceIds = new Set<string>();
  const workspaceRoots = new Map<string, string>();
  for (const workspace of workspaces) {
    if (workspaceIds.has(workspace.id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_ID",
        `Duplicate workspace id ${workspace.id}.`,
      );
    }
    workspaceIds.add(workspace.id);
    const rootKey =
      process.platform === "win32"
        ? resolve(workspace.root).toLocaleLowerCase("en-US")
        : resolve(workspace.root);
    if (workspaceRoots.has(rootKey)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_WORKSPACE",
        `Workspace root ${workspace.root} is configured more than once.`,
      );
    }
    workspaceRoots.set(rootKey, workspace.id);
  }

  for (const profile of profiles) {
    if (profile.global && !profile.enabled) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `Global profile ${profile.id} must be enabled.`,
      );
    }
    if (profile.global && profile.match !== undefined) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `Global profile ${profile.id} cannot also have an automatic tag rule.`,
      );
    }
  }
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  for (const workspace of workspaces) {
    assertManualWorkspaceAssignments(
      `Workspace ${workspace.root}`,
      workspace.scopes,
      profileById,
    );
  }

  return {
    schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
    revision: Number(value.revision),
    profiles,
    workspaces,
  };
};

const parseLegacyProfileIds = (
  value: unknown,
  field: string,
  knownIds: ReadonlySet<string>,
): string[] => {
  if (!Array.isArray(value)) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      `${field} must be an array.`,
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, id] of value.entries()) {
    if (!isUuid(id) || !knownIds.has(id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID_REFERENCE",
        `${field}[${index}] references unknown profile ${String(id)}.`,
      );
    }
    if (seen.has(id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_REFERENCE",
        `${field} contains profile ${id} more than once.`,
      );
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
};

/**
 * Schema 1 was the persisted format through v0.45. Its defaults list became
 * per-profile global metadata in schema 2, while identity hints and empty
 * scopes were removed. Keep the public parser strict; compatibility belongs
 * only at the persisted-store boundary so imports still require the current
 * contract.
 */
const migrateLegacyInstructionLibrary = (
  value: unknown,
): InstructionLibrary => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== LEGACY_INSTRUCTION_LIBRARY_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 0 ||
    !Array.isArray(value.profiles) ||
    !Array.isArray(value.workspaces) ||
    !isRecord(value.defaults)
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID",
      "The legacy instruction library does not match schema version 1.",
    );
  }
  assertExactKeys(
    value,
    ["schemaVersion", "revision", "profiles", "defaults", "workspaces"],
    "legacy instruction library",
  );
  assertExactKeys(
    value.defaults,
    ["profiles"],
    "legacy instruction library defaults",
  );

  const profileIds = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    if (!isRecord(profile) || !isUuid(profile.id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `profiles[${index}] must contain a UUID id.`,
      );
    }
    assertExactKeys(
      profile,
      [
        "id",
        "name",
        "description",
        "body",
        "enabled",
        "global",
        "tags",
        "match",
        "createdAt",
        "updatedAt",
      ],
      `profiles[${index}]`,
    );
    if (profileIds.has(profile.id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_ID",
        `Duplicate profile id ${profile.id}.`,
      );
    }
    if (profile.enabled !== undefined && typeof profile.enabled !== "boolean") {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `profiles[${index}].enabled must be a boolean.`,
      );
    }
    if (profile.global !== undefined && typeof profile.global !== "boolean") {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `profiles[${index}].global must be a boolean.`,
      );
    }
    profileIds.add(profile.id);
  }

  const defaultProfiles = parseLegacyProfileIds(
    value.defaults.profiles,
    "defaults.profiles",
    profileIds,
  );
  const defaultProfileIds = new Set(defaultProfiles);
  const migratedProfiles = value.profiles.map((rawProfile) => {
    const profile = rawProfile as Record<string, unknown>;
    const id = profile.id as string;
    const enabled = profile.enabled !== false;
    const wasGlobal = defaultProfileIds.has(id);
    if (profile.global !== undefined && profile.global !== wasGlobal) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `Profile ${id} global metadata does not match defaults.profiles.`,
      );
    }
    if (wasGlobal && profile.match !== undefined) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `Global profile ${id} cannot also have an automatic tag rule.`,
      );
    }
    return {
      id,
      name: profile.name,
      ...(profile.description === undefined
        ? {}
        : { description: profile.description }),
      body: profile.body,
      enabled,
      // Schema 2 global files must be active. A disabled schema 1 default
      // remains disabled and becomes unassigned, preserving effective output.
      global: wasGlobal && enabled,
      tags: profile.tags === undefined ? [] : profile.tags,
      ...(profile.match === undefined ? {} : { match: profile.match }),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  });
  const manuallyAssignableIds = new Set(
    migratedProfiles
      .filter(
        (profile) =>
          !defaultProfileIds.has(profile.id) && profile.match === undefined,
      )
      .map((profile) => profile.id),
  );

  const migratedWorkspaces = value.workspaces.map((rawWorkspace, index) => {
    if (!isRecord(rawWorkspace) || !isUuid(rawWorkspace.id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `workspaces[${index}] must contain a UUID id.`,
      );
    }
    assertExactKeys(
      rawWorkspace,
      ["id", "root", "displayName", "identityHints", "tags", "scopes"],
      `workspaces[${index}]`,
    );
    if (rawWorkspace.identityHints !== undefined) {
      if (!isRecord(rawWorkspace.identityHints)) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_INVALID",
          `workspaces[${index}].identityHints must be an object.`,
        );
      }
      assertExactKeys(
        rawWorkspace.identityHints,
        ["gitRemote", "repositoryId"],
        `workspaces[${index}].identityHints`,
      );
      requireString(
        rawWorkspace.identityHints.gitRemote,
        `workspaces[${index}].identityHints.gitRemote`,
        { optional: true, max: 2_000 },
      );
      requireString(
        rawWorkspace.identityHints.repositoryId,
        `workspaces[${index}].identityHints.repositoryId`,
        { optional: true, max: 500 },
      );
    }
    if (!Array.isArray(rawWorkspace.scopes)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_INVALID",
        `workspaces[${index}].scopes must be an array.`,
      );
    }
    const normalizedScopes = rawWorkspace.scopes.map((rawScope, scopeIndex) => {
      if (!isRecord(rawScope)) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_INVALID",
          `workspaces[${index}].scopes[${scopeIndex}] must be an object.`,
        );
      }
      assertExactKeys(
        rawScope,
        ["path", "profiles"],
        `workspaces[${index}].scopes[${scopeIndex}]`,
      );
      const path = normalizeScopePath(
        requireString(
          rawScope.path,
          `workspaces[${index}].scopes[${scopeIndex}].path`,
        ) ?? "",
      );
      return {
        path,
        profiles: parseLegacyProfileIds(
          rawScope.profiles,
          `workspaces[${index}].scopes[${scopeIndex}].profiles`,
          profileIds,
        ).filter((id) => manuallyAssignableIds.has(id)),
      };
    });
    const scopes = normalizedScopes
      .map((scope, scopeIndex) => ({
        path: scope.path,
        profiles: scope.profiles.filter(
          (profileId) =>
            !normalizedScopes.some(
              (candidate, candidateIndex) =>
                candidateIndex !== scopeIndex &&
                candidate.path !== scope.path &&
                candidate.profiles.includes(profileId) &&
                isScopeAncestor(candidate.path, scope.path),
            ),
        ),
      }))
      .filter((scope) => scope.profiles.length > 0);
    const rawDisplayName = requireString(
      rawWorkspace.displayName,
      `workspaces[${index}].displayName`,
      {
        optional: true,
        max: MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH,
      },
    );
    const displayName =
      rawDisplayName === undefined || rawDisplayName.trim().length === 0
        ? undefined
        : normalizeWorkspaceDisplayName(
            rawDisplayName,
            `workspaces[${index}].displayName`,
          );
    return {
      id: rawWorkspace.id,
      root: rawWorkspace.root,
      ...(displayName === undefined ? {} : { displayName }),
      tags: rawWorkspace.tags === undefined ? [] : rawWorkspace.tags,
      scopes,
    };
  });

  return parseInstructionLibrary({
    schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
    revision: Number(value.revision),
    profiles: migratedProfiles,
    workspaces: migratedWorkspaces,
  });
};

const parsePersistedInstructionLibrary = (
  value: unknown,
): InstructionLibrary =>
  isRecord(value) &&
  value.schemaVersion === LEGACY_INSTRUCTION_LIBRARY_SCHEMA_VERSION
    ? migrateLegacyInstructionLibrary(value)
    : parseInstructionLibrary(value);

const readInstructionLibraryBytes = async (path: string): Promise<Buffer> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_UNSAFE_PATH",
      `Instruction library ${path} must be a regular, unlinked file.`,
    );
  }
  if (metadata.size > MAX_INSTRUCTION_LIBRARY_BYTES) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_TOO_LARGE",
      `Instruction library ${path} exceeds ${MAX_INSTRUCTION_LIBRARY_BYTES} bytes.`,
    );
  }
  let handle;
  let opened;
  let afterRead;
  let bytes: Buffer;
  try {
    handle = await open(
      path,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    opened = await handle.stat();
    if (!sameFileSnapshotIdentity(metadata, opened)) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_CHANGED_DURING_READ",
        `Instruction library ${path} changed before it could be read safely.`,
      );
    }
    if (opened.size > MAX_INSTRUCTION_LIBRARY_BYTES) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_TOO_LARGE",
        `Instruction library ${path} exceeds ${MAX_INSTRUCTION_LIBRARY_BYTES} bytes.`,
      );
    }
    bytes = await readOpenedFileExactly(handle, opened.size);
    afterRead = await handle.stat();
  } catch (error) {
    if (error instanceof InstructionSystemError) throw error;
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_UNREADABLE",
      `Instruction library ${path} could not be opened safely.`,
      [],
      { cause: error },
    );
  } finally {
    await handle?.close();
  }
  const afterPath = await lstat(path).catch((error: unknown) => {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_CHANGED_DURING_READ",
      `Instruction library ${path} changed while it was being read.`,
      [],
      { cause: error },
    );
  });
  if (
    afterPath.isSymbolicLink() ||
    !afterPath.isFile() ||
    !sameFileObjectIdentity(metadata, opened) ||
    !sameFileSnapshotIdentity(opened, afterRead) ||
    !sameFileSnapshotIdentity(afterRead, afterPath)
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_CHANGED_DURING_READ",
      `Instruction library ${path} changed while it was being read.`,
    );
  }
  return bytes;
};

const readAndParseInstructionLibrary = async (
  path: string,
): Promise<{ library: InstructionLibrary; bytes: Buffer }> => {
  const bytes = await readInstructionLibraryBytes(path);
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID_UTF8",
      `Instruction library ${path} is not valid UTF-8.`,
      [],
      { cause: error },
    );
  }
  try {
    return {
      library: parsePersistedInstructionLibrary(
        JSON.parse(raw.replace(/^\uFEFF/u, "")) as unknown,
      ),
      bytes,
    };
  } catch (error) {
    if (error instanceof InstructionSystemError) throw error;
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_INVALID_JSON",
      `Instruction library ${path} is not valid JSON.`,
      [],
      { cause: error },
    );
  }
};

const isMissingPathError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

interface InstructionPrimaryFileState {
  exists: boolean;
  digest?: string;
}

const captureInstructionPrimaryFileState = async (
  path: string,
): Promise<InstructionPrimaryFileState> => {
  try {
    return {
      exists: true,
      digest: sha256(await readInstructionLibraryBytes(path)),
    };
  } catch (error) {
    if (isMissingPathError(error)) return { exists: false };
    throw error;
  }
};

const assertInstructionPrimaryFileState = async (
  path: string,
  expected: InstructionPrimaryFileState,
): Promise<void> => {
  const current = await captureInstructionPrimaryFileState(path);
  if (
    current.exists !== expected.exists ||
    current.digest !== expected.digest
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_CONCURRENT_WRITE",
      `Instruction library ${path} changed outside the active mutation. The pending write was not committed; refresh and retry.`,
    );
  }
};

export const inspectInstructionLibraryRecovery = async (
  path = getInstructionLibraryPath(),
): Promise<InstructionLibraryRecoveryStatus> => {
  const backupPath = `${path}.bak`;
  let primaryError: unknown;
  let primaryDigest: string | undefined;
  let primaryMissing = false;
  try {
    await readAndParseInstructionLibrary(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      primaryMissing = true;
    } else {
      primaryError = error;
      try {
        primaryDigest = sha256(await readInstructionLibraryBytes(path));
      } catch {
        primaryDigest = undefined;
      }
    }
  }
  let backup:
    | Awaited<ReturnType<typeof readAndParseInstructionLibrary>>
    | undefined;
  let backupExists = false;
  let invalidBackupDigest: string | undefined;
  try {
    await lstat(backupPath);
    backupExists = true;
    backup = await readAndParseInstructionLibrary(backupPath);
  } catch {
    backup = undefined;
    if (backupExists) {
      invalidBackupDigest = await readInstructionLibraryBytes(backupPath)
        .then((bytes) => sha256(bytes))
        .catch(() => undefined);
    }
  }
  if (primaryMissing && backupExists) {
    primaryError = new InstructionSystemError(
      "INSTRUCTION_LIBRARY_MISSING_WITH_BACKUP",
      "The primary instruction library is missing, but a prior recovery backup exists.",
    );
  }
  const resetSource =
    primaryDigest !== undefined
      ? ("primary" as const)
      : primaryMissing && invalidBackupDigest !== undefined
        ? ("backup" as const)
        : undefined;
  const resetDigest =
    resetSource === "primary" ? primaryDigest : invalidBackupDigest;
  return {
    libraryPath: path,
    backupPath,
    primaryValid: primaryError === undefined,
    ...(primaryDigest === undefined ? {} : { primaryDigest }),
    backupValid: backup !== undefined,
    ...(backup === undefined
      ? {}
      : {
          backupDigest: sha256(backup.bytes),
          backupRevision: backup.library.revision,
        }),
    ...(resetDigest === undefined || resetSource === undefined
      ? {}
      : { resetDigest, resetSource }),
    ...(primaryError instanceof InstructionSystemError
      ? {
          errorCode: primaryError.code,
          errorMessage: primaryError.message,
        }
      : primaryError instanceof Error
        ? {
            errorCode: "INSTRUCTION_LIBRARY_UNREADABLE",
            errorMessage: primaryError.message,
          }
        : {}),
  };
};

export const loadInstructionLibrary = async (
  path = getInstructionLibraryPath(),
): Promise<InstructionLibrary> => {
  try {
    return (await readAndParseInstructionLibrary(path)).library;
  } catch (error) {
    if (isMissingPathError(error)) {
      const backupExists = await lstat(`${path}.bak`)
        .then(() => true)
        .catch((backupError: unknown) => {
          if (isMissingPathError(backupError)) return false;
          throw backupError;
        });
      if (!backupExists) return createEmptyInstructionLibrary();
    }
    const recovery = await inspectInstructionLibraryRecovery(path);
    const original = isMissingPathError(error)
      ? new InstructionSystemError(
          "INSTRUCTION_LIBRARY_MISSING_WITH_BACKUP",
          `Instruction library ${path} is missing while a prior backup remains.`,
          [],
          { cause: error },
        )
      : error instanceof InstructionSystemError
        ? error
        : new InstructionSystemError(
            "INSTRUCTION_LIBRARY_UNREADABLE",
            `Instruction library ${path} cannot be read.`,
            [],
            { cause: error },
          );
    throw new InstructionSystemError(
      original.code,
      `${original.message}${
        recovery.backupValid
          ? ` A validated backup is available at ${recovery.backupPath}; recovery requires its digest.`
          : ""
      }`,
      [
        ...original.diagnostics,
        {
          code: "INSTRUCTION_LIBRARY_RECOVERY_STATUS",
          severity: recovery.backupValid ? "warning" : "error",
          message: recovery.backupValid
            ? "A validated last-known-good backup is available for explicit recovery."
            : "No validated instruction-library backup is available.",
          details: {
            primaryDigest: recovery.primaryDigest,
            backupPath: recovery.backupPath,
            backupValid: recovery.backupValid,
            backupDigest: recovery.backupDigest,
            backupRevision: recovery.backupRevision,
          },
        },
      ],
      { cause: original },
    );
  }
};

export const recoverInstructionLibraryFromBackup = async (
  expectedBackupDigest: string,
  path = getInstructionLibraryPath(),
): Promise<InstructionLibrary> =>
  withCooperativeFileLock(
    path,
    async () => {
      const status = await inspectInstructionLibraryRecovery(path);
      if (status.primaryValid) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_RECOVERY_NOT_REQUIRED",
          "The primary instruction library is already valid.",
        );
      }
      if (!status.backupValid || status.backupDigest !== expectedBackupDigest) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
          "The validated backup is missing or changed after recovery review.",
        );
      }
      const backup = await readAndParseInstructionLibrary(status.backupPath);
      if (sha256(backup.bytes) !== expectedBackupDigest) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
          "The validated backup changed before it could be restored.",
        );
      }
      const expectedPrimaryState =
        await captureInstructionPrimaryFileState(path);
      if (
        expectedPrimaryState.exists
          ? status.primaryDigest === undefined ||
            expectedPrimaryState.digest !== status.primaryDigest
          : status.primaryDigest !== undefined
      ) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
          "The primary instruction library changed after recovery review.",
        );
      }
      const corruptCopy = `${path}.corrupt-${new Date()
        .toISOString()
        .replace(/[:.]/gu, "-")}`;
      if (expectedPrimaryState.exists) {
        const corruptBytes = await readInstructionLibraryBytes(path);
        if (sha256(corruptBytes) !== expectedPrimaryState.digest) {
          throw new InstructionSystemError(
            "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
            "The primary instruction library changed before its forensic copy was written.",
          );
        }
        await writeFileAtomically(corruptCopy, corruptBytes);
        await chmod(corruptCopy, 0o600).catch(() => undefined);
      }
      await writeFileAtomically(path, backup.bytes, "utf8", {
        beforeCommit: async () =>
          assertInstructionPrimaryFileState(path, expectedPrimaryState),
      });
      await chmod(path, 0o600).catch(() => undefined);
      return backup.library;
    },
    { ownerDescription: "instruction-library-recovery" },
  );

const appendAuditEntry = async (
  path: string,
  entry: Record<string, unknown>,
): Promise<void> => {
  const auditPath = join(dirname(path), "instruction-library.audit.jsonl");
  let existing = "";
  try {
    const metadata = await lstat(auditPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Instruction audit path is not a regular file.");
    }
    const start = Math.max(0, metadata.size - MAX_INSTRUCTION_AUDIT_READ_BYTES);
    const length = metadata.size - start;
    const handle = await open(auditPath, "r");
    try {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, start);
      existing = bytes.subarray(0, bytesRead).toString("utf8");
      if (start > 0) {
        const firstLineEnd = existing.indexOf("\n");
        existing = firstLineEnd < 0 ? "" : existing.slice(firstLineEnd + 1);
      }
    } finally {
      await handle.close();
    }
  } catch {
    // The body-free audit log is created on the first mutation.
  }
  const lines = existing.split("\n").filter(Boolean);
  lines.push(JSON.stringify(entry));
  const retained = lines.slice(-2_000);
  await writeFileAtomically(auditPath, `${retained.join("\n")}\n`, "utf8");
  await chmod(auditPath, 0o600).catch(() => undefined);
};

export const resetCorruptInstructionLibrary = async (
  expectedResetDigest: string,
  path = getInstructionLibraryPath(),
): Promise<{ library: InstructionLibrary; corruptCopy: string }> =>
  withCooperativeFileLock(
    path,
    async () => {
      const status = await inspectInstructionLibraryRecovery(path);
      if (status.primaryValid) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_RECOVERY_NOT_REQUIRED",
          "The primary instruction library is already valid.",
        );
      }
      if (
        status.resetDigest === undefined ||
        status.resetSource === undefined ||
        status.resetDigest !== expectedResetDigest
      ) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
          "The corrupt instruction library is missing or changed after reset review.",
        );
      }
      const sourcePath =
        status.resetSource === "primary" ? path : status.backupPath;
      const currentBytes = await readInstructionLibraryBytes(sourcePath);
      if (sha256(currentBytes) !== expectedResetDigest) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
          "The reviewed corrupt recovery file changed before reset.",
        );
      }
      const corruptCopy = `${path}.corrupt-${new Date()
        .toISOString()
        .replace(/[:.]/gu, "-")}`;
      await writeFileAtomically(corruptCopy, currentBytes);
      await chmod(corruptCopy, 0o600).catch(() => undefined);
      const library = createEmptyInstructionLibrary();
      await writeJsonAtomically(path, library, {
        beforeCommit: async () => {
          await assertInstructionPrimaryFileState(
            path,
            status.resetSource === "primary"
              ? { exists: true, digest: expectedResetDigest }
              : { exists: false },
          );
          if (status.resetSource === "backup") {
            const currentBackup = await readInstructionLibraryBytes(
              status.backupPath,
            );
            if (sha256(currentBackup) !== expectedResetDigest) {
              throw new InstructionSystemError(
                "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
                "The reviewed corrupt backup changed before reset.",
              );
            }
          }
        },
      });
      await chmod(path, 0o600).catch(() => undefined);
      await appendAuditEntry(path, {
        at: new Date().toISOString(),
        action: "reset-corrupt-library",
        previousDigest: expectedResetDigest,
        resetSource: status.resetSource,
        revision: library.revision,
        profileCount: 0,
        workspaceCount: 0,
        globalCount: 0,
      }).catch(() => undefined);
      return { library, corruptCopy };
    },
    { ownerDescription: "instruction-library-reset" },
  );

const persistInstructionLibrary = async (
  path: string,
  library: InstructionLibrary,
  previous: InstructionLibrary,
  expectedPrimaryState: InstructionPrimaryFileState,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_UNSAFE_PATH",
      `Instruction library ${path} became linked or non-regular before persistence.`,
    );
  }
  await assertInstructionPrimaryFileState(path, expectedPrimaryState);
  // `previous` was parsed successfully under the cooperative lock. Writing
  // that snapshot atomically keeps the recovery backup valid even if the
  // process stops while replacing it.
  await writeJsonAtomically(`${path}.bak`, previous);
  await chmod(`${path}.bak`, 0o600).catch(() => undefined);
  await writeJsonAtomically(path, library, {
    beforeCommit: async () =>
      assertInstructionPrimaryFileState(path, expectedPrimaryState),
  });
  await chmod(path, 0o600).catch(() => undefined);
  // The primary replace above is the commit point. An auxiliary audit failure
  // must not make callers retry a mutation which has already committed.
  await appendAuditEntry(path, {
    at: new Date().toISOString(),
    previousRevision: previous.revision,
    revision: library.revision,
    profileCount: library.profiles.length,
    workspaceCount: library.workspaces.length,
    globalCount: library.profiles.filter((profile) => profile.global).length,
    digest: canonicalDigest({
      schemaVersion: library.schemaVersion,
      revision: library.revision,
      profileMetadata: library.profiles.map(
        ({ id, name, createdAt, updatedAt, body }) => ({
          id,
          name,
          createdAt,
          updatedAt,
          bodyDigest: sha256(body),
        }),
      ),
      workspaces: library.workspaces,
    }),
  }).catch(() => undefined);
};

export const mutateInstructionLibrary = async (
  mutation: (
    library: InstructionLibrary,
  ) => InstructionLibrary | Promise<InstructionLibrary>,
  options: {
    path?: string;
    expectedRevision?: number;
    ownerDescription?: string;
    /**
     * Internal transaction hook. The caller must already hold the cooperative
     * lock for `path` for the entire mutation and any surrounding writes.
     */
    lockAlreadyHeld?: boolean;
  } = {},
): Promise<InstructionStoreMutationResult> => {
  const path = options.path ?? getInstructionLibraryPath();
  const runMutation = async (): Promise<InstructionStoreMutationResult> => {
    const previous = await loadInstructionLibrary(path);
    const expectedPrimaryState = await captureInstructionPrimaryFileState(path);
    if (expectedPrimaryState.exists) {
      const current = await readAndParseInstructionLibrary(path);
      if (
        canonicalDigest(current.library) !== canonicalDigest(previous) ||
        sha256(current.bytes) !== expectedPrimaryState.digest
      ) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_CONCURRENT_WRITE",
          `Instruction library ${path} changed while the mutation snapshot was being established.`,
        );
      }
    }
    if (
      options.expectedRevision !== undefined &&
      previous.revision !== options.expectedRevision
    ) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_REVISION_CONFLICT",
        `Instruction library revision changed from ${options.expectedRevision} to ${previous.revision}. Refresh and retry.`,
      );
    }
    if (previous.revision >= Number.MAX_SAFE_INTEGER) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_REVISION_EXHAUSTED",
        "The instruction library revision reached JavaScript's maximum safe integer and cannot be incremented safely.",
      );
    }
    const candidate = await mutation(structuredClone(previous));
    const parsed = parseInstructionLibrary({
      ...candidate,
      schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
      revision: previous.revision + 1,
    });
    await persistInstructionLibrary(
      path,
      parsed,
      previous,
      expectedPrimaryState,
    );
    return { library: parsed, previousRevision: previous.revision };
  };
  return options.lockAlreadyHeld === true
    ? runMutation()
    : withCooperativeFileLock(path, runMutation, {
        ownerDescription:
          options.ownerDescription ?? "instruction-library-mutation",
      });
};

export const createInstructionProfile = async (
  input: {
    id?: string;
    name: string;
    description?: string;
    body: string;
    enabled?: boolean;
    global?: boolean;
    tags?: string[];
    match?: InstructionTagRule;
  },
  options: { path?: string; expectedRevision?: number } = {},
): Promise<
  InstructionStoreMutationResult & { profile: InstructionProfile }
> => {
  const id = input.id ?? randomUUID();
  if (!isUuid(id)) {
    throw new InstructionSystemError(
      "INSTRUCTION_PROFILE_INVALID",
      "Instruction profile id must be a UUID.",
    );
  }
  const at = new Date().toISOString();
  const description =
    input.description === undefined
      ? undefined
      : normalizeProfileDescription(input.description, "profile.description");
  const profile: InstructionProfile = {
    id,
    name: normalizeProfileName(input.name),
    ...(description === undefined ? {} : { description }),
    body: normalizeInstructionBody(input.body, `profile "${input.name}"`),
    enabled: input.global === true ? true : input.enabled !== false,
    global: input.global === true,
    tags: normalizeInstructionTags(input.tags, "profile.tags"),
    ...(input.match === undefined
      ? {}
      : { match: normalizeInstructionTagRule(input.match) }),
    createdAt: at,
    updatedAt: at,
  };
  if (profile.global && profile.match !== undefined) {
    throw new InstructionSystemError(
      "INSTRUCTION_PROFILE_INVALID",
      "A global instruction profile cannot also use automatic tag matching.",
    );
  }
  const result = await mutateInstructionLibrary(
    (library) => ({
      ...library,
      profiles: [...library.profiles, profile],
    }),
    options,
  );
  return { ...result, profile };
};

export const updateInstructionProfile = async (
  id: ProfileId,
  patch: {
    name?: string;
    description?: string | null;
    body?: string;
    enabled?: boolean;
    global?: boolean;
    tags?: string[];
    match?: InstructionTagRule | null;
  },
  options: { path?: string; expectedRevision?: number } = {},
): Promise<InstructionStoreMutationResult> =>
  mutateInstructionLibrary((library) => {
    const index = library.profiles.findIndex((profile) => profile.id === id);
    const existing = library.profiles[index];
    if (!existing || index < 0) {
      throw new InstructionSystemError(
        "PROFILE_NOT_FOUND",
        `Instruction profile ${id} does not exist.`,
      );
    }
    const nextGlobal = patch.global ?? existing.global;
    const nextMatch =
      patch.match === null
        ? undefined
        : patch.match === undefined
          ? existing.match
          : normalizeInstructionTagRule(patch.match);
    if (nextGlobal && nextMatch !== undefined) {
      throw new InstructionSystemError(
        "INSTRUCTION_PROFILE_INVALID",
        "A global instruction profile cannot also use automatic tag matching.",
      );
    }
    const references = library.workspaces.flatMap((workspace) =>
      workspace.scopes
        .filter((scope) => scope.profiles.includes(id))
        .map((scope) => `${workspace.id}:${scope.path}`),
    );
    if ((nextGlobal || nextMatch !== undefined) && references.length > 0) {
      throw new InstructionSystemError(
        "REDUNDANT_PROFILE_ASSIGNMENT",
        `Profile ${id} is already assigned at ${references.join(", ")}. Remove those manual references before enabling ${nextGlobal ? "global application" : "tag matching"}.`,
      );
    }
    const nextDescription =
      patch.description === null
        ? undefined
        : patch.description === undefined
          ? existing.description
          : normalizeProfileDescription(
              patch.description,
              "profile.description",
            );
    const next: InstructionProfile = {
      id: existing.id,
      name:
        patch.name === undefined
          ? existing.name
          : normalizeProfileName(patch.name),
      ...(nextDescription === undefined
        ? {}
        : { description: nextDescription }),
      body:
        patch.body === undefined
          ? existing.body
          : normalizeInstructionBody(patch.body, `profile ${id}`),
      enabled: nextGlobal ? true : (patch.enabled ?? existing.enabled),
      global: nextGlobal,
      tags:
        patch.tags === undefined
          ? [...existing.tags]
          : normalizeInstructionTags(patch.tags, "profile.tags"),
      ...(nextMatch === undefined ? {} : { match: nextMatch }),
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    return {
      ...library,
      profiles: library.profiles.map((profile) =>
        profile.id === id ? next : profile,
      ),
    };
  }, options);

export const deleteInstructionProfile = async (
  id: ProfileId,
  options: { path?: string; expectedRevision?: number } = {},
): Promise<InstructionStoreMutationResult> =>
  mutateInstructionLibrary((library) => {
    const references = library.workspaces.flatMap((workspace) =>
      workspace.scopes
        .filter((scope) => scope.profiles.includes(id))
        .map((scope) => `${workspace.id}:${scope.path}`),
    );
    if (references.length > 0) {
      throw new InstructionSystemError(
        "PROFILE_IS_ASSIGNED",
        `Profile ${id} is still assigned to ${references.join(", ")}.`,
      );
    }
    if (!library.profiles.some((profile) => profile.id === id)) {
      throw new InstructionSystemError(
        "PROFILE_NOT_FOUND",
        `Instruction profile ${id} does not exist.`,
      );
    }
    return {
      ...library,
      profiles: library.profiles.filter((profile) => profile.id !== id),
    };
  }, options);

export const duplicateInstructionProfile = async (
  id: ProfileId,
  name: string | undefined,
  options: { path?: string; expectedRevision?: number } = {},
): Promise<
  InstructionStoreMutationResult & { profile: InstructionProfile }
> => {
  let created: InstructionProfile | undefined;
  const result = await mutateInstructionLibrary((library) => {
    const source = library.profiles.find((profile) => profile.id === id);
    if (!source) {
      throw new InstructionSystemError(
        "PROFILE_NOT_FOUND",
        `Instruction profile ${id} does not exist.`,
      );
    }
    const at = new Date().toISOString();
    const copyName = (() => {
      if (name !== undefined) return normalizeProfileName(name);
      const existingNameKeys = new Set(
        library.profiles.map((profile) => profileNameKey(profile.name)),
      );
      for (let copyNumber = 1; ; copyNumber += 1) {
        const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
        const availableBaseLength =
          MAX_INSTRUCTION_PROFILE_NAME_LENGTH - unicodeCodePointLength(suffix);
        const base = Array.from(source.name)
          .slice(0, availableBaseLength)
          .join("");
        const candidate = normalizeProfileName(`${base}${suffix}`);
        if (!existingNameKeys.has(profileNameKey(candidate))) return candidate;
      }
    })();
    created = {
      ...source,
      id: randomUUID(),
      name: copyName,
      global: false,
      createdAt: at,
      updatedAt: at,
    };
    Reflect.deleteProperty(created, "match");
    return { ...library, profiles: [...library.profiles, created] };
  }, options);
  if (!created) {
    throw new InstructionSystemError(
      "PROFILE_DUPLICATION_FAILED",
      `Instruction profile ${id} could not be duplicated.`,
    );
  }
  return { ...result, profile: created };
};

export const configureInstructionWorkspace = async (
  root: string,
  input: {
    displayName?: string;
    tags?: string[];
    profileIds?: ProfileId[];
  },
  options: { path?: string; expectedRevision?: number } = {},
): Promise<
  InstructionStoreMutationResult & { workspace: InstructionWorkspaceBinding }
> => {
  const canonicalRoot = await canonicalizeExistingWorkspaceRoot(root);
  const rootKey = (value: string): string =>
    process.platform === "win32"
      ? resolve(value).toLocaleLowerCase("en-US")
      : resolve(value);
  const result = await mutateInstructionLibrary((library) => {
    const existing = library.workspaces.find(
      (workspace) => rootKey(workspace.root) === rootKey(canonicalRoot),
    );
    const profileIds = input.profileIds;
    if (profileIds !== undefined) {
      const seenProfileIds = new Set<ProfileId>();
      for (const profileId of profileIds) {
        if (seenProfileIds.has(profileId)) {
          throw new InstructionSystemError(
            "INSTRUCTION_LIBRARY_DUPLICATE_REFERENCE",
            `Workspace assignment contains profile ${profileId} more than once.`,
          );
        }
        seenProfileIds.add(profileId);
        const profile = library.profiles.find(
          (candidate) => candidate.id === profileId,
        );
        if (!profile) {
          throw new InstructionSystemError(
            "INSTRUCTION_LIBRARY_INVALID_REFERENCE",
            `Workspace assignment references missing profile ${profileId}.`,
          );
        }
        assertProfileCanBeAssignedManually(profile, "Workspace assignment");
      }
    }
    const rootScope =
      profileIds === undefined
        ? existing?.scopes.find((scope) => scope.path === ".")
        : profileIds.length > 0
          ? { path: ".", profiles: [...profileIds] }
          : undefined;
    const nestedScopes =
      existing?.scopes.filter((scope) => scope.path !== ".") ?? [];
    const workspace: InstructionWorkspaceBinding = {
      id: existing?.id ?? randomUUID(),
      root: canonicalRoot,
      ...(input.displayName === undefined
        ? existing?.displayName === undefined
          ? {}
          : { displayName: existing.displayName }
        : {
            displayName: normalizeWorkspaceDisplayName(
              input.displayName,
              "workspace.displayName",
            ),
          }),
      tags:
        input.tags === undefined
          ? [...(existing?.tags ?? [])]
          : normalizeInstructionTags(input.tags, "workspace.tags"),
      scopes: [...(rootScope ? [rootScope] : []), ...nestedScopes],
    };
    return {
      ...library,
      workspaces: existing
        ? library.workspaces.map((candidate) =>
            candidate.id === existing.id ? workspace : candidate,
          )
        : [...library.workspaces, workspace],
    };
  }, options);
  const workspace = result.library.workspaces.find(
    (candidate) => rootKey(candidate.root) === rootKey(canonicalRoot),
  );
  if (!workspace) {
    throw new InstructionSystemError(
      "WORKSPACE_CONFIGURATION_FAILED",
      `Workspace ${canonicalRoot} could not be configured.`,
    );
  }
  return { ...result, workspace };
};

const assertExistingWorkspaceScope = async (
  workspaceRoot: string,
  scopePath: string,
): Promise<void> => {
  const root = await canonicalizeExistingWorkspaceRoot(workspaceRoot);
  let current = root;
  if (scopePath !== ".") {
    for (const segment of scopePath.split("/")) {
      current = join(current, segment);
      const metadata = await lstat(current).catch((error: unknown) => {
        throw new InstructionSystemError(
          "SCOPE_PATH_MISSING",
          `Instruction scope "${scopePath}" does not exist.`,
          [],
          { cause: error },
        );
      });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new InstructionSystemError(
          "SCOPE_PATH_UNSAFE",
          `Instruction scope "${scopePath}" contains a link or is not a directory.`,
        );
      }
    }
  }
  const canonical = await realpath(current);
  const rel = relative(root, canonical);
  if (
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  ) {
    throw new InstructionSystemError(
      "SCOPE_PATH_ESCAPE",
      `Instruction scope "${scopePath}" escaped its workspace root.`,
    );
  }
};

export const setWorkspaceInstructionScope = async (
  workspaceId: string,
  scopePath: string,
  profileIds: ProfileId[],
  options: { path?: string; expectedRevision?: number } = {},
): Promise<InstructionStoreMutationResult> =>
  mutateInstructionLibrary(async (library) => {
    const normalizedPath = normalizeScopePath(scopePath);
    const workspace = library.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) {
      throw new InstructionSystemError(
        "WORKSPACE_NOT_CONFIGURED",
        `Instruction workspace ${workspaceId} is not configured.`,
      );
    }
    if (profileIds.length > 0) {
      await assertExistingWorkspaceScope(workspace.root, normalizedPath);
    }
    for (const profileId of profileIds) {
      const profile = library.profiles.find(
        (candidate) => candidate.id === profileId,
      );
      if (!profile) {
        throw new InstructionSystemError(
          "INSTRUCTION_LIBRARY_INVALID_REFERENCE",
          `Workspace assignment references missing profile ${profileId}.`,
        );
      }
      assertProfileCanBeAssignedManually(profile, "Workspace assignment");
      const overlap = workspace.scopes.find(
        (scope) =>
          scope.path !== normalizedPath &&
          scope.profiles.includes(profileId) &&
          (isScopeAncestor(scope.path, normalizedPath) ||
            isScopeAncestor(normalizedPath, scope.path)),
      );
      if (overlap) {
        throw new InstructionSystemError(
          "REDUNDANT_PROFILE_ASSIGNMENT",
          `Profile ${profileId} is already assigned at overlapping scope "${overlap.path}". Remove or reorder that reference explicitly instead of creating redundant inheritance.`,
        );
      }
    }
    const existingIndex = workspace.scopes.findIndex(
      (scope) =>
        (process.platform === "win32"
          ? scope.path.toLocaleLowerCase("en-US")
          : scope.path) ===
        (process.platform === "win32"
          ? normalizedPath.toLocaleLowerCase("en-US")
          : normalizedPath),
    );
    const scopes = [...workspace.scopes];
    if (profileIds.length === 0) {
      if (existingIndex >= 0) scopes.splice(existingIndex, 1);
    } else if (existingIndex >= 0) {
      scopes[existingIndex] = {
        path: normalizedPath,
        profiles: [...profileIds],
      };
    } else {
      scopes.push({ path: normalizedPath, profiles: [...profileIds] });
    }
    return {
      ...library,
      workspaces: library.workspaces.map((candidate) =>
        candidate.id === workspaceId ? { ...candidate, scopes } : candidate,
      ),
    };
  }, options);

export const relinkInstructionWorkspaceScope = async (
  workspaceId: string,
  currentScopePath: string,
  nextScopePath: string,
  options: { path?: string; expectedRevision?: number } = {},
): Promise<InstructionStoreMutationResult> =>
  mutateInstructionLibrary(async (library) => {
    const currentPath = normalizeScopePath(currentScopePath);
    const nextPath = normalizeScopePath(nextScopePath);
    const workspace = library.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) {
      throw new InstructionSystemError(
        "WORKSPACE_NOT_CONFIGURED",
        `Instruction workspace ${workspaceId} is not configured.`,
      );
    }
    const pathKey = (value: string): string =>
      process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
    const currentIndex = workspace.scopes.findIndex(
      (scope) => pathKey(scope.path) === pathKey(currentPath),
    );
    const current = workspace.scopes[currentIndex];
    if (!current || currentIndex < 0) {
      throw new InstructionSystemError(
        "SCOPE_ASSIGNMENT_NOT_FOUND",
        `Instruction scope "${currentPath}" is not assigned in workspace ${workspaceId}.`,
      );
    }
    if (
      currentPath !== nextPath &&
      workspace.scopes.some(
        (scope, index) =>
          index !== currentIndex && pathKey(scope.path) === pathKey(nextPath),
      )
    ) {
      throw new InstructionSystemError(
        "INSTRUCTION_LIBRARY_DUPLICATE_SCOPE",
        `Instruction scope "${nextPath}" already has an assignment.`,
      );
    }
    await assertExistingWorkspaceScope(workspace.root, nextPath);
    for (const profileId of current.profiles) {
      const overlap = workspace.scopes.find(
        (scope, index) =>
          index !== currentIndex &&
          scope.profiles.includes(profileId) &&
          (isScopeAncestor(scope.path, nextPath) ||
            isScopeAncestor(nextPath, scope.path)),
      );
      if (overlap) {
        throw new InstructionSystemError(
          "REDUNDANT_PROFILE_ASSIGNMENT",
          `Relinking to "${nextPath}" would make profile ${profileId} redundant with scope "${overlap.path}".`,
        );
      }
    }
    const scopes = workspace.scopes.map((scope, index) =>
      index === currentIndex
        ? { path: nextPath, profiles: [...scope.profiles] }
        : scope,
    );
    return {
      ...library,
      workspaces: library.workspaces.map((candidate) =>
        candidate.id === workspaceId ? { ...candidate, scopes } : candidate,
      ),
    };
  }, options);

export const relinkInstructionWorkspace = async (
  workspaceId: string,
  nextRoot: string,
  options: { path?: string; expectedRevision?: number } = {},
): Promise<InstructionStoreMutationResult> => {
  const canonicalRoot = await canonicalizeExistingWorkspaceRoot(nextRoot);
  return mutateInstructionLibrary(async (library) => {
    const existing = library.workspaces.find(
      (workspace) => workspace.id === workspaceId,
    );
    if (!existing) {
      throw new InstructionSystemError(
        "WORKSPACE_NOT_CONFIGURED",
        `Instruction workspace ${workspaceId} is not configured.`,
      );
    }
    for (const scope of existing.scopes) {
      if (scope.profiles.length > 0) {
        await assertExistingWorkspaceScope(canonicalRoot, scope.path);
      }
    }
    return {
      ...library,
      workspaces: library.workspaces.map((workspace) =>
        workspace.id === workspaceId
          ? { ...workspace, root: canonicalRoot }
          : workspace,
      ),
    };
  }, options);
};

export const removeInstructionWorkspaceConfiguration = async (
  workspaceId: string,
  options: {
    path?: string;
    expectedRevision?: number;
    confirmAssignedRemoval?: boolean;
  } = {},
): Promise<InstructionStoreMutationResult> =>
  mutateInstructionLibrary((library) => {
    const workspace = library.workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace) {
      throw new InstructionSystemError(
        "WORKSPACE_NOT_CONFIGURED",
        `Instruction workspace ${workspaceId} is not configured.`,
      );
    }
    if (
      workspace.scopes.some((scope) => scope.profiles.length > 0) &&
      options.confirmAssignedRemoval !== true
    ) {
      throw new InstructionSystemError(
        "WORKSPACE_ASSIGNMENT_REMOVAL_CONFIRMATION_REQUIRED",
        `Workspace ${workspaceId} has instruction assignments. Export or preview them, then explicitly confirm assignment removal.`,
      );
    }
    return {
      ...library,
      workspaces: library.workspaces.filter(
        (workspace) => workspace.id !== workspaceId,
      ),
    };
  }, options);

export const exportInstructionLibrary = (
  library: InstructionLibrary,
  includeWorkspaceBindings = false,
): InstructionLibraryExport => ({
  schemaVersion: INSTRUCTION_LIBRARY_SCHEMA_VERSION,
  exportedAt: new Date().toISOString(),
  profiles: structuredClone(library.profiles),
  ...(includeWorkspaceBindings
    ? {
        workspaces: library.workspaces.map((workspace) => ({
          id: workspace.id,
          ...(workspace.displayName === undefined
            ? {}
            : { displayName: workspace.displayName }),
          tags: [...workspace.tags],
          scopes: structuredClone(workspace.scopes),
        })),
      }
    : {}),
});

export const exportInstructionLibraryRecoveryBackup = async (
  expectedBackupDigest: string,
  path = getInstructionLibraryPath(),
): Promise<InstructionLibraryExport> => {
  const status = await inspectInstructionLibraryRecovery(path);
  if (!status.backupValid || status.backupDigest !== expectedBackupDigest) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
      "The validated backup is missing or changed after export review.",
    );
  }
  const backup = await readAndParseInstructionLibrary(status.backupPath);
  if (sha256(backup.bytes) !== expectedBackupDigest) {
    throw new InstructionSystemError(
      "INSTRUCTION_LIBRARY_RECOVERY_CONFLICT",
      "The validated backup changed before export.",
    );
  }
  return exportInstructionLibrary(backup.library);
};

export const importInstructionLibrary = async (
  input: InstructionLibraryExport,
  options: {
    path?: string;
    expectedRevision?: number;
    includeWorkspaceBindings?: boolean;
    choices?: InstructionLibraryImportChoices;
  } = {},
): Promise<
  InstructionStoreMutationResult & {
    unboundWorkspaces: NonNullable<InstructionLibraryExport["workspaces"]>;
  }
> => {
  if (!isRecord(input)) {
    throw new InstructionSystemError(
      "INSTRUCTION_IMPORT_INVALID",
      "The imported instruction library must be an object.",
    );
  }
  assertExactKeys(
    input,
    ["schemaVersion", "exportedAt", "profiles", "workspaces"],
    "instruction library import",
    "INSTRUCTION_IMPORT_INVALID",
  );
  if (
    typeof input.exportedAt !== "string" ||
    !isRfc3339DateTime(input.exportedAt)
  ) {
    throw new InstructionSystemError(
      "INSTRUCTION_IMPORT_INVALID",
      "The imported instruction library has an invalid export timestamp.",
    );
  }
  const parsedInput = parseInstructionLibrary({
    schemaVersion: input.schemaVersion,
    revision: 0,
    profiles: input.profiles,
    workspaces: [],
  });
  const importedIds = new Set(
    parsedInput.profiles.map((profile) => profile.id),
  );
  if (input.workspaces !== undefined && !Array.isArray(input.workspaces)) {
    throw new InstructionSystemError(
      "INSTRUCTION_IMPORT_INVALID",
      "Imported workspace mappings must be an array.",
    );
  }
  const choices = options.choices;
  if (choices !== undefined) {
    if (!isRecord(choices)) {
      throw new InstructionSystemError(
        "INSTRUCTION_IMPORT_INVALID_CHOICE",
        "Instruction import choices must be an object.",
      );
    }
    assertExactKeys(
      choices,
      ["conflicts", "renamedProfiles"],
      "instruction import choices",
      "INSTRUCTION_IMPORT_INVALID_CHOICE",
    );
    for (const [field, value] of [
      ["conflicts", choices.conflicts],
      ["renamedProfiles", choices.renamedProfiles],
    ] as const) {
      if (value === undefined) continue;
      if (!isRecord(value)) {
        throw new InstructionSystemError(
          "INSTRUCTION_IMPORT_INVALID_CHOICE",
          `${field} import choices must be an object.`,
        );
      }
      for (const [profileId, decision] of Object.entries(value)) {
        if (!importedIds.has(profileId)) {
          throw new InstructionSystemError(
            "INSTRUCTION_IMPORT_UNKNOWN_CHOICE",
            `Instruction import choices reference unknown profile ${profileId}.`,
          );
        }
        if (
          field === "conflicts" &&
          !["keep-existing", "replace-existing", "duplicate-imported"].includes(
            String(decision),
          )
        ) {
          throw new InstructionSystemError(
            "INSTRUCTION_IMPORT_INVALID_CHOICE",
            `Unknown conflict choice ${JSON.stringify(decision)} for profile ${profileId}.`,
          );
        }
        if (field === "renamedProfiles" && typeof decision !== "string") {
          throw new InstructionSystemError(
            "INSTRUCTION_IMPORT_INVALID_CHOICE",
            `The renamed profile value for ${profileId} must be a string.`,
          );
        }
      }
    }
  }
  const unboundWorkspaces = (input.workspaces ?? []).map((workspace, index) => {
    if (!isRecord(workspace)) {
      throw new InstructionSystemError(
        "INSTRUCTION_IMPORT_INVALID",
        `Imported workspace mapping ${index} must be an object.`,
      );
    }
    assertExactKeys(
      workspace,
      ["id", "displayName", "tags", "scopes"],
      `imported workspace mapping ${index}`,
      "INSTRUCTION_IMPORT_INVALID",
    );
    const parsed = parseWorkspace(
      {
        ...workspace,
        root: resolve(
          dirname(options.path ?? getInstructionLibraryPath()),
          ".unbound-instruction-import",
          String(workspace.id),
        ),
      },
      index,
      importedIds,
    );
    return {
      id: parsed.id,
      ...(parsed.displayName === undefined
        ? {}
        : { displayName: parsed.displayName }),
      tags: [...parsed.tags],
      scopes: parsed.scopes,
    };
  });
  const unboundIds = new Set<string>();
  for (const workspace of unboundWorkspaces) {
    if (unboundIds.has(workspace.id)) {
      throw new InstructionSystemError(
        "INSTRUCTION_IMPORT_INVALID",
        `Imported workspace mapping ${workspace.id} is duplicated.`,
      );
    }
    unboundIds.add(workspace.id);
  }
  const importedProfileById = new Map(
    parsedInput.profiles.map((profile) => [profile.id, profile]),
  );
  for (const workspace of unboundWorkspaces) {
    assertManualWorkspaceAssignments(
      `Imported workspace mapping ${workspace.id}`,
      workspace.scopes,
      importedProfileById,
    );
  }

  type UnboundWorkspace = NonNullable<
    InstructionLibraryExport["workspaces"]
  >[number];
  let resolvedUnboundWorkspaces: UnboundWorkspace[] = [];
  const result = await mutateInstructionLibrary((library) => {
    if (parsedInput.schemaVersion !== INSTRUCTION_LIBRARY_SCHEMA_VERSION) {
      throw new InstructionSystemError(
        "INSTRUCTION_IMPORT_INVALID",
        `The imported instruction library does not match schema version ${INSTRUCTION_LIBRARY_SCHEMA_VERSION}.`,
      );
    }
    const profiles = structuredClone(library.profiles);
    const existingById = new Map(
      profiles.map((profile) => [profile.id, profile]),
    );
    const idMap = new Map<string, string>();
    const consumedConflictChoices = new Set<string>();
    for (const importedProfile of parsedInput.profiles) {
      let profile = structuredClone(importedProfile);
      const renamed = options.choices?.renamedProfiles?.[profile.id];
      if (renamed !== undefined) {
        profile = { ...profile, name: normalizeProfileName(renamed) };
      }
      const existing = existingById.get(profile.id);
      if (existing) {
        if (canonicalDigest(existing) === canonicalDigest(profile)) {
          idMap.set(profile.id, existing.id);
          continue;
        }
        const choice = options.choices?.conflicts?.[profile.id];
        if (!choice) {
          throw new InstructionSystemError(
            "INSTRUCTION_IMPORT_ID_CONFLICT",
            `Profile id ${profile.id} has different file data (existing ${canonicalDigest(existing)}, imported ${canonicalDigest(profile)}). Provide an explicit keep-existing, replace-existing, or duplicate-imported choice.`,
          );
        }
        consumedConflictChoices.add(profile.id);
        if (choice === "keep-existing") {
          idMap.set(profile.id, existing.id);
          continue;
        }
        if (choice === "replace-existing") {
          const index = profiles.findIndex(
            (candidate) => candidate.id === existing.id,
          );
          profiles[index] = profile;
          existingById.set(profile.id, profile);
          idMap.set(importedProfile.id, profile.id);
          continue;
        }
        if (renamed === undefined) {
          throw new InstructionSystemError(
            "INSTRUCTION_IMPORT_RENAME_REQUIRED",
            `Duplicating conflicting profile ${profile.id} requires an explicit renamedProfiles entry.`,
          );
        }
        profile = { ...profile, id: randomUUID() };
      }
      const nameCollision = profiles.find(
        (candidate) =>
          profileNameKey(candidate.name) === profileNameKey(profile.name),
      );
      if (nameCollision) {
        const choice = options.choices?.conflicts?.[importedProfile.id];
        if (choice === "keep-existing") {
          consumedConflictChoices.add(importedProfile.id);
          idMap.set(importedProfile.id, nameCollision.id);
          continue;
        }
        throw new InstructionSystemError(
          "INSTRUCTION_IMPORT_NAME_CONFLICT",
          `Profile name "${profile.name}" already exists with a different id. Rename the imported profile or explicitly keep the existing profile.`,
        );
      }
      profiles.push(profile);
      existingById.set(profile.id, profile);
      idMap.set(importedProfile.id, profile.id);
    }
    const unusedConflictChoices = Object.keys(
      options.choices?.conflicts ?? {},
    ).filter((profileId) => !consumedConflictChoices.has(profileId));
    if (unusedConflictChoices.length > 0) {
      throw new InstructionSystemError(
        "INSTRUCTION_IMPORT_UNUSED_CHOICE",
        `Conflict choices do not correspond to an observed conflict for profile(s): ${unusedConflictChoices.join(", ")}.`,
      );
    }
    resolvedUnboundWorkspaces =
      options.includeWorkspaceBindings === true
        ? unboundWorkspaces.map((workspace) => ({
            ...workspace,
            scopes: workspace.scopes.map((scope) => ({
              ...scope,
              profiles: scope.profiles.map((profileId) => {
                const mapped = idMap.get(profileId);
                if (!mapped) {
                  throw new InstructionSystemError(
                    "INSTRUCTION_IMPORT_INVALID_REFERENCE",
                    `Imported workspace mapping references unresolved profile ${profileId}.`,
                  );
                }
                return mapped;
              }),
            })),
          }))
        : [];
    const resolvedProfileById = new Map(
      profiles.map((profile) => [profile.id, profile]),
    );
    for (const workspace of resolvedUnboundWorkspaces) {
      assertManualWorkspaceAssignments(
        `Imported workspace mapping ${workspace.id}`,
        workspace.scopes,
        resolvedProfileById,
      );
    }
    return {
      ...library,
      profiles,
    };
  }, options);
  return {
    ...result,
    unboundWorkspaces: resolvedUnboundWorkspaces,
  };
};
