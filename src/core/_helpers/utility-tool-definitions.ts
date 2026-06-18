import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  coerceBoolean,
  coerceInteger,
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import { compactTraceText } from "./runtime-text.js";
import { sortUniqueLines } from "./sort-unique-lines.helper.js";

const MAX_UUID_COUNT = 100;
const DEFAULT_RANDOM_STRING_LENGTH = 32;
const MAX_RANDOM_STRING_LENGTH = 1_024;
const MAX_RANDOM_STRING_COUNT = 100;
const MAX_CUSTOM_ALPHABET_LENGTH = 256;
const MAX_RANDOM_NUMBER_COUNT = 1_000;
const MAX_RANDOM_INTEGER_RANGE = 2 ** 48;
const MAX_ULID_COUNT = 100;
const MAX_TEXT_INPUT_CHARS = 1_000_000;
const MAX_JSON_INDENT = 8;
const MAX_URL_QUERY_PARAMS = 100;
const MAX_VERSION_INPUT_CHARS = 200;
const MAX_REGEX_PATTERN_CHARS = 1_000;
const MAX_REGEX_TEXT_CHARS = 100_000;
const DEFAULT_REGEX_MATCHES = 20;
const MAX_REGEX_MATCHES = 100;
const MAX_DIFF_TEXT_CHARS = 100_000;
const MAX_DIFF_INPUT_LINES = 400;
const DEFAULT_DIFF_CONTEXT_LINES = 2;
const MAX_DIFF_CONTEXT_LINES = 8;
const DEFAULT_DIFF_OUTPUT_LINES = 200;
const MAX_DIFF_OUTPUT_LINES = 400;
const ULID_TIMESTAMP_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;
const ULID_RANDOM_BITS = 80n;
const ULID_RANDOM_SPACE = 1n << ULID_RANDOM_BITS;
const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const RANDOM_STRING_CHARSETS = {
  alphanumeric:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  lower_alphanumeric: "abcdefghijklmnopqrstuvwxyz0123456789",
  upper_alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  alphabetic: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  numeric: "0123456789",
  hex: "0123456789abcdef",
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
} as const;

type RandomStringCharsetName = keyof typeof RANDOM_STRING_CHARSETS | "custom";

const RANDOM_STRING_CHARSET_NAMES = [
  ...Object.keys(RANDOM_STRING_CHARSETS),
  "custom",
];

const HASH_ALGORITHMS = ["sha256", "sha512", "sha384", "sha1", "md5"] as const;
const HASH_OUTPUT_ENCODINGS = ["hex", "base64", "base64url"] as const;
const TEXT_ENCODING_FORMATS = ["base64", "base64url", "url", "hex"] as const;
const JSON_OUTPUT_STYLES = ["none", "pretty", "minified"] as const;
const IDENTIFIER_STYLES = [
  "slug",
  "kebab",
  "snake",
  "camel",
  "pascal",
  "constant",
] as const;

type VersionIdentifier =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string };

type DiffOperation = {
  kind: "same" | "add" | "remove";
  text: string;
};

const normalizeRandomStringCharset = (
  value: string | undefined,
): RandomStringCharsetName => {
  const normalized = value?.trim().toLowerCase().replace(/-/gu, "_");

  if (
    normalized &&
    RANDOM_STRING_CHARSET_NAMES.includes(normalized as RandomStringCharsetName)
  ) {
    return normalized as RandomStringCharsetName;
  }

  return "alphanumeric";
};

const coerceRawString = (
  record: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = record[field];

  return typeof value === "string" ? value : undefined;
};

const coerceFiniteNumber = (
  record: Record<string, unknown>,
  field: string,
): number | undefined => {
  const value = record[field];

  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const normalizeEnumValue = <T extends string>(
  value: string | undefined,
  allowedValues: readonly T[],
  fallback: T,
): T => {
  const normalized = value?.trim().toLowerCase().replace(/-/gu, "_");

  if (normalized && allowedValues.includes(normalized as T)) {
    return normalized as T;
  }

  return fallback;
};

const validateCount = (count: number, maxCount: number, toolName: string) => {
  if (count < 1 || count > maxCount) {
    return createToolErrorResult(
      randomUUID(),
      toolName,
      `Expected \`count\` to be between 1 and ${maxCount}.`,
    );
  }

  return undefined;
};

const validateTextLength = (
  text: string,
  field: string,
  toolName: string,
) => {
  if (text.length > MAX_TEXT_INPUT_CHARS) {
    return createToolErrorResult(
      randomUUID(),
      toolName,
      `Expected \`${field}\` to be no longer than ${MAX_TEXT_INPUT_CHARS} characters.`,
    );
  }

  return undefined;
};

const getRandomCharacter = (alphabet: string): string => {
  return alphabet[randomInt(alphabet.length)] ?? "";
};

const createRandomString = (length: number, alphabet: string): string => {
  return Array.from({ length }, () => getRandomCharacter(alphabet)).join("");
};

const resolveRandomStringAlphabet = (
  charset: RandomStringCharsetName,
  customAlphabet: string | undefined,
): string | undefined => {
  if (charset !== "custom") {
    return RANDOM_STRING_CHARSETS[charset];
  }

  if (!customAlphabet) {
    return undefined;
  }

  return Array.from(new Set([...customAlphabet])).join("");
};

const getRandomUnit = (): number => {
  return randomInt(0, MAX_RANDOM_INTEGER_RANGE) / MAX_RANDOM_INTEGER_RANGE;
};

const createRandomNumberValues = (
  min: number,
  max: number,
  count: number,
  integer: boolean,
  unique: boolean,
): number[] | string => {
  if (integer) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      return "Expected integer random number bounds to be safe integers.";
    }

    if (max < min) {
      return "Expected `max` to be greater than or equal to `min` for integer generation.";
    }

    const range = max - min + 1;

    if (range > MAX_RANDOM_INTEGER_RANGE) {
      return `Expected the integer range size to be no larger than ${MAX_RANDOM_INTEGER_RANGE}.`;
    }

    if (unique && count > range) {
      return "Cannot generate the requested number of unique integers from the configured range.";
    }

    if (unique) {
      const values = new Set<number>();

      while (values.size < count) {
        values.add(min + randomInt(range));
      }

      return [...values];
    }

    return Array.from({ length: count }, () => min + randomInt(range));
  }

  if (unique) {
    return "`unique` is only supported when `integer` is true.";
  }

  if (max <= min) {
    return "Expected `max` to be greater than `min` for decimal generation.";
  }

  return Array.from({ length: count }, () => min + getRandomUnit() * (max - min));
};

