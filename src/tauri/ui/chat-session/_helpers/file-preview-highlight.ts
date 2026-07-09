import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import properties from "highlight.js/lib/languages/properties";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { FilePreviewLanguage } from "./file-preview-language";

const registeredLanguages = {
  bash,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  graphql,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  makefile,
  markdown,
  php,
  powershell,
  properties,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  toml: ini,
  typescript,
  xml,
  yaml,
} as const satisfies Record<FilePreviewLanguage, Parameters<typeof hljs.registerLanguage>[1]>;

for (const [language, definition] of Object.entries(registeredLanguages)) {
  hljs.registerLanguage(language, definition);
}

hljs.safeMode();

export const highlightFilePreviewContent = (
  content: string,
  language: FilePreviewLanguage | null,
): string | null => {
  if (!language || !hljs.getLanguage(language)) {
    return null;
  }

  try {
    return hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    }).value;
  } catch (error) {
    console.error("Failed to highlight file preview", error);
    return null;
  }
};
