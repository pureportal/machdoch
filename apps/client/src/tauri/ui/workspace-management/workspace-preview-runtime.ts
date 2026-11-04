import type {
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryPage,
  WorkspaceEntryKind,
  WorkspaceFileDocument,
  WorkspaceFileKind,
  WorkspaceFilePreviewKind,
  WorkspaceFileSaveResult,
  WorkspaceShellDiscovery,
  WorkspaceTerminalEvent,
  WorkspaceTerminalStarted,
} from "../runtime";

interface PreviewFile {
  content: string;
  language: string | null;
  revision: string;
  modifiedAt: number;
  bom?: boolean;
  editable?: boolean;
  kind?: WorkspaceFileKind;
  previewKind?: WorkspaceFilePreviewKind;
  reason?: string;
  size?: number;
}

interface PreviewTerminalSession {
  sessionId: string;
  workspaceRoot: string;
  shellId: string;
  onEvent: (event: WorkspaceTerminalEvent) => void;
  stopped: boolean;
}

const previewDirectories = new Set([
  ".",
  ".machdoch",
  "assets",
  "assets/branding",
  "docs",
  "src",
  "src/tauri",
  "src/tauri/ui",
]);

let previewRevision = 4;
const previewFiles = new Map<string, PreviewFile>([
  [
    "assets/branding/machdoch.svg",
    {
      content: [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">',
        '  <rect width="320" height="180" rx="24" fill="#07111f"/>',
        '  <path d="M92 54h136v72H92z" fill="none" stroke="#38bdf8" stroke-width="8"/>',
        '  <path d="m122 82 25 18-25 18M165 118h34" fill="none" stroke="#e2e8f0" stroke-linecap="round" stroke-linejoin="round" stroke-width="8"/>',
        "</svg>",
      ].join("\n"),
      language: "xml",
      previewKind: "image",
      revision: "preview-svg",
      modifiedAt: Date.now() - 75_000,
    },
  ],
  [
    "assets/sample.bin",
    {
      content: "",
      language: "text",
      revision: "preview-binary",
      modifiedAt: Date.now() - 95_000,
      editable: false,
      kind: "binary",
      reason: "This binary file cannot be edited here.",
      size: 4096,
    },
  ],
  [
    "assets/tone.wav",
    {
      content: "",
      language: null,
      revision: "preview-audio",
      modifiedAt: Date.now() - 90_000,
      editable: false,
      kind: "media",
      previewKind: "audio",
      size: 44,
    },
  ],
  [
    "assets/clip.webm",
    {
      content: "",
      language: null,
      revision: "preview-video",
      modifiedAt: Date.now() - 91_000,
      editable: false,
      kind: "media",
      previewKind: "video",
      size: 12,
    },
  ],
  [
    "docs/build-output.log",
    {
      content: "",
      language: "text",
      revision: "preview-oversized",
      modifiedAt: Date.now() - 105_000,
      editable: false,
      kind: "oversized",
      reason: "Files larger than 1 MB open in the system editor.",
      size: 1_572_864,
    },
  ],
  [
    "docs/sample.pdf",
    {
      content: "",
      language: null,
      revision: "preview-pdf",
      modifiedAt: Date.now() - 92_000,
      editable: false,
      kind: "media",
      previewKind: "pdf",
      size: 582,
    },
  ],
  [
    ".gitignore",
    {
      content: "node_modules/\ndist/\ntarget/\n.env\n",
      language: "text",
      revision: "preview-1",
      modifiedAt: Date.now() - 86_400_000,
    },
  ],
  [
    "README.md",
    {
      content: [
        "# Machdoch",
        "",
        "Local-first OS AI agent for CLI and desktop.",
        "",
        "## Development",
        "",
        "```sh",
        "pnpm install",
        "pnpm tauri:dev",
        "```",
      ].join("\n"),
      language: "markdown",
      revision: "preview-2",
      modifiedAt: Date.now() - 42_000,
    },
  ],
  [
    "package.json",
    {
      content: JSON.stringify(
        {
          name: "machdoch",
          version: "0.45.0",
          private: true,
          scripts: {
            verify: "pnpm check && pnpm typecheck && pnpm test",
            "tauri:dev": "tauri dev",
          },
        },
        null,
        2,
      ),
      language: "json",
      revision: "preview-3",
      modifiedAt: Date.now() - 120_000,
    },
  ],
  [
    "docs/workspace-management-tools-spec.md",
    {
      content:
        "# Workspace files and terminal\n\nThe selected workspace combines a lazy file tree, editor, preview, and terminal.\n",
      language: "markdown",
      revision: "preview-4",
      modifiedAt: Date.now() - 20_000,
    },
  ],
]);

const previewTerminals = new Map<string, PreviewTerminalSession>();
let previewTerminalId = 0;

