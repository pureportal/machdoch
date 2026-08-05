import type {
  CommandPlatform,
  CommandRuntime,
  ShortcutSpec,
} from "./command-types";

export interface ParsedShortcut {
  chord: string;
  key: string;
  mod: boolean;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  match: "key" | "code";
}

const MOD_ALIASES = new Set([
  "mod",
  "commandorcontrol",
  "commandorctrl",
  "cmdorcontrol",
  "cmdorctrl",
]);
const CONTROL_ALIASES = new Set(["control", "ctrl"]);
const META_ALIASES = new Set(["meta", "command", "cmd", "super"]);
const ALT_ALIASES = new Set(["alt", "option"]);

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  comma: ",",
  period: ".",
  space: " ",
  spacebar: " ",
  plus: "+",
  ...Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => {
      const letter = String.fromCharCode("a".charCodeAt(0) + index);
      return [`key${letter}`, letter];
    }),
  ),
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`digit${index}`, `${index}`]),
  ),
};

const DISPLAY_KEYS: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  tab: "Tab",
  insert: "Insert",
  " ": "Space",
  ",": ",",
  ".": ".",
};

const ARIA_KEYS: Readonly<Record<string, string>> = {
  escape: "Escape",
  enter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  tab: "Tab",
  insert: "Insert",
  " ": "Space",
};

const VALID_NAMED_KEYS = new Set([
  ...Object.keys(DISPLAY_KEYS),
  "insert",
  "tab",
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
]);

const VALID_CODE =
  /^(?:key[a-z]|digit[0-9]|f(?:[1-9]|1[0-9]|2[0-4])|numpad(?:[0-9]|add|subtract|multiply|divide|decimal|enter|equal|comma)|arrow(?:up|down|left|right)|escape|enter|space|tab|backspace|delete|insert|home|end|pageup|pagedown|capslock|numlock|scrolllock|pause|printscreen|contextmenu|shift(?:left|right)|control(?:left|right)|alt(?:left|right)|meta(?:left|right)|bracket(?:left|right)|backslash|semicolon|quote|backquote|comma|period|slash|minus|equal|intl(?:backslash|ro|yen)|convert|nonconvert|kana|lang[1-5])$/;

const normalizeKey = (key: string): string => {
  const lower = key.toLocaleLowerCase("en-US");
  return KEY_ALIASES[lower] ?? lower;
};

const normalizeCode = (code: string): string => code.toLocaleLowerCase("en-US");

export const parseShortcut = (
  shortcut: ShortcutSpec | string,
): ParsedShortcut => {
  const spec = typeof shortcut === "string" ? { chord: shortcut } : shortcut;
  const tokens = spec.chord.split("+").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error(`Invalid shortcut chord: ${spec.chord}`);
  }

  let mod = false;
  let control = false;
  let meta = false;
  let alt = false;
  let shift = false;
  let key: string | undefined;

  for (const token of tokens) {
    const lower = token.toLocaleLowerCase("en-US");
    if (MOD_ALIASES.has(lower)) {
      if (mod) throw new Error(`Duplicate modifier in shortcut: ${spec.chord}`);
      mod = true;
    } else if (CONTROL_ALIASES.has(lower)) {
      if (control)
        throw new Error(`Duplicate modifier in shortcut: ${spec.chord}`);
      control = true;
    } else if (META_ALIASES.has(lower)) {
      if (meta)
        throw new Error(`Duplicate modifier in shortcut: ${spec.chord}`);
      meta = true;
    } else if (ALT_ALIASES.has(lower)) {
      if (alt) throw new Error(`Duplicate modifier in shortcut: ${spec.chord}`);
      alt = true;
    } else if (lower === "shift") {
      if (shift)
        throw new Error(`Duplicate modifier in shortcut: ${spec.chord}`);
      shift = true;
    } else if (key === undefined) {
      key = spec.match === "code" ? normalizeCode(token) : normalizeKey(token);
    } else {
      throw new Error(`Shortcut must contain exactly one key: ${spec.chord}`);
    }
  }

  if (key === undefined) {
    throw new Error(`Shortcut must contain a non-modifier key: ${spec.chord}`);
  }
  if (
    (spec.match === "code" && !VALID_CODE.test(key)) ||
    (spec.match !== "code" && key.length !== 1 && !VALID_NAMED_KEYS.has(key))
  ) {
    throw new Error(`Unknown key in shortcut: ${spec.chord}`);
  }

  return {
    chord: spec.chord,
    key,
    mod,
    control,
    meta,
    alt,
    shift,
    match: spec.match ?? "key",
  };
};

export const shortcutApplies = (
  spec: ShortcutSpec,
  platform: CommandPlatform,
  runtime: CommandRuntime,
): boolean =>
  (spec.platforms === undefined || spec.platforms.includes(platform)) &&
  (spec.runtimes === undefined || spec.runtimes.includes(runtime));