const formatNumberValue = (value: number): string => {
  return Number.isInteger(value) ? value.toString() : value.toPrecision(17);
};

const encodeCrockfordBase32 = (value: bigint, length: number): string => {
  let remaining = value;
  let output = "";

  for (let index = 0; index < length; index += 1) {
    const alphabetIndex = Number(remaining % 32n);
    output = `${CROCKFORD_BASE32_ALPHABET[alphabetIndex] ?? "0"}${output}`;
    remaining /= 32n;
  }

  return output;
};

const createUlid = (timestampMs: number, randomValue: bigint): string => {
  return [
    encodeCrockfordBase32(BigInt(timestampMs), ULID_TIMESTAMP_LENGTH),
    encodeCrockfordBase32(randomValue, ULID_RANDOM_LENGTH),
  ].join("");
};

const createRandomUlidBase = (count: number): bigint => {
  const randomValue = BigInt(`0x${randomBytes(10).toString("hex")}`);
  const boundedSpace = ULID_RANDOM_SPACE - BigInt(count);

  return randomValue % boundedSpace;
};

const getLocalTimeZone = (): string => {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
};

const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const getTimeZoneDateParts = (date: Date, timeZone: string) => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .map((part) => [part.type, part.value] as const),
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
};

const padDatePart = (value: number, length = 2): string => {
  return value.toString().padStart(length, "0");
};

const formatUtcOffset = (offsetMinutes: number): string => {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;

  return `${sign}${padDatePart(hours)}:${padDatePart(minutes)}`;
};

const getTimeZoneOffsetMinutes = (date: Date, timeZone: string): number => {
  const parts = getTimeZoneDateParts(date, timeZone);
  const utcFromParts = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return Math.round((utcFromParts - date.getTime()) / 60_000);
};

const formatZonedIso = (
  date: Date,
  timeZone: string,
  utcOffset: string,
): string => {
  const parts = getTimeZoneDateParts(date, timeZone);

  return [
    `${padDatePart(parts.year, 4)}-${padDatePart(parts.month)}-${padDatePart(parts.day)}`,
    "T",
    `${padDatePart(parts.hour)}:${padDatePart(parts.minute)}:${padDatePart(parts.second)}`,
    utcOffset,
  ].join("");
};

const encodeTextValue = (text: string, format: string): string => {
  switch (format) {
    case "base64":
      return Buffer.from(text, "utf8").toString("base64");
    case "base64url":
      return Buffer.from(text, "utf8").toString("base64url");
    case "hex":
      return Buffer.from(text, "utf8").toString("hex");
    case "url":
      return encodeURIComponent(text);
    default:
      return text;
  }
};

const isValidBase64 = (value: string): boolean => {
  return /^[A-Za-z0-9+/]*={0,2}$/u.test(value) && value.length % 4 !== 1;
};

const isValidBase64Url = (value: string): boolean => {
  return /^[A-Za-z0-9_-]*$/u.test(value) && value.length % 4 !== 1;
};

const decodeTextValue = (
  value: string,
  format: string,
): { decoded?: string; error?: string } => {
  switch (format) {
    case "base64":
      if (!isValidBase64(value)) {
        return { error: "Expected valid base64 input." };
      }

      return { decoded: Buffer.from(value, "base64").toString("utf8") };
    case "base64url":
      if (!isValidBase64Url(value)) {
        return { error: "Expected valid base64url input." };
      }

      return { decoded: Buffer.from(value, "base64url").toString("utf8") };
    case "hex":
      if (!/^(?:[0-9a-f]{2})*$/iu.test(value)) {
        return { error: "Expected an even-length hexadecimal string." };
      }

      return { decoded: Buffer.from(value, "hex").toString("utf8") };
    case "url":
      try {
        return { decoded: decodeURIComponent(value) };
      } catch {
        return { error: "Expected valid percent-encoded URL text." };
      }
    default:
      return { decoded: value };
  }
};

const computeJsonLineColumn = (
  text: string,
  position: number,
): { line: number; column: number } => {
  const lines = text.slice(0, position).split(/\r\n|\r|\n/u);
  const lastLine = lines.at(-1) ?? "";

  return {
    line: lines.length,
    column: lastLine.length + 1,
  };
};

const getJsonValueType = (value: unknown): string => {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
};

const extractJsonErrorPosition = (message: string): number | undefined => {
  const match = /\bposition\s+(\d+)/iu.exec(message);

  return match ? Number(match[1]) : undefined;
};

const normalizeIdentifierWords = (text: string): string[] => {
  return (
    text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  );
};

const capitalizeWord = (word: string): string => {
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
};

const formatIdentifier = (words: string[], style: string): string => {
  switch (style) {
    case "camel":
      return [
        words[0] ?? "",
        ...words.slice(1).map((word) => capitalizeWord(word)),
      ].join("");
    case "pascal":
      return words.map((word) => capitalizeWord(word)).join("");
    case "snake":
      return words.join("_");
    case "constant":
      return words.join("_").toUpperCase();
    case "slug":
    case "kebab":
    default:
      return words.join("-");
  }
};

const createUrl = (
  value: string,
  baseUrl: string | undefined,
): URL | undefined => {
  try {
    return baseUrl ? new URL(value, baseUrl) : new URL(value);
  } catch {
    return undefined;
  }
};

const createParsedUrlLines = (url: URL): string[] => {
  const queryParamLines = [...url.searchParams.entries()].map(
    ([name, value]) => `query: ${name}=${value}`,
  );

  return [
    `href: ${url.href}`,
    `origin: ${url.origin}`,
    `protocol: ${url.protocol.replace(/:$/u, "")}`,
    `username: ${url.username}`,
    `password: ${url.password ? "(present)" : ""}`,
    `host: ${url.host}`,
    `hostname: ${url.hostname}`,
    `port: ${url.port}`,
    `pathname: ${url.pathname}`,
    `search: ${url.search}`,
    `hash: ${url.hash}`,
    ...(queryParamLines.length > 0 ? queryParamLines : ["query: none"]),
  ];
};

