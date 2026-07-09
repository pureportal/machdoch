import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_SEVERITIES,
  AUDIT_SEVERITY_RANK,
  firstStringField,
  isRecord,
  parseJsonOrJsonLines,
  type AuditSeverity,
  type ConfigurableAuditLevel,
  type NodePackageProject,
  type PackageAuditEntry,
  type PackageAuditSummary,
} from "./model.js";

const isYarnClassicProject = (project: NodePackageProject): boolean => {
  if (project.manager !== "yarn") {
    return false;
  }

  if (project.managerVersion) {
    return project.managerVersion.startsWith("1.");
  }

  return (
    existsSync(join(project.packageRoot, ".yarnrc")) &&
    !existsSync(join(project.packageRoot, ".yarnrc.yml"))
  );
};

export const auditCommandArgs = (
  project: NodePackageProject,
  options: { auditLevel: ConfigurableAuditLevel; productionOnly: boolean },
): string[] => {
  switch (project.manager) {
    case "npm": {
      return [
        "audit",
        "--json",
        `--audit-level=${options.auditLevel}`,
        ...(options.productionOnly ? ["--production"] : []),
      ];
    }
    case "pnpm": {
      return [
        "audit",
        "--json",
        `--audit-level=${options.auditLevel}`,
        ...(options.productionOnly ? ["--prod"] : []),
      ];
    }
    case "bun": {
      return [
        "audit",
        "--json",
        `--audit-level=${options.auditLevel}`,
        ...(options.productionOnly ? ["--prod"] : []),
      ];
    }
    case "yarn": {
      return isYarnClassicProject(project)
        ? [
            "audit",
            "--json",
            "--level",
            options.auditLevel,
            ...(options.productionOnly ? ["--groups", "dependencies"] : []),
          ]
        : [
            "npm",
            "audit",
            "--json",
            "--severity",
            options.auditLevel,
            ...(options.productionOnly ? ["--environment", "production"] : []),
          ];
    }
  }
};

export const auditAcceptedExitCodes = (project: NodePackageProject): number[] => {
  return project.manager === "yarn"
    ? Array.from({ length: 32 }, (_value, index) => index)
    : [0, 1];
};

const normalizeAuditSeverity = (value: unknown): AuditSeverity | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase();

  return AUDIT_SEVERITIES.includes(normalized as AuditSeverity)
    ? (normalized as AuditSeverity)
    : undefined;
};

const createEmptyAuditCounts = (): Record<AuditSeverity, number> => {
  return {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  };
};

const formatFixAvailable = (value: unknown): string | undefined => {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (isRecord(value)) {
    const name = firstStringField(value, ["name"]);
    const version = firstStringField(value, ["version"]);
    const isSemverMajor = value.isSemVerMajor === true;

    return [
      name,
      version ? `version=${version}` : undefined,
      isSemverMajor ? "semver-major" : undefined,
    ]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
  }

  return undefined;
};

const formatVia = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const via = value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return [entry.trim()];
    }

    if (isRecord(entry)) {
      return firstStringField(entry, ["title", "name", "source"]) ?? [];
    }

    return [];
  });

  return via.length > 0 ? via.slice(0, 3).join(", ") : undefined;
};

const createAuditEntry = (
  record: Record<string, unknown>,
  fallbackName?: string,
): PackageAuditEntry | undefined => {
  const name =
    firstStringField(record, [
      "name",
      "module_name",
      "moduleName",
      "package",
      "packageName",
      "dependency",
    ]) ?? fallbackName;

  if (!name) {
    return undefined;
  }
  const severity = normalizeAuditSeverity(record.severity);
  const title = firstStringField(record, ["title", "overview"]);
  const range = firstStringField(record, ["range", "vulnerable_versions"]);
  const via = formatVia(record.via);
  const fixAvailable = formatFixAvailable(record.fixAvailable);
  const url = firstStringField(record, ["url", "github_advisory_url"]);

  return {
    name,
    ...(severity ? { severity } : {}),
    ...(title ? { title } : {}),
    ...(range ? { range } : {}),
    ...(via ? { via } : {}),
    ...(fixAvailable ? { fixAvailable } : {}),
    ...(url ? { url } : {}),
  };
};

