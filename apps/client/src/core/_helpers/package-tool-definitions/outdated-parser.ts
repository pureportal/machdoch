import { firstStringField, isRecord, parseJsonOrJsonLines, type NodeOutdatedEntry, type NodePackageManager } from "./model.js";

export const parseNodeOutdated = (stdout: string): NodeOutdatedEntry[] => {
  const parsed = parseJsonOrJsonLines(stdout)[0];

  if (Array.isArray(parsed)) {
    return parsed.flatMap((value) =>
      isRecord(value) ? [createOutdatedEntry(value)] : [],
    );
  }

  if (!isRecord(parsed)) {
    return [];
  }

  return Object.entries(parsed).flatMap(([name, value]) => {
    if (!isRecord(value)) {
      return [];
    }

    return [createOutdatedEntry(value, name)];
  });
};

const createOutdatedEntry = (
  record: Record<string, unknown>,
  fallbackName?: string,
): NodeOutdatedEntry => {
  const name =
    firstStringField(record, ["name", "packageName", "package"]) ??
    fallbackName ??
    "(unknown)";
  const current = firstStringField(record, ["current", "installed"]);
  const wanted = firstStringField(record, [
    "wanted",
    "update",
    "latestMatching",
  ]);
  const latest = firstStringField(record, ["latest"]);
  const dependent = firstStringField(record, [
    "dependent",
    "dependedBy",
    "workspace",
  ]);
  const location = firstStringField(record, ["location", "path"]);
  const type = firstStringField(record, ["type", "dependencyType"]);

  return {
    name,
    ...(current ? { current } : {}),
    ...(wanted ? { wanted } : {}),
    ...(latest ? { latest } : {}),
    ...(dependent ? { dependent } : {}),
    ...(location ? { location } : {}),
    ...(type ? { type } : {}),
  };
};

export const formatOutdatedEntry = (entry: NodeOutdatedEntry): string => {
  return [
    entry.name,
    `current=${entry.current ?? "unknown"}`,
    `wanted=${entry.wanted ?? "unknown"}`,
    `latest=${entry.latest ?? "unknown"}`,
    entry.type ? `type=${entry.type}` : undefined,
    entry.dependent ? `dependent=${entry.dependent}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

export const outdatedCommandArgs = (
  manager: NodePackageManager,
  includeAll: boolean,
): string[] | undefined => {
  switch (manager) {
    case "npm": {
      return ["outdated", "--json", ...(includeAll ? ["--all"] : [])];
    }
    case "pnpm": {
      return ["outdated", "--format", "json"];
    }
    case "yarn":
    case "bun": {
      return undefined;
    }
  }
};

