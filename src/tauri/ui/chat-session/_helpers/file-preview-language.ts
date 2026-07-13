export type FilePreviewLanguage =
  | "bash"
  | "cpp"
  | "csharp"
  | "css"
  | "diff"
  | "dockerfile"
  | "go"
  | "graphql"
  | "ini"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "less"
  | "makefile"
  | "markdown"
  | "php"
  | "powershell"
  | "properties"
  | "python"
  | "ruby"
  | "rust"
  | "scss"
  | "sql"
  | "swift"
  | "toml"
  | "typescript"
  | "xml"
  | "yaml";

export interface FilePreviewSyntax {
  language: FilePreviewLanguage | null;
  label: string;
}

export type FilePreviewRenderKind = "image" | "pdf" | "text";

const FILE_NAME_LANGUAGE_MAP = {
  agents: "markdown",
  containerfile: "dockerfile",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  makefile: "makefile",
  procfile: "bash",
  rakefile: "ruby",
  readme: "markdown",
} as const satisfies Record<string, FilePreviewLanguage>;

const FILE_EXTENSION_LANGUAGE_MAP = {
  bat: "bash",
  c: "cpp",
  cc: "cpp",
  cfg: "ini",
  cmd: "bash",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  diff: "diff",
  dockerfile: "dockerfile",
  env: "properties",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  hxx: "cpp",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  mjs: "javascript",
  md: "markdown",
  mdx: "markdown",
  mts: "typescript",
  patch: "diff",
  php: "php",
  properties: "properties",
  ps1: "powershell",
  py: "python",
  pyw: "python",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
} as const satisfies Record<string, FilePreviewLanguage>;

const PLAIN_TEXT_EXTENSION_SET = new Set([
  "csv",
  "log",
  "text",
  "tsv",
  "txt",
]);

const IMAGE_EXTENSION_SET = new Set(["bmp", "gif", "jpeg", "jpg", "png", "webp"]);

const LANGUAGE_LABELS = {
  bash: "Shell",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Dockerfile",
  go: "Go",
  graphql: "GraphQL",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  makefile: "Makefile",
  markdown: "Markdown",
  php: "PHP",
  powershell: "PowerShell",
  properties: "Properties",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
} as const satisfies Record<FilePreviewLanguage, string>;

export const FILE_PREVIEW_SYNTAX_OPTIONS = [
  { language: null, label: "Plain text" },
  { language: "bash", label: LANGUAGE_LABELS.bash },
  { language: "cpp", label: LANGUAGE_LABELS.cpp },
  { language: "csharp", label: LANGUAGE_LABELS.csharp },
  { language: "css", label: LANGUAGE_LABELS.css },
  { language: "diff", label: LANGUAGE_LABELS.diff },
  { language: "dockerfile", label: LANGUAGE_LABELS.dockerfile },
  { language: "go", label: LANGUAGE_LABELS.go },
  { language: "graphql", label: LANGUAGE_LABELS.graphql },
  { language: "ini", label: LANGUAGE_LABELS.ini },
  { language: "java", label: LANGUAGE_LABELS.java },
  { language: "javascript", label: LANGUAGE_LABELS.javascript },
  { language: "json", label: LANGUAGE_LABELS.json },
  { language: "kotlin", label: LANGUAGE_LABELS.kotlin },
  { language: "less", label: LANGUAGE_LABELS.less },
  { language: "makefile", label: LANGUAGE_LABELS.makefile },
  { language: "markdown", label: LANGUAGE_LABELS.markdown },
  { language: "php", label: LANGUAGE_LABELS.php },
  { language: "powershell", label: LANGUAGE_LABELS.powershell },
  { language: "properties", label: LANGUAGE_LABELS.properties },
  { language: "python", label: LANGUAGE_LABELS.python },
  { language: "ruby", label: LANGUAGE_LABELS.ruby },
  { language: "rust", label: LANGUAGE_LABELS.rust },
  { language: "scss", label: LANGUAGE_LABELS.scss },
  { language: "sql", label: LANGUAGE_LABELS.sql },
  { language: "swift", label: LANGUAGE_LABELS.swift },
  { language: "toml", label: LANGUAGE_LABELS.toml },
  { language: "typescript", label: LANGUAGE_LABELS.typescript },
  { language: "xml", label: LANGUAGE_LABELS.xml },
  { language: "yaml", label: LANGUAGE_LABELS.yaml },
] as const satisfies readonly FilePreviewSyntax[];

const hasOwnProperty = <T extends object>(
  value: T,
  key: PropertyKey,
): key is keyof T => Object.prototype.hasOwnProperty.call(value, key);

const getMappedLanguage = <T extends Partial<Record<string, FilePreviewLanguage>>>(
  map: T,
  key: string,
): FilePreviewLanguage | undefined =>
  hasOwnProperty(map, key) ? map[key] : undefined;

export const getFilePreviewFileName = (path: string): string => {
  const normalizedPath = path.trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
  const lastSeparatorIndex = normalizedPath.lastIndexOf("/");

  return lastSeparatorIndex >= 0
    ? normalizedPath.slice(lastSeparatorIndex + 1)
    : normalizedPath;
};

const getFileExtension = (fileName: string): string | null => {
  const extensionSeparatorIndex = fileName.lastIndexOf(".");

  if (
    extensionSeparatorIndex <= 0 ||
    extensionSeparatorIndex === fileName.length - 1
  ) {
    return null;
  }

  return fileName.slice(extensionSeparatorIndex + 1).toLowerCase();
};

export const getFilePreviewRenderKind = (
  fileNameOrPath: string,
): FilePreviewRenderKind => {
  const fileName = getFilePreviewFileName(fileNameOrPath);
  const extension = getFileExtension(fileName);

  if (extension && IMAGE_EXTENSION_SET.has(extension)) {
    return "image";
  }

  return extension === "pdf" ? "pdf" : "text";
};

export const resolveFilePreviewSyntax = (
  fileNameOrPath: string,
): FilePreviewSyntax => {
  const fileName = getFilePreviewFileName(fileNameOrPath);
  const lowerFileName = fileName.toLowerCase();

  if (/^\.env(?:\.|$)/u.test(lowerFileName)) {
    return { language: "properties", label: LANGUAGE_LABELS.properties };
  }

  if (/^(?:containerfile|dockerfile)(?:\.|$)/u.test(lowerFileName)) {
    return { language: "dockerfile", label: LANGUAGE_LABELS.dockerfile };
  }

  if (/^makefile(?:\.|$)/u.test(lowerFileName)) {
    return { language: "makefile", label: LANGUAGE_LABELS.makefile };
  }

  const exactLanguage = getMappedLanguage(FILE_NAME_LANGUAGE_MAP, lowerFileName);

  if (exactLanguage) {
    return {
      language: exactLanguage,
      label: LANGUAGE_LABELS[exactLanguage],
    };
  }

  const extension = getFileExtension(fileName);

  if (!extension || PLAIN_TEXT_EXTENSION_SET.has(extension)) {
    return { language: null, label: "Plain text" };
  }

  const extensionLanguage = getMappedLanguage(
    FILE_EXTENSION_LANGUAGE_MAP,
    extension,
  );

  if (!extensionLanguage) {
    return { language: null, label: "Plain text" };
  }

  return {
    language: extensionLanguage,
    label: LANGUAGE_LABELS[extensionLanguage],
  };
};