export const isCharacterOnlyShortcut = (shortcut: ParsedShortcut): boolean =>
  shortcut.key.length === 1 &&
  !shortcut.mod &&
  !shortcut.control &&
  !shortcut.meta &&
  !shortcut.alt;

const expectedModifiers = (
  shortcut: ParsedShortcut,
  platform: CommandPlatform,
): { control: boolean; meta: boolean; alt: boolean; shift: boolean } => ({
  control: shortcut.control || (shortcut.mod && platform !== "macos"),
  meta: shortcut.meta || (shortcut.mod && platform === "macos"),
  alt: shortcut.alt,
  shift: shortcut.shift,
});

export const eventMatchesShortcut = (
  event: Pick<
    KeyboardEvent,
    | "key"
    | "code"
    | "ctrlKey"
    | "metaKey"
    | "altKey"
    | "shiftKey"
    | "repeat"
    | "isComposing"
    | "keyCode"
    | "getModifierState"
  >,
  spec: ShortcutSpec,
  platform: CommandPlatform,
  runtime: CommandRuntime,
): boolean => {
  if (!shortcutApplies(spec, platform, runtime)) return false;
  if (event.repeat && spec.allowRepeat !== true) return false;
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    event.key === "Dead" ||
    event.key === "Process" ||
    event.key === "Unidentified"
  ) {
    return false;
  }
  if (event.getModifierState?.("AltGraph")) return false;

  const shortcut = parseShortcut(spec);
  const expected = expectedModifiers(shortcut, platform);
  if (
    event.ctrlKey !== expected.control ||
    event.metaKey !== expected.meta ||
    event.altKey !== expected.alt ||
    event.shiftKey !== expected.shift
  ) {
    return false;
  }

  const eventKey =
    shortcut.match === "code"
      ? normalizeCode(event.code)
      : normalizeKey(event.key);
  return eventKey === shortcut.key;
};

const concreteModifiers = (
  shortcut: ParsedShortcut,
  platform: CommandPlatform,
): readonly string[] => {
  const expected = expectedModifiers(shortcut, platform);
  if (platform === "macos") {
    return [
      ...(expected.control ? ["⌃"] : []),
      ...(expected.alt ? ["⌥"] : []),
      ...(expected.shift ? ["⇧"] : []),
      ...(expected.meta ? ["⌘"] : []),
    ];
  }
  return [
    ...(expected.control ? ["Ctrl"] : []),
    ...(expected.alt ? ["Alt"] : []),
    ...(expected.shift ? ["Shift"] : []),
    ...(expected.meta ? ["Meta"] : []),
  ];
};

export const formatShortcut = (
  shortcut: ShortcutSpec | string,
  platform: CommandPlatform,
): string => {
  const parsed = parseShortcut(shortcut);
  const codeKey =
    parsed.key.match(/^key([a-z])$/)?.[1] ??
    parsed.key.match(/^digit([0-9])$/)?.[1];
  const key =
    codeKey?.toLocaleUpperCase("en-US") ??
    DISPLAY_KEYS[parsed.key] ??
    (parsed.key.length === 1
      ? parsed.key.toLocaleUpperCase("en-US")
      : /^f\d{1,2}$/.test(parsed.key)
        ? parsed.key.toLocaleUpperCase("en-US")
        : parsed.key);
  const parts = [...concreteModifiers(parsed, platform), key];
  return platform === "macos" ? parts.join("") : parts.join("+");
};

export const shortcutToAriaKeyShortcuts = (
  shortcut: ShortcutSpec | string,
  platform: CommandPlatform,
): string => {
  const parsed = parseShortcut(shortcut);
  const expected = expectedModifiers(parsed, platform);
  const codeKey =
    parsed.key.match(/^key([a-z])$/)?.[1] ??
    parsed.key.match(/^digit([0-9])$/)?.[1];
  const parts = [
    ...(expected.control ? ["Control"] : []),
    ...(expected.alt ? ["Alt"] : []),
    ...(expected.shift ? ["Shift"] : []),
    ...(expected.meta ? ["Meta"] : []),
    codeKey?.toLocaleUpperCase("en-US") ??
      ARIA_KEYS[parsed.key] ??
      (parsed.key.length === 1
        ? parsed.key.toLocaleUpperCase("en-US")
        : /^f\d{1,2}$/.test(parsed.key)
          ? parsed.key.toLocaleUpperCase("en-US")
          : parsed.key),
  ];
  return parts.join("+");
};

export const canonicalShortcut = (
  shortcut: ShortcutSpec | string,
  platform: CommandPlatform,
): string =>
  shortcutToAriaKeyShortcuts(shortcut, platform).toLocaleLowerCase("en-US");