const readQueryParamEntries = (
  value: unknown,
): { entries?: [string, string][]; error?: string } => {
  if (value === undefined || value === null) {
    return { entries: [] };
  }

  if (!Array.isArray(value)) {
    return { error: "Expected `queryParams` to be an array when provided." };
  }

  if (value.length > MAX_URL_QUERY_PARAMS) {
    return {
      error: `Expected \`queryParams\` to contain no more than ${MAX_URL_QUERY_PARAMS} entries.`,
    };
  }

  const entries: [string, string][] = [];

  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return {
        error:
          "Expected every `queryParams` entry to be an object with `name` and `value` strings.",
      };
    }

    const record = item as Record<string, unknown>;
    const name = coerceString(record, "name");
    const rawValue = coerceRawString(record, "value");

    if (!name || rawValue === undefined) {
      return {
        error:
          "Expected every `queryParams` entry to include a non-empty string `name` and string `value`.",
      };
    }

    entries.push([name, rawValue]);
  }

  return { entries };
};

const normalizeVersionInput = (value: string): string => {
  return value.trim().replace(/^v(?=\d)/iu, "");
};

const parseVersionIdentifiers = (value: string): VersionIdentifier[] => {
  return value
    .split(/[._-]/u)
    .flatMap((segment) => segment.match(/\d+|[a-z]+/giu) ?? [])
    .map((segment) =>
      /^\d+$/u.test(segment)
        ? { kind: "number", value: Number(segment) }
        : { kind: "text", value: segment.toLowerCase() },
    );
};

const splitVersion = (
  value: string,
): { main: VersionIdentifier[]; prerelease: VersionIdentifier[] } => {
  const normalized = normalizeVersionInput(value);
  const buildMetadataIndex = normalized.indexOf("+");
  const withoutBuildMetadata =
    buildMetadataIndex >= 0
      ? normalized.slice(0, buildMetadataIndex)
      : normalized;
  const prereleaseIndex = withoutBuildMetadata.indexOf("-");
  const mainText =
    prereleaseIndex >= 0
      ? withoutBuildMetadata.slice(0, prereleaseIndex)
      : withoutBuildMetadata;
  const prereleaseText =
    prereleaseIndex >= 0
      ? withoutBuildMetadata.slice(prereleaseIndex + 1)
      : "";

  return {
    main: parseVersionIdentifiers(mainText),
    prerelease: parseVersionIdentifiers(prereleaseText),
  };
};

const compareVersionIdentifier = (
  left: VersionIdentifier,
  right: VersionIdentifier,
): number => {
  if (left.kind === "number" && right.kind === "number") {
    return Math.sign(left.value - right.value);
  }

  if (left.kind === "number") {
    return -1;
  }

  if (right.kind === "number") {
    return 1;
  }

  return left.value.localeCompare(right.value);
};

const compareVersionIdentifierLists = (
  left: VersionIdentifier[],
  right: VersionIdentifier[],
  missingMainAsZero: boolean,
): number => {
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier =
      left[index] ??
      (missingMainAsZero ? { kind: "number" as const, value: 0 } : undefined);
    const rightIdentifier =
      right[index] ??
      (missingMainAsZero ? { kind: "number" as const, value: 0 } : undefined);

    if (!leftIdentifier && !rightIdentifier) {
      return 0;
    }

    if (!leftIdentifier) {
      return -1;
    }

    if (!rightIdentifier) {
      return 1;
    }

    const comparison = compareVersionIdentifier(leftIdentifier, rightIdentifier);

    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
};

const compareVersions = (left: string, right: string): number => {
  const parsedLeft = splitVersion(left);
  const parsedRight = splitVersion(right);
  const mainComparison = compareVersionIdentifierLists(
    parsedLeft.main,
    parsedRight.main,
    true,
  );

  if (mainComparison !== 0) {
    return mainComparison;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length > 0) {
    return 1;
  }

  if (parsedLeft.prerelease.length > 0 && parsedRight.prerelease.length === 0) {
    return -1;
  }

  return compareVersionIdentifierLists(
    parsedLeft.prerelease,
    parsedRight.prerelease,
    false,
  );
};

const normalizeRegexFlags = (
  value: string | undefined,
): { flags?: string; error?: string } => {
  const rawFlags = value ?? "";

  if (/[^gimsu]/u.test(rawFlags)) {
    return { error: "Expected `flags` to contain only g, i, m, s, or u." };
  }

  return { flags: Array.from(new Set([...rawFlags, "g"])).join("") };
};

const formatRegexMatches = (
  regex: RegExp,
  text: string,
  maxMatches: number,
): string[] => {
  const lines: string[] = [];
  let matchCount = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) && matchCount < maxMatches) {
    matchCount += 1;
    lines.push(`match ${matchCount}: index=${match.index}, text=${match[0]}`);

    for (let index = 1; index < match.length; index += 1) {
      lines.push(`  group ${index}: ${match[index] ?? ""}`);
    }

    if (match.groups) {
      for (const [name, value] of Object.entries(match.groups)) {
        lines.push(`  group ${name}: ${value ?? ""}`);
      }
    }

    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }

  return lines.length > 0 ? lines : ["matches: none"];
};

const splitTextLines = (text: string): string[] => {
  return text.length === 0 ? [] : text.split(/\r\n|\r|\n/u);
};

const createLineDiffOperations = (
  leftLines: string[],
  rightLines: string[],
): DiffOperation[] => {
  const rows = leftLines.length + 1;
  const columns = rightLines.length + 1;
  const matrix = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0),
  );

  for (let leftIndex = leftLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
    const currentRow = matrix[leftIndex] ?? [];
    const nextRow = matrix[leftIndex + 1] ?? [];

    for (
      let rightIndex = rightLines.length - 1;
      rightIndex >= 0;
      rightIndex -= 1
    ) {
      currentRow[rightIndex] =
        (leftLines[leftIndex] ?? "") === (rightLines[rightIndex] ?? "")
          ? (nextRow[rightIndex + 1] ?? 0) + 1
          : Math.max(
              nextRow[rightIndex] ?? 0,
              currentRow[rightIndex + 1] ?? 0,
            );
    }
  }

  const operations: DiffOperation[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftLines.length && rightIndex < rightLines.length) {
    if ((leftLines[leftIndex] ?? "") === (rightLines[rightIndex] ?? "")) {
      operations.push({ kind: "same", text: leftLines[leftIndex] ?? "" });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    const removeScore = matrix[leftIndex + 1]?.[rightIndex] ?? 0;
    const addScore = matrix[leftIndex]?.[rightIndex + 1] ?? 0;

    if (removeScore >= addScore) {
      operations.push({ kind: "remove", text: leftLines[leftIndex] ?? "" });
      leftIndex += 1;
      continue;
    }

    operations.push({ kind: "add", text: rightLines[rightIndex] ?? "" });
    rightIndex += 1;
  }

  while (leftIndex < leftLines.length) {
    operations.push({ kind: "remove", text: leftLines[leftIndex] ?? "" });
    leftIndex += 1;
  }

  while (rightIndex < rightLines.length) {
    operations.push({ kind: "add", text: rightLines[rightIndex] ?? "" });
    rightIndex += 1;
  }

  return operations;
};