const collectAuditEntries = (value: unknown): PackageAuditEntry[] => {
  if (!isRecord(value)) {
    return [];
  }

  const entries: PackageAuditEntry[] = [];
  const data = isRecord(value.data) ? value.data : undefined;
  const yarnAdvisory = data && isRecord(data.advisory)
    ? data.advisory
    : undefined;

  if (value.type === "auditAdvisory" && yarnAdvisory) {
    const entry = createAuditEntry(yarnAdvisory);

    if (entry) {
      entries.push(entry);
    }
  }

  const vulnerabilities = value.vulnerabilities;

  if (isRecord(vulnerabilities)) {
    for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
      if (isRecord(vulnerability)) {
        const entry = createAuditEntry(vulnerability, name);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  } else if (Array.isArray(vulnerabilities)) {
    for (const vulnerability of vulnerabilities) {
      if (isRecord(vulnerability)) {
        const entry = createAuditEntry(vulnerability);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  }

  const advisories = value.advisories;

  if (isRecord(advisories)) {
    for (const [name, advisory] of Object.entries(advisories)) {
      if (isRecord(advisory)) {
        const entry = createAuditEntry(advisory, name);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  } else if (Array.isArray(advisories)) {
    for (const advisory of advisories) {
      if (isRecord(advisory)) {
        const entry = createAuditEntry(advisory);

        if (entry) {
          entries.push(entry);
        }
      }
    }
  }

  if (data) {
    entries.push(...collectAuditEntries(data));
  }

  return entries;
};

const mergeAuditCountRecord = (
  value: unknown,
  counts: Record<AuditSeverity, number>,
): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  let sawSeverityCount = false;
  let recordTotal = 0;

  for (const severity of AUDIT_SEVERITIES) {
    const count = value[severity];

    if (typeof count === "number" && Number.isFinite(count)) {
      counts[severity] += count;
      recordTotal += count;
      sawSeverityCount = true;
    }
  }

  if (typeof value.total === "number" && Number.isFinite(value.total)) {
    return value.total;
  }

  return sawSeverityCount
    ? recordTotal
    : undefined;
};

const mergeAuditCounts = (
  value: unknown,
  counts: Record<AuditSeverity, number>,
): number | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadataCounts =
    isRecord(value.metadata) && isRecord(value.metadata.vulnerabilities)
      ? mergeAuditCountRecord(value.metadata.vulnerabilities, counts)
      : undefined;

  if (metadataCounts !== undefined) {
    return metadataCounts;
  }

  const data = isRecord(value.data) ? value.data : undefined;
  const dataCounts =
    data && isRecord(data.vulnerabilities)
      ? mergeAuditCountRecord(data.vulnerabilities, counts)
      : undefined;

  if (dataCounts !== undefined) {
    return dataCounts;
  }

  return data &&
    isRecord(data.auditSummary) &&
    isRecord(data.auditSummary.vulnerabilities)
    ? mergeAuditCountRecord(data.auditSummary.vulnerabilities, counts)
    : undefined;
};

const uniqueAuditEntries = (
  entries: PackageAuditEntry[],
): PackageAuditEntry[] => {
  const seen = new Set<string>();

  return entries.filter((entry) => {
    const key = [
      entry.name,
      entry.severity ?? "",
      entry.title ?? "",
      entry.range ?? "",
      entry.url ?? "",
    ].join("\0");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

export const parsePackageAudit = (stdout: string): PackageAuditSummary => {
  const counts = createEmptyAuditCounts();
  const parsedValues = parseJsonOrJsonLines(stdout);
  const metadataTotals: number[] = [];
  const entries = uniqueAuditEntries(
    parsedValues.flatMap((value) => collectAuditEntries(value)),
  ).sort((left, right) => {
    const severityDelta =
      AUDIT_SEVERITY_RANK[right.severity ?? "info"] -
      AUDIT_SEVERITY_RANK[left.severity ?? "info"];

    return severityDelta === 0
      ? left.name.localeCompare(right.name)
      : severityDelta;
  });

  for (const value of parsedValues) {
    const metadataTotal = mergeAuditCounts(value, counts);

    if (metadataTotal !== undefined) {
      metadataTotals.push(metadataTotal);
    }
  }

  if (metadataTotals.length === 0) {
    for (const entry of entries) {
      if (entry.severity) {
        counts[entry.severity] += 1;
      }
    }
  }

  const countedTotal = AUDIT_SEVERITIES.reduce(
    (total, severity) => total + counts[severity],
    0,
  );
  const total =
    metadataTotals.length > 0
      ? metadataTotals.reduce((sum, count) => sum + count, 0)
      : countedTotal > 0
        ? countedTotal
        : entries.length;

  return {
    counts,
    total,
    entries,
  };
};

export const formatAuditCounts = (
  counts: Record<AuditSeverity, number>,
): string => {
  return AUDIT_SEVERITIES.map((severity) => `${severity}=${counts[severity]}`)
    .join(", ");
};

export const formatAuditEntry = (entry: PackageAuditEntry): string => {
  return [
    entry.severity ? `${entry.name} (${entry.severity})` : entry.name,
    entry.title,
    entry.range ? `range=${entry.range}` : undefined,
    entry.via ? `via=${entry.via}` : undefined,
    entry.fixAvailable ? `fix=${entry.fixAvailable}` : undefined,
    entry.url,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