const normalizePath = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized === "" || normalized === "." ? "." : normalized;
};

const parentPath = (value: string): string => {
  const normalized = normalizePath(value);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "." : normalized.slice(0, separator);
};

const baseName = (value: string): string => {
  const normalized = normalizePath(value);
  return normalized.split("/").at(-1) ?? normalized;
};

const joinPath = (parent: string, name: string): string =>
  normalizePath(parent) === "." ? name : `${normalizePath(parent)}/${name}`;

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const encodeOutput = (value: string): string => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const emitOutput = (session: PreviewTerminalSession, output: string): void => {
  if (!session.stopped) {
    session.onEvent({
      type: "output",
      sessionId: session.sessionId,
      data: encodeOutput(output),
    });
  }
};

export const listPreviewWorkspaceDirectory = (
  relativePath: string,
  offset: number,
): WorkspaceDirectoryPage => {
  const directory = normalizePath(relativePath);
  if (!previewDirectories.has(directory)) {
    throw new Error("This folder is no longer available.");
  }
  const entries: WorkspaceDirectoryEntry[] = [];
  for (const path of previewDirectories) {
    if (path !== "." && parentPath(path) === directory) {
      entries.push({
        name: baseName(path),
        path,
        kind: "directory",
        targetKind: null,
        size: null,
        modifiedAt: Date.now() - 60_000,
      });
    }
  }
  for (const [path, file] of previewFiles) {
    if (parentPath(path) === directory) {
      entries.push({
        name: baseName(path),
        path,
        kind: "file",
        targetKind: null,
        size: file.size ?? byteLength(file.content),
        modifiedAt: file.modifiedAt,
      });
    }
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
  const page = entries.slice(offset, offset + 400);
  const nextOffset = offset + page.length;
  return {
    path: directory,
    entries: page,
    nextOffset: nextOffset < entries.length ? nextOffset : null,
    totalEntries: entries.length,
    limitReached: false,
    omittedEntries: 0,
  };
};

export const readPreviewWorkspaceFile = (
  relativePath: string,
): WorkspaceFileDocument => {
  const path = normalizePath(relativePath);
  const file = previewFiles.get(path);
  if (!file) throw new Error("This file is no longer available.");
  const kind = file.kind ?? "text";
  const editable = file.editable ?? kind === "text";
  return {
    path,
    name: baseName(path),
    size: file.size ?? byteLength(file.content),
    modifiedAt: file.modifiedAt,
    revision: editable ? file.revision : null,
    kind,
    previewKind:
      file.previewKind ?? (file.language === "markdown" ? "markdown" : null),
    language: kind === "binary" ? null : file.language,
    content: editable ? file.content : null,
    editable,
    bom: file.bom ?? false,
    reason: file.reason ?? null,
  };
};

export const resolvePreviewWorkspaceFileSource = (
  relativePath: string,
): string => {
  const path = normalizePath(relativePath);
  const file = previewFiles.get(path);
  if (!file?.previewKind) {
    throw new Error("This file cannot be previewed here.");
  }
  if (file.previewKind === "image" && file.language === "xml") {
    return `data:image/svg+xml;base64,${encodeOutput(file.content)}`;
  }
  if (file.previewKind === "pdf") {
    const pdf = [
      "%PDF-1.1",
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 240 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
      "4 0 obj<</Length 45>>stream",
      "BT /F1 18 Tf 48 80 Td (Machdoch preview) Tj ET",
      "endstream endobj",
      "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
      "trailer<</Root 1 0 R>>",
      "%%EOF",
    ].join("\n");
    return `data:application/pdf;base64,${encodeOutput(pdf)}`;
  }
  if (file.previewKind === "audio") {
    return "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
  }
  if (file.previewKind === "video") {
    return "data:video/webm;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
  }
  throw new Error("This preview is only available in the desktop app.");
};

export const savePreviewWorkspaceFile = (
  relativePath: string,
  content: string,
  expectedRevision: string,
  force: boolean,
  bom: boolean,
): WorkspaceFileSaveResult => {
  const path = normalizePath(relativePath);
  const file = previewFiles.get(path);
  if (!file) throw new Error("This file is no longer available.");
  if (file.editable === false || (file.kind ?? "text") !== "text") {
    throw new Error("This file cannot be edited here.");
  }
  if (!force && file.revision !== expectedRevision) {
    return {
      status: "conflict",
      revision: file.revision,
      modifiedAt: file.modifiedAt,
      size: byteLength(file.content),
    };
  }
  previewRevision += 1;
  file.content = content;
  file.revision = `preview-${previewRevision}`;
  file.modifiedAt = Date.now();
  file.bom = bom;
  return {
    status: "saved",
    revision: file.revision,
    modifiedAt: file.modifiedAt,
    size: byteLength(file.content),
  };
};

export const createPreviewWorkspaceEntry = (
  parent: string,
  name: string,
  kind: WorkspaceEntryKind,
): string => {
  const path = joinPath(parent, name);
  if (previewDirectories.has(path) || previewFiles.has(path)) {
    throw new Error("An entry with that name already exists.");
  }
  if (kind === "directory") previewDirectories.add(path);
  else {
    previewRevision += 1;
    previewFiles.set(path, {
      content: "",
      language: "text",
      revision: `preview-${previewRevision}`,
      modifiedAt: Date.now(),
    });
  }
  return path;
};

export const renamePreviewWorkspaceEntry = (
  relativePath: string,
  name: string,
): string => {
  const source = normalizePath(relativePath);
  const destination = joinPath(parentPath(source), name);
  if (previewDirectories.has(destination) || previewFiles.has(destination)) {
    throw new Error("An entry with that name already exists.");
  }
  if (previewFiles.has(source)) {
    const file = previewFiles.get(source);
    previewFiles.delete(source);
    if (file) previewFiles.set(destination, file);
    return destination;
  }
  if (!previewDirectories.has(source)) {
    throw new Error("This entry is no longer available.");
  }
  const directories = [...previewDirectories].filter(
    (path) => path === source || path.startsWith(`${source}/`),
  );
  const files = [...previewFiles.entries()].filter(([path]) =>
    path.startsWith(`${source}/`),
  );
  for (const path of directories) previewDirectories.delete(path);
  for (const [path] of files) previewFiles.delete(path);
  for (const path of directories) {
    previewDirectories.add(destination + path.slice(source.length));
  }
  for (const [path, file] of files) {
    previewFiles.set(destination + path.slice(source.length), file);
  }
  return destination;
};

export const deletePreviewWorkspaceEntry = (relativePath: string): void => {
  const path = normalizePath(relativePath);
  if (previewFiles.delete(path)) return;
  if (!previewDirectories.has(path)) {
    throw new Error("This entry is no longer available.");
  }
  for (const directory of [...previewDirectories]) {
    if (directory === path || directory.startsWith(`${path}/`)) {
      previewDirectories.delete(directory);
    }
  }
  for (const file of [...previewFiles.keys()]) {
    if (file.startsWith(`${path}/`)) previewFiles.delete(file);
  }
};

export const discoverPreviewWorkspaceShells = (): WorkspaceShellDiscovery => ({
  platform: "windows",
  shells: [
    { id: "pwsh", label: "PowerShell", kind: "powershell" },
    { id: "cmd", label: "Command Prompt", kind: "cmd" },
  ],
  defaultShellId: "pwsh",
  externalTerminal: { id: "windows-terminal", label: "Windows Terminal" },
});

export const startPreviewWorkspaceTerminal = (
  workspaceRoot: string,
  shellId: string,
  onEvent: (event: WorkspaceTerminalEvent) => void,
): WorkspaceTerminalStarted => {
  previewTerminalId += 1;
  const sessionId = `preview-terminal-${previewTerminalId}`;
  const session: PreviewTerminalSession = {
    sessionId,
    workspaceRoot,
    shellId,
    onEvent,
    stopped: false,
  };
  previewTerminals.set(sessionId, session);
  window.setTimeout(() => {
    emitOutput(
      session,
      shellId === "cmd"
        ? "Microsoft Windows [Version 10.0.26100]\r\nC:\\Development\\machdoch>"
        : "PowerShell 7.6.0\r\nPS C:\\Development\\machdoch> ",
    );
  }, 20);
  return { sessionId, shellId, processId: null };
};

export const writePreviewWorkspaceTerminal = (
  sessionId: string,
  data: string,
): void => {
  const session = previewTerminals.get(sessionId);
  if (!session || session.stopped) {
    throw new Error("This terminal is no longer running.");
  }
  emitOutput(
    session,
    data.replaceAll(
      "\r",
      session.shellId === "cmd"
        ? "\r\nC:\\Development\\machdoch>"
        : "\r\nPS C:\\Development\\machdoch> ",
    ),
  );
};

export const stopPreviewWorkspaceTerminal = (sessionId: string): void => {
  const session = previewTerminals.get(sessionId);
  if (!session || session.stopped) return;
  session.stopped = true;
  session.onEvent({ type: "exit", exitCode: 0 });
  previewTerminals.delete(sessionId);
};

export const stopPreviewWorkspaceTerminals = (
  workspaceRoot: string,
): number => {
  const matchingIds = [...previewTerminals]
    .filter(([, session]) => session.workspaceRoot === workspaceRoot)
    .map(([sessionId]) => sessionId);
  for (const sessionId of matchingIds) {
    stopPreviewWorkspaceTerminal(sessionId);
  }
  return matchingIds.length;
};