const prefixDiffOperation = (operation: DiffOperation): string => {
  switch (operation.kind) {
    case "add":
      return `+${operation.text}`;
    case "remove":
      return `-${operation.text}`;
    case "same":
    default:
      return ` ${operation.text}`;
  }
};

const createCompactDiffLines = (
  operations: DiffOperation[],
  contextLines: number,
  maxOutputLines: number,
): string[] => {
  const changedIndexes = operations.flatMap((operation, index) =>
    operation.kind === "same" ? [] : [index],
  );

  if (changedIndexes.length === 0) {
    return ["No differences."];
  }

  const includedIndexes = new Set<number>();

  for (const index of changedIndexes) {
    for (
      let includeIndex = Math.max(0, index - contextLines);
      includeIndex <= Math.min(operations.length - 1, index + contextLines);
      includeIndex += 1
    ) {
      includedIndexes.add(includeIndex);
    }
  }

  const lines: string[] = [];
  let omitted = false;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];

    if (!operation) {
      continue;
    }

    if (!includedIndexes.has(index)) {
      if (!omitted) {
        lines.push("...");
        omitted = true;
      }

      continue;
    }

    lines.push(prefixDiffOperation(operation));
    omitted = false;

    if (lines.length >= maxOutputLines) {
      lines.push("... truncated");
      break;
    }
  }

  return lines;
};

