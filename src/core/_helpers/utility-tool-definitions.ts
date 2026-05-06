import { randomInt, randomUUID } from "node:crypto";
import {
  coerceInteger,
  coerceString,
  createToolErrorResult,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import { compactTraceText } from "./runtime-text.js";

const MAX_UUID_COUNT = 100;
const DEFAULT_RANDOM_STRING_LENGTH = 32;
const MAX_RANDOM_STRING_LENGTH = 1_024;
const MAX_RANDOM_STRING_COUNT = 100;
const MAX_CUSTOM_ALPHABET_LENGTH = 256;

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

export const createUtilityToolDefinitions = (): AgentToolDefinition[] => {
  return [
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
  ];
};
