export interface ChatInputNeededPlaceholder {
  key: string;
  lookupKey: string;
  occurrenceCount: number;
  defaultValue?: string;
  optional?: boolean;
  options?: string[];
}

interface ChatInputNeededPlaceholderMatch {
  key: string;
  lookupKey: string;
  defaultValue?: string;
  optional?: boolean;
  options?: string[];
}

const CHAT_INPUT_NEEDED_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,79}/u;
const CHAT_INPUT_NEEDED_PLACEHOLDER_PATTERN = /(?<!\\)\[\[\s*([^\]\r\n]+?)\s*\]\]/gu;

const normalizePlaceholderLookupKey = (key: string): string =>
  key.trim().toLowerCase();

const dedupeOptions = (options: readonly string[]): string[] => {
  const seen = new Set<string>();
  const dedupedOptions: string[] = [];

  for (const option of options) {
    const lookupKey = option.toLowerCase();

    if (seen.has(lookupKey)) {
      continue;
    }

    seen.add(lookupKey);
    dedupedOptions.push(option);
  }

  return dedupedOptions;
};

const parseOptions = (value: string): string[] => {
  return dedupeOptions(
    value
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean),
  );
};

const appendDefaultOption = (
  options: string[],
  defaultValue: string | undefined,
): string[] => {
  if (
    !defaultValue ||
    options.some((option) => option.toLowerCase() === defaultValue.toLowerCase())
  ) {
    return options;
  }

  return [...options, defaultValue];
};

const parseChatInputNeededPlaceholder = (
  content: string,
): ChatInputNeededPlaceholderMatch | null => {
  const body = content.trim();
  const keyMatch = body.match(CHAT_INPUT_NEEDED_KEY_PATTERN);

  if (!keyMatch) {
    return null;
  }

  const key = keyMatch[0];
  let remainder = body.slice(key.length).trimStart();
  let optional = false;

  if (remainder.startsWith("?")) {
    optional = true;
    remainder = remainder.slice(1).trimStart();
  }

  let defaultValue: string | undefined;
  let options: string[] | undefined;

  if (remainder.startsWith("=")) {
    const metadata = remainder.slice(1);
    const optionSeparatorIndex = metadata.indexOf("|");
    const rawDefaultValue =
      optionSeparatorIndex >= 0
        ? metadata.slice(0, optionSeparatorIndex)
        : metadata;
    const normalizedDefaultValue = rawDefaultValue.trim();

    if (normalizedDefaultValue) {
      defaultValue = normalizedDefaultValue;
    }

    if (optionSeparatorIndex >= 0) {
      options = parseOptions(metadata.slice(optionSeparatorIndex + 1));
    }
  } else if (remainder.startsWith("|")) {
    options = parseOptions(remainder.slice(1));
  } else if (remainder.length > 0) {
    return null;
  }

  if (options && options.length === 0) {
    return null;
  }

  if (options) {
    options = appendDefaultOption(options, defaultValue);
  }

  return {
    key,
    lookupKey: normalizePlaceholderLookupKey(key),
    ...(defaultValue ? { defaultValue } : {}),
    ...(optional ? { optional: true } : {}),
    ...(options ? { options } : {}),
  };
};

const findChatInputNeededPlaceholderMatches = (
  message: string,
): ChatInputNeededPlaceholderMatch[] => {
  const matches: ChatInputNeededPlaceholderMatch[] = [];

  for (const match of message.matchAll(CHAT_INPUT_NEEDED_PLACEHOLDER_PATTERN)) {
    const placeholder = parseChatInputNeededPlaceholder(match[1] ?? "");

    if (!placeholder?.lookupKey) {
      continue;
    }

    matches.push(placeholder);
  }

  return matches;
};

export const extractChatInputNeededPlaceholders = (
  message: string,
): ChatInputNeededPlaceholder[] => {
  const placeholders: ChatInputNeededPlaceholder[] = [];
  const placeholderByLookupKey = new Map<string, ChatInputNeededPlaceholder>();

  for (const match of findChatInputNeededPlaceholderMatches(message)) {
    const existingPlaceholder = placeholderByLookupKey.get(match.lookupKey);

    if (existingPlaceholder) {
      existingPlaceholder.occurrenceCount += 1;
      existingPlaceholder.defaultValue ??= match.defaultValue;
      existingPlaceholder.options ??= match.options;

      if (match.optional) {
        existingPlaceholder.optional = true;
      }

      continue;
    }

    const placeholder: ChatInputNeededPlaceholder = {
      key: match.key,
      lookupKey: match.lookupKey,
      occurrenceCount: 1,
      ...(match.defaultValue ? { defaultValue: match.defaultValue } : {}),
      ...(match.optional ? { optional: true } : {}),
      ...(match.options ? { options: match.options } : {}),
    };

    placeholderByLookupKey.set(match.lookupKey, placeholder);
    placeholders.push(placeholder);
  }

  return placeholders;
};

export const replaceChatInputNeededPlaceholders = (
  message: string,
  valuesByLookupKey: Record<string, string>,
): string => {
  return message.replaceAll(
    CHAT_INPUT_NEEDED_PLACEHOLDER_PATTERN,
    (raw, key: string) => {
      const placeholder = parseChatInputNeededPlaceholder(key);
      const value = placeholder
        ? valuesByLookupKey[placeholder.lookupKey]
        : undefined;

      return value === undefined ? raw : value;
    },
  );
};