export const createUtilityToolDefinitions = (): AgentToolDefinition[] => {
  const definitions: Array<Omit<AgentToolDefinition, "effect">> = [
    {
      spec: {
        name: "generate_uuid",
        description:
          "Generate one or more RFC 4122 version 4 UUIDs using cryptographically strong randomness.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: {
              type: "integer",
              minimum: 1,
              maximum: MAX_UUID_COUNT,
              description: "Number of UUIDs to generate. Defaults to 1.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const count = coerceInteger(args, "count") ?? 1;
        const countError = validateCount(
          count,
          MAX_UUID_COUNT,
          "generate_uuid",
        );

        if (countError) {
          return countError;
        }

        const uuids = Array.from({ length: count }, () => randomUUID());
        const output =
          uuids.length === 1 ? `UUID: ${uuids[0]}` : uuids.join("\n");

        return {
          toolResult: {
            callId: randomUUID(),
            name: "generate_uuid",
            output,
          },
          sections: [
            {
              title: "Generated UUIDs",
              lines: uuids,
            },
          ],
          traceLines: [`generate_uuid(count=${count}) -> ${count}`],
        };
      },
    },
    {
      spec: {
        name: "generate_random_string",
        description:
          "Generate one or more random strings using cryptographically strong randomness. Use this for non-secret identifiers, nonces, tokens, passwords and similar utility values.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            length: {
              type: "integer",
              minimum: 1,
              maximum: MAX_RANDOM_STRING_LENGTH,
              description:
                "Length of each generated string. Defaults to 32 characters.",
            },
            count: {
              type: "integer",
              minimum: 1,
              maximum: MAX_RANDOM_STRING_COUNT,
              description: "Number of strings to generate. Defaults to 1.",
            },
            charset: {
              type: "string",
              enum: RANDOM_STRING_CHARSET_NAMES,
              description:
                "Character set to use. Defaults to alphanumeric. Use custom with customAlphabet for a caller-supplied alphabet.",
            },
            customAlphabet: {
              type: "string",
              description:
                "Characters to sample from when charset is custom. Duplicate characters are ignored.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const length =
          coerceInteger(args, "length") ?? DEFAULT_RANDOM_STRING_LENGTH;
        const count = coerceInteger(args, "count") ?? 1;
        const charset = normalizeRandomStringCharset(
          coerceString(args, "charset"),
        );
        const customAlphabet = coerceString(args, "customAlphabet");
        const countError = validateCount(
          count,
          MAX_RANDOM_STRING_COUNT,
          "generate_random_string",
        );

        if (countError) {
          return countError;
        }

        if (length < 1 || length > MAX_RANDOM_STRING_LENGTH) {
          return createToolErrorResult(
            randomUUID(),
            "generate_random_string",
            `Expected \`length\` to be between 1 and ${MAX_RANDOM_STRING_LENGTH}.`,
          );
        }

        if (
          customAlphabet &&
          Array.from(new Set([...customAlphabet])).length >
            MAX_CUSTOM_ALPHABET_LENGTH
        ) {
          return createToolErrorResult(
            randomUUID(),
            "generate_random_string",
            `Expected \`customAlphabet\` to contain no more than ${MAX_CUSTOM_ALPHABET_LENGTH} distinct characters.`,
          );
        }

        const alphabet = resolveRandomStringAlphabet(charset, customAlphabet);

        if (!alphabet || alphabet.length < 2) {
          return createToolErrorResult(
            randomUUID(),
            "generate_random_string",
            charset === "custom"
              ? "Expected `customAlphabet` to contain at least two distinct characters when `charset` is `custom`."
              : "The selected charset does not contain enough characters.",
          );
        }

        const values = Array.from({ length: count }, () =>
          createRandomString(length, alphabet),
        );
        const output =
          values.length === 1
            ? `Random string: ${values[0]}`
            : values.join("\n");

        return {
          toolResult: {
            callId: randomUUID(),
            name: "generate_random_string",
            output,
          },
          sections: [
            {
              title: "Generated random strings",
              lines: values,
            },
            {
              title: "Random string settings",
              lines: [
                `length: ${length}`,
                `count: ${count}`,
                `charset: ${charset}`,
                `alphabet size: ${alphabet.length}`,
              ],
            },
          ],
          traceLines: [
            `generate_random_string(length=${length}, count=${count}, charset=${compactTraceText(charset)}) -> ${count}`,
          ],
        };
      },
    },
    {
      spec: {
        name: "get_current_datetime",
        description:
          "Return the current date and time with UTC, epoch, local timezone, and UTC offset details. Use this when the task depends on the actual current time.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            timeZone: {
              type: "string",
              description:
                "Optional IANA timezone such as Europe/Berlin or America/New_York. Defaults to the local runtime timezone.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const requestedTimeZone = coerceString(args, "timeZone");
        const timeZone = requestedTimeZone ?? getLocalTimeZone();

        if (!isValidTimeZone(timeZone)) {
          return createToolErrorResult(
            randomUUID(),
            "get_current_datetime",
            `Expected \`timeZone\` to be a valid IANA timezone. Received \`${timeZone}\`.`,
          );
        }

        const now = new Date();
        const offsetMinutes = getTimeZoneOffsetMinutes(now, timeZone);
        const utcOffset = formatUtcOffset(offsetMinutes);
        const zonedIso = formatZonedIso(now, timeZone, utcOffset);
        const unixSeconds = Math.floor(now.getTime() / 1_000);
        const lines = [
          `time zone: ${timeZone}`,
          `local ISO: ${zonedIso}`,
          `UTC ISO: ${now.toISOString()}`,
          `UTC offset: ${utcOffset}`,
          `unix seconds: ${unixSeconds}`,
          `epoch milliseconds: ${now.getTime()}`,
        ];

        return {
          toolResult: {
            callId: randomUUID(),
            name: "get_current_datetime",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Current date and time",
              lines,
            },
          ],
          traceLines: [`get_current_datetime(${timeZone})`],
        };
      },
    },
    {
      spec: {
        name: "generate_random_number",
        description:
          "Generate one or more random numbers using cryptographically strong randomness. Supports decimal values, integers, bounds, and unique integer samples.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            min: {
              type: "number",
              description:
                "Lower bound. Defaults to 0. For integers this is inclusive.",
            },
            max: {
              type: "number",
              description:
                "Upper bound. Defaults to 1. For integers this is inclusive; for decimals this is exclusive.",
            },
            count: {
              type: "integer",
              minimum: 1,
              maximum: MAX_RANDOM_NUMBER_COUNT,
              description: "Number of values to generate. Defaults to 1.",
            },
            integer: {
              type: "boolean",
              description:
                "Generate integers instead of decimal values. Defaults to false.",
            },
            unique: {
              type: "boolean",
              description:
                "Require unique values. Supported only for integer generation.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const min = coerceFiniteNumber(args, "min") ?? 0;
        const max = coerceFiniteNumber(args, "max") ?? 1;
        const count = coerceInteger(args, "count") ?? 1;
        const integer = coerceBoolean(args, "integer") ?? false;
        const unique = coerceBoolean(args, "unique") ?? false;
        const countError = validateCount(
          count,
          MAX_RANDOM_NUMBER_COUNT,
          "generate_random_number",
        );

        if (countError) {
          return countError;
        }

        const values = createRandomNumberValues(
          min,
          max,
          count,
          integer,
          unique,
        );

        if (typeof values === "string") {
          return createToolErrorResult(
            randomUUID(),
            "generate_random_number",
            values,
          );
        }

        const lines = values.map(formatNumberValue);

        return {
          toolResult: {
            callId: randomUUID(),
            name: "generate_random_number",
            output:
              lines.length === 1
                ? `Random number: ${lines[0]}`
                : lines.join("\n"),
          },
          sections: [
            {
              title: "Generated random numbers",
              lines,
            },
            {
              title: "Random number settings",
              lines: [
                `min: ${min}`,
                `max: ${max}`,
                `count: ${count}`,
                `integer: ${integer ? "true" : "false"}`,
                `unique: ${unique ? "true" : "false"}`,
              ],
            },
          ],
          traceLines: [
            `generate_random_number(min=${min}, max=${max}, count=${count}, integer=${integer}) -> ${count}`,
          ],
        };
      },
    },
    {
      spec: {
        name: "generate_ulid",
        description:
          "Generate one or more ULID-compatible, time-sortable identifiers.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            count: {
              type: "integer",
              minimum: 1,
              maximum: MAX_ULID_COUNT,
              description: "Number of ULIDs to generate. Defaults to 1.",
            },
          },
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const count = coerceInteger(args, "count") ?? 1;
        const countError = validateCount(count, MAX_ULID_COUNT, "generate_ulid");

        if (countError) {
          return countError;
        }

        const timestampMs = Date.now();
        const randomBase = createRandomUlidBase(count);
        const ulids = Array.from({ length: count }, (_value, index) =>
          createUlid(timestampMs, randomBase + BigInt(index)),
        );

        return {
          toolResult: {
            callId: randomUUID(),
            name: "generate_ulid",
            output: ulids.length === 1 ? `ULID: ${ulids[0]}` : ulids.join("\n"),
          },
          sections: [
            {
              title: "Generated ULIDs",
              lines: ulids,
            },
          ],
          traceLines: [`generate_ulid(count=${count}) -> ${count}`],
        };
      },
    },
    {
      spec: {
        name: "hash_text",
        description:
          "Hash text using a selected digest algorithm and output encoding. Use this for checksums, cache keys, and compatibility hashes.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Text to hash as UTF-8.",
            },
            algorithm: {
              type: "string",
              enum: HASH_ALGORITHMS,
              description: "Hash algorithm. Defaults to sha256.",
            },
            outputEncoding: {
              type: "string",
              enum: HASH_OUTPUT_ENCODINGS,
              description: "Digest output encoding. Defaults to hex.",
            },
          },
          required: ["text"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const text = coerceRawString(args, "text");

        if (text === undefined) {
          return createToolErrorResult(
            randomUUID(),
            "hash_text",
            "Expected a string `text`.",
          );
        }

        const lengthError = validateTextLength(text, "text", "hash_text");

        if (lengthError) {
          return lengthError;
        }

        const algorithm = normalizeEnumValue(
          coerceString(args, "algorithm"),
          HASH_ALGORITHMS,
          "sha256",
        );
        const outputEncoding = normalizeEnumValue(
          coerceString(args, "outputEncoding"),
          HASH_OUTPUT_ENCODINGS,
          "hex",
        );
        const digest = createHash(algorithm)
          .update(text, "utf8")
          .digest(outputEncoding);

        return {
          toolResult: {
            callId: randomUUID(),
            name: "hash_text",
            output: digest,
          },
          sections: [
            {
              title: "Text hash",
              lines: [
                `algorithm: ${algorithm}`,
                `output encoding: ${outputEncoding}`,
                `digest: ${digest}`,
              ],
            },
          ],
          traceLines: [
            `hash_text(algorithm=${algorithm}, encoding=${outputEncoding})`,
          ],
        };
      },
    },
    {
      spec: {
        name: "encode_text",
        description:
          "Encode UTF-8 text as base64, base64url, URL percent-encoding, or hexadecimal.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Text to encode.",
            },
            format: {
              type: "string",
              enum: TEXT_ENCODING_FORMATS,
              description: "Encoding format. Defaults to base64.",
            },
          },
          required: ["text"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const text = coerceRawString(args, "text");

        if (text === undefined) {
          return createToolErrorResult(
            randomUUID(),
            "encode_text",
            "Expected a string `text`.",
          );
        }

        const lengthError = validateTextLength(text, "text", "encode_text");

        if (lengthError) {
          return lengthError;
        }

        const format = normalizeEnumValue(
          coerceString(args, "format"),
          TEXT_ENCODING_FORMATS,
          "base64",
        );
        const encoded = encodeTextValue(text, format);

        return {
          toolResult: {
            callId: randomUUID(),
            name: "encode_text",
            output: encoded,
          },
          sections: [
            {
              title: "Encoded text",
              lines: [`format: ${format}`, `value: ${encoded}`],
            },
          ],
          traceLines: [`encode_text(format=${format})`],
        };
      },
    },
    {
      spec: {
        name: "decode_text",
        description:
          "Decode base64, base64url, URL percent-encoded, or hexadecimal text into UTF-8.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            value: {
              type: "string",
              description: "Encoded value to decode.",
            },
            format: {
              type: "string",
              enum: TEXT_ENCODING_FORMATS,
              description: "Input encoding format. Defaults to base64.",
            },
          },
          required: ["value"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const value = coerceRawString(args, "value");

        if (value === undefined) {
          return createToolErrorResult(
            randomUUID(),
            "decode_text",
            "Expected a string `value`.",
          );
        }

        const lengthError = validateTextLength(value, "value", "decode_text");

        if (lengthError) {
          return lengthError;
        }

        const format = normalizeEnumValue(
          coerceString(args, "format"),
          TEXT_ENCODING_FORMATS,
          "base64",
        );
        const decoded = decodeTextValue(value, format);

        if (decoded.error) {
          return createToolErrorResult(
            randomUUID(),
            "decode_text",
            decoded.error,
          );
        }

        return {
          toolResult: {
            callId: randomUUID(),
            name: "decode_text",
            output: decoded.decoded ?? "",
          },
          sections: [
            {
              title: "Decoded text",
              lines: [`format: ${format}`, `value: ${decoded.decoded ?? ""}`],
            },
          ],
          traceLines: [`decode_text(format=${format})`],
        };
      },
    },
    {
      spec: {
        name: "validate_json",
        description:
          "Parse JSON and report whether it is valid. Can also pretty-print or minify valid JSON.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "JSON text to validate.",
            },
            outputStyle: {
              type: "string",
              enum: JSON_OUTPUT_STYLES,
              description:
                "Optional output style for valid JSON: none, pretty, or minified. Defaults to none.",
            },
            indent: {
              type: "integer",
              minimum: 0,
              maximum: MAX_JSON_INDENT,
              description:
                "Indent size for pretty output. Defaults to 2 and is capped at 8.",
            },
          },
          required: ["text"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const text = coerceRawString(args, "text");

        if (text === undefined || text.length === 0) {
          return createToolErrorResult(
            randomUUID(),
            "validate_json",
            "Expected a non-empty string `text`.",
          );
        }

        const lengthError = validateTextLength(text, "text", "validate_json");

        if (lengthError) {
          return lengthError;
        }

        const outputStyle = normalizeEnumValue(
          coerceString(args, "outputStyle"),
          JSON_OUTPUT_STYLES,
          "none",
        );
        const indent = coerceInteger(args, "indent") ?? 2;

        if (indent < 0 || indent > MAX_JSON_INDENT) {
          return createToolErrorResult(
            randomUUID(),
            "validate_json",
            `Expected \`indent\` to be between 0 and ${MAX_JSON_INDENT}.`,
          );
        }

        try {
          const parsed = JSON.parse(text) as unknown;
          const formatted =
            outputStyle === "pretty"
              ? JSON.stringify(parsed, null, indent)
              : outputStyle === "minified"
                ? JSON.stringify(parsed)
                : undefined;
          const lines = [
            "valid: true",
            `top-level type: ${getJsonValueType(parsed)}`,
            ...(formatted ? [`output: ${formatted}`] : []),
          ];

          return {
            toolResult: {
              callId: randomUUID(),
              name: "validate_json",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "JSON validation",
                lines,
              },
            ],
            traceLines: [`validate_json(valid=true, style=${outputStyle})`],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Invalid JSON.";
          const position = extractJsonErrorPosition(message);
          const lineColumn =
            position === undefined
              ? undefined
              : computeJsonLineColumn(text, position);
          const lines = [
            "valid: false",
            `error: ${message}`,
            ...(position === undefined ? [] : [`position: ${position}`]),
            ...(lineColumn
              ? [`line: ${lineColumn.line}`, `column: ${lineColumn.column}`]
              : []),
          ];

          return {
            toolResult: {
              callId: randomUUID(),
              name: "validate_json",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "JSON validation",
                lines,
              },
            ],
            traceLines: ["validate_json(valid=false)"],
          };
        }
      },
    },
    {
      spec: {
        name: "format_slug",
        description:
          "Convert text into slug and identifier styles such as kebab, snake, camel, Pascal, or constant case.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Text to format.",
            },
            style: {
              type: "string",
              enum: IDENTIFIER_STYLES,
              description:
                "Output style. Supported values: slug, kebab, snake, camel, pascal, constant. Defaults to slug.",
            },
          },
          required: ["text"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const text = coerceRawString(args, "text");

        if (text === undefined) {
          return createToolErrorResult(
            randomUUID(),
            "format_slug",
            "Expected a string `text`.",
          );
        }

        const lengthError = validateTextLength(text, "text", "format_slug");

        if (lengthError) {
          return lengthError;
        }

        const style = normalizeEnumValue(
          coerceString(args, "style"),
          IDENTIFIER_STYLES,
          "slug",
        );
        const words = normalizeIdentifierWords(text);

        if (words.length === 0) {
          return createToolErrorResult(
            randomUUID(),
            "format_slug",
            "Expected `text` to contain at least one letter or digit.",
          );
        }

        const formatted = formatIdentifier(words, style);

        return {
          toolResult: {
            callId: randomUUID(),
            name: "format_slug",
            output: formatted,
          },
          sections: [
            {
              title: "Formatted identifier",
              lines: [`style: ${style}`, `value: ${formatted}`],
            },
          ],
          traceLines: [`format_slug(style=${style})`],
        };
      },
    },
    {
      spec: {
        name: "parse_url",
        description:
          "Parse an absolute or base-relative URL into its normalized components and query parameters.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: {
              type: "string",
              description: "URL to parse.",
            },
            baseUrl: {
              type: "string",
              description:
                "Optional absolute base URL for parsing relative URLs.",
            },
          },
          required: ["url"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const value = coerceString(args, "url");
        const baseUrl = coerceString(args, "baseUrl");

        if (!value) {
          return createToolErrorResult(
            randomUUID(),
            "parse_url",
            "Expected a non-empty string `url`.",
          );
        }

        const url = createUrl(value, baseUrl);

        if (!url) {
          return createToolErrorResult(
            randomUUID(),
            "parse_url",
            "Expected `url` to be absolute, or relative with a valid absolute `baseUrl`.",
          );
        }

        const lines = createParsedUrlLines(url);

        return {
          toolResult: {
            callId: randomUUID(),
            name: "parse_url",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Parsed URL",
              lines,
            },
          ],
          traceLines: [`parse_url(${compactTraceText(url.href)})`],
        };
      },
    },
    {
      spec: {
        name: "build_url",
        description:
          "Build a URL from a base URL plus optional query parameter entries and hash fragment.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            baseUrl: {
              type: "string",
              description: "Absolute base URL to build from.",
            },
            queryParams: {
              type: "array",
              description:
                "Optional query parameters to append. Existing parameters are preserved.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: {
                    type: "string",
                    description: "Query parameter name.",
                  },
                  value: {
                    type: "string",
                    description: "Query parameter value.",
                  },
                },
                required: ["name", "value"],
              },
            },
            hash: {
              type: "string",
              description:
                "Optional hash fragment. A leading # is accepted but not required.",
            },
          },
          required: ["baseUrl"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const baseUrl = coerceString(args, "baseUrl");

        if (!baseUrl) {
          return createToolErrorResult(
            randomUUID(),
            "build_url",
            "Expected a non-empty string `baseUrl`.",
          );
        }

        const url = createUrl(baseUrl, undefined);

        if (!url) {
          return createToolErrorResult(
            randomUUID(),
            "build_url",
            "Expected `baseUrl` to be a valid absolute URL.",
          );
        }

        const queryParams = readQueryParamEntries(args.queryParams);

        if (queryParams.error) {
          return createToolErrorResult(
            randomUUID(),
            "build_url",
            queryParams.error,
          );
        }

        for (const [name, value] of queryParams.entries ?? []) {
          url.searchParams.append(name, value);
        }

        const hash = coerceRawString(args, "hash");

        if (hash !== undefined) {
          url.hash = hash.startsWith("#") ? hash.slice(1) : hash;
        }

        return {
          toolResult: {
            callId: randomUUID(),
            name: "build_url",
            output: url.href,
          },
          sections: [
            {
              title: "Built URL",
              lines: [`href: ${url.href}`],
            },
          ],
          traceLines: [`build_url(${compactTraceText(url.href)})`],
        };
      },
    },
    {
      spec: {
        name: "compare_versions",
        description:
          "Compare two semver-like version strings, including prerelease ordering and build-metadata ignoring.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            left: {
              type: "string",
              description: "Left version string.",
            },
            right: {
              type: "string",
              description: "Right version string.",
            },
          },
          required: ["left", "right"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const left = coerceString(args, "left");
        const right = coerceString(args, "right");

        if (!left || !right) {
          return createToolErrorResult(
            randomUUID(),
            "compare_versions",
            "Expected non-empty string `left` and `right` versions.",
          );
        }

        if (
          left.length > MAX_VERSION_INPUT_CHARS ||
          right.length > MAX_VERSION_INPUT_CHARS
        ) {
          return createToolErrorResult(
            randomUUID(),
            "compare_versions",
            `Expected version strings to be no longer than ${MAX_VERSION_INPUT_CHARS} characters.`,
          );
        }

        const comparison = Math.sign(compareVersions(left, right));
        const relation =
          comparison < 0 ? "less" : comparison > 0 ? "greater" : "equal";
        const symbol = comparison < 0 ? "<" : comparison > 0 ? ">" : "=";
        const lines = [
          `left: ${left}`,
          `right: ${right}`,
          `result: ${left} ${symbol} ${right}`,
          `order: ${relation}`,
          `comparison: ${comparison}`,
        ];

        return {
          toolResult: {
            callId: randomUUID(),
            name: "compare_versions",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Version comparison",
              lines,
            },
          ],
          traceLines: [`compare_versions(${left}, ${right}) -> ${comparison}`],
        };
      },
    },
    {
      spec: {
        name: "test_regex",
        description:
          "Run a JavaScript regular expression against bounded text and return capped matches and capture groups.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            pattern: {
              type: "string",
              description:
                "JavaScript regular expression pattern without slash delimiters.",
            },
            text: {
              type: "string",
              description: "Text to test against.",
            },
            flags: {
              type: "string",
              description:
                "Optional JavaScript regex flags. Allowed: g, i, m, s, u. g is applied automatically.",
            },
            maxMatches: {
              type: "integer",
              minimum: 1,
              maximum: MAX_REGEX_MATCHES,
              description:
                "Maximum matches to return. Defaults to 20 and is capped at 100.",
            },
          },
          required: ["pattern", "text"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const pattern = coerceRawString(args, "pattern");
        const text = coerceRawString(args, "text");
        const maxMatches = coerceInteger(args, "maxMatches") ?? DEFAULT_REGEX_MATCHES;

        if (pattern === undefined || text === undefined) {
          return createToolErrorResult(
            randomUUID(),
            "test_regex",
            "Expected string `pattern` and `text`.",
          );
        }

        if (pattern.length > MAX_REGEX_PATTERN_CHARS) {
          return createToolErrorResult(
            randomUUID(),
            "test_regex",
            `Expected \`pattern\` to be no longer than ${MAX_REGEX_PATTERN_CHARS} characters.`,
          );
        }

        if (text.length > MAX_REGEX_TEXT_CHARS) {
          return createToolErrorResult(
            randomUUID(),
            "test_regex",
            `Expected \`text\` to be no longer than ${MAX_REGEX_TEXT_CHARS} characters.`,
          );
        }

        const countError = validateCount(
          maxMatches,
          MAX_REGEX_MATCHES,
          "test_regex",
        );

        if (countError) {
          return countError;
        }

        const normalizedFlags = normalizeRegexFlags(coerceString(args, "flags"));

        if (normalizedFlags.error) {
          return createToolErrorResult(
            randomUUID(),
            "test_regex",
            normalizedFlags.error,
          );
        }

        try {
          const regex = new RegExp(pattern, normalizedFlags.flags);
          const lines = formatRegexMatches(regex, text, maxMatches);

          return {
            toolResult: {
              callId: randomUUID(),
              name: "test_regex",
              output: lines.join("\n"),
            },
            sections: [
              {
                title: "Regex matches",
                lines,
              },
            ],
            traceLines: [
              `test_regex(pattern=${compactTraceText(pattern)}, flags=${normalizedFlags.flags})`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            randomUUID(),
            "test_regex",
            error instanceof Error ? error.message : "Invalid regular expression.",
          );
        }
      },
    },
    {
      spec: {
        name: "diff_text",
        description:
          "Create a compact line-oriented diff for two bounded text values.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            left: {
              type: "string",
              description: "Original text.",
            },
            right: {
              type: "string",
              description: "Changed text.",
            },
            contextLines: {
              type: "integer",
              minimum: 0,
              maximum: MAX_DIFF_CONTEXT_LINES,
              description: "Unchanged context lines around changes. Defaults to 2.",
            },
            maxOutputLines: {
              type: "integer",
              minimum: 1,
              maximum: MAX_DIFF_OUTPUT_LINES,
              description:
                "Maximum diff lines to return. Defaults to 200 and is capped at 400.",
            },
          },
          required: ["left", "right"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const left = coerceRawString(args, "left");
        const right = coerceRawString(args, "right");
        const contextLines =
          coerceInteger(args, "contextLines") ?? DEFAULT_DIFF_CONTEXT_LINES;
        const maxOutputLines =
          coerceInteger(args, "maxOutputLines") ?? DEFAULT_DIFF_OUTPUT_LINES;

        if (left === undefined || right === undefined) {
          return createToolErrorResult(
            randomUUID(),
            "diff_text",
            "Expected string `left` and `right`.",
          );
        }

        if (left.length > MAX_DIFF_TEXT_CHARS || right.length > MAX_DIFF_TEXT_CHARS) {
          return createToolErrorResult(
            randomUUID(),
            "diff_text",
            `Expected \`left\` and \`right\` to be no longer than ${MAX_DIFF_TEXT_CHARS} characters.`,
          );
        }

        if (contextLines < 0 || contextLines > MAX_DIFF_CONTEXT_LINES) {
          return createToolErrorResult(
            randomUUID(),
            "diff_text",
            `Expected \`contextLines\` to be between 0 and ${MAX_DIFF_CONTEXT_LINES}.`,
          );
        }

        if (maxOutputLines < 1 || maxOutputLines > MAX_DIFF_OUTPUT_LINES) {
          return createToolErrorResult(
            randomUUID(),
            "diff_text",
            `Expected \`maxOutputLines\` to be between 1 and ${MAX_DIFF_OUTPUT_LINES}.`,
          );
        }

        const leftLines = splitTextLines(left);
        const rightLines = splitTextLines(right);

        if (
          leftLines.length > MAX_DIFF_INPUT_LINES ||
          rightLines.length > MAX_DIFF_INPUT_LINES
        ) {
          return createToolErrorResult(
            randomUUID(),
            "diff_text",
            `Expected each input to contain no more than ${MAX_DIFF_INPUT_LINES} lines.`,
          );
        }

        const operations = createLineDiffOperations(leftLines, rightLines);
        const lines = createCompactDiffLines(
          operations,
          contextLines,
          maxOutputLines,
        );

        return {
          toolResult: {
            callId: randomUUID(),
            name: "diff_text",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Text diff",
              lines,
            },
          ],
          traceLines: [
            `diff_text(leftLines=${leftLines.length}, rightLines=${rightLines.length})`,
          ],
        };
      },
    },
    {
      spec: {
        name: "sort_unique_lines",
        description:
          "Sort and deduplicate a bounded newline-separated list.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Newline-separated text to sort and deduplicate.",
            },
            caseSensitive: {
              type: "boolean",
              description: "Treat differently-cased lines as distinct. Defaults to true.",
            },
            trimLines: {
              type: "boolean",
              description: "Trim each line before deduplication. Defaults to true.",
            },
            removeEmpty: {
              type: "boolean",
              description: "Remove empty lines. Defaults to true.",
            },
            descending: {
              type: "boolean",
              description: "Sort descending instead of ascending.",
            },
          },
          required: ["text"],
        },
      },
      backingTool: "utilities",
      riskLevel: "low",
      execute: async (args) => {
        const text = coerceRawString(args, "text");

        if (text === undefined) {
          return createToolErrorResult(
            randomUUID(),
            "sort_unique_lines",
            "Expected a string `text`.",
          );
        }

        const lengthError = validateTextLength(text, "text", "sort_unique_lines");

        if (lengthError) {
          return lengthError;
        }

        const caseSensitive = coerceBoolean(args, "caseSensitive") ?? true;
        const trimLines = coerceBoolean(args, "trimLines") ?? true;
        const removeEmpty = coerceBoolean(args, "removeEmpty") ?? true;
        const descending = coerceBoolean(args, "descending") ?? false;
        const lines = sortUniqueLines(text, {
          caseSensitive,
          trimLines,
          removeEmpty,
          descending,
        });

        if (typeof lines === "string") {
          return createToolErrorResult(
            randomUUID(),
            "sort_unique_lines",
            lines,
          );
        }

        return {
          toolResult: {
            callId: randomUUID(),
            name: "sort_unique_lines",
            output: lines.join("\n"),
          },
          sections: [
            {
              title: "Sorted unique lines",
              lines: lines.length > 0 ? lines : ["No lines."],
            },
          ],
          traceLines: [`sort_unique_lines(lines=${lines.length})`],
        };
      },
    },
  ];

  return definitions.map((definition) => ({
    ...definition,
    effect: "read",
  }));
};
