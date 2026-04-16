import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { sortEntryNames } from "../../common/_helpers/sort-entry-names.js";
import { createTextSection, limitText } from "./runtime-text.js";
import {
  MAX_DIRECTORY_ENTRIES,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_BYTES,
  coerceBoolean,
  coerceInteger,
  coerceString,
  createSearchScope,
  createToolErrorResult,
  isBinaryBuffer,
  normalizeWorkspacePath,
  resolveWorkspaceTarget,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";

export const createFilesystemToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
      spec: {
        name: "list_directory",
        description:
          "List files and folders within a workspace-relative directory. Use this to explore the project before reading or editing files.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description:
                "Workspace-relative path to the directory to inspect. Use '.' for the workspace root.",
            },
            maxEntries: {
              type: "integer",
              minimum: 1,
              maximum: MAX_DIRECTORY_ENTRIES,
              description: "Maximum number of entries to return.",
            },
          },
          required: ["path", "maxEntries"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const maxEntries = coerceInteger(args, "maxEntries");

        if (!requestedPath || maxEntries === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "list_directory",
            "Expected a string `path` and integer `maxEntries`.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "list_directory",
            `Refusing to inspect \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        try {
          const targetStats = await stat(target.resolvedPath);

          if (!targetStats.isDirectory()) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "list_directory",
              `The path \`${requestedPath}\` is not a directory.`,
            );
          }

          const entries = await readdir(target.resolvedPath, {
            withFileTypes: true,
          });
          const ordered = entries.sort((left, right) => {
            const leftKind = left.isDirectory() ? 0 : 1;
            const rightKind = right.isDirectory() ? 0 : 1;

            if (leftKind !== rightKind) {
              return leftKind - rightKind;
            }

            return sortEntryNames(left.name, right.name);
          });
          const lines = ordered.slice(0, maxEntries).map((entry) => {
            const kind = entry.isDirectory() ? "dir" : "file";
            return `${kind}: ${entry.name}`;
          });

          if (ordered.length > maxEntries) {
            lines.push(
              `… truncated after ${maxEntries} of ${ordered.length} entries`,
            );
          }

          const output = [
            `Directory: ${target.workspacePath || "."}`,
            ...lines,
          ].join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "list_directory",
              output,
            },
            sections: [
              {
                title: "Directory target",
                lines: [
                  `requested: ${requestedPath}`,
                  `workspace path: ${target.workspacePath || "."}`,
                ],
              },
              {
                title: "Directory entries",
                lines: lines.length > 0 ? lines : ["Directory is empty."],
              },
            ],
            traceLines: [
              `list_directory(${target.workspacePath || "."}) -> ${Math.min(ordered.length, maxEntries)} entr${Math.min(ordered.length, maxEntries) === 1 ? "y" : "ies"}`,
            ],
          };
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "list_directory",
            `The directory \`${requestedPath}\` could not be read from the workspace.`,
          );
        }
      },
    },
    {
      spec: {
        name: "read_file",
        description:
          "Read a workspace file with 1-based line numbers. Use this before editing an existing file.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path to the file to read.",
            },
            startLine: {
              type: "integer",
              minimum: 1,
              description: "1-based starting line number.",
            },
            endLine: {
              type: "integer",
              minimum: 1,
              description: "1-based ending line number.",
            },
          },
          required: ["path", "startLine", "endLine"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const startLine = coerceInteger(args, "startLine");
        const endLine = coerceInteger(args, "endLine");

        if (
          !requestedPath ||
          startLine === undefined ||
          endLine === undefined
        ) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_file",
            "Expected `path`, `startLine`, and `endLine`.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_file",
            `Refusing to read \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        try {
          const targetStats = await stat(target.resolvedPath);

          if (!targetStats.isFile()) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "read_file",
              `The path \`${requestedPath}\` is not a regular file.`,
            );
          }

          if (targetStats.size > MAX_TEXT_FILE_BYTES) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "read_file",
              `The file \`${requestedPath}\` is too large for a safe inline preview.`,
            );
          }

          const raw = await readFile(target.resolvedPath);

          if (isBinaryBuffer(raw)) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "read_file",
              `The file \`${requestedPath}\` appears to be binary.`,
            );
          }

          const text = raw
            .toString("utf8")
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
          const allLines = text.split("\n");
          const safeStartLine = Math.max(1, startLine);
          const safeEndLine = Math.max(safeStartLine, endLine);
          const slice = allLines.slice(safeStartLine - 1, safeEndLine);
          const preview = slice
            .map((line, index) => `${safeStartLine + index}: ${line}`)
            .join("\n");
          const output = [
            `File: ${target.workspacePath ?? requestedPath}`,
            `Selected lines: ${safeStartLine}-${Math.min(safeEndLine, allLines.length)}`,
            preview,
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "read_file",
              output: limitText(output),
            },
            sections: [
              {
                title: "File target",
                lines: [
                  `requested: ${requestedPath}`,
                  `workspace path: ${target.workspacePath ?? requestedPath}`,
                  `selected lines: ${safeStartLine}-${Math.min(safeEndLine, allLines.length)}`,
                ],
              },
              createTextSection(
                "File preview",
                slice.join("\n"),
                80,
                safeStartLine,
              ),
            ],
            traceLines: [
              `read_file(${target.workspacePath ?? requestedPath}, ${safeStartLine}-${Math.min(safeEndLine, allLines.length)})`,
            ],
          };
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "read_file",
            `The file \`${requestedPath}\` could not be read from the workspace.`,
          );
        }
      },
    },
    {
      spec: {
        name: "search_workspace",
        description:
          "Search text across workspace files and return matching file:line results. Use this to find symbols, strings, or configuration references.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description: "Plain text or regex pattern to search for.",
            },
            isRegex: {
              type: "boolean",
              description:
                "Whether `query` should be interpreted as a regular expression.",
            },
            maxResults: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_RESULTS,
              description: "Maximum number of matches to return.",
            },
          },
          required: ["query", "isRegex", "maxResults"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const query = coerceString(args, "query");
        const isRegex = coerceBoolean(args, "isRegex");
        const maxResults = coerceInteger(args, "maxResults");

        if (!query || isRegex === undefined || maxResults === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "search_workspace",
            "Expected `query`, `isRegex`, and `maxResults`.",
          );
        }

        let matcher: RegExp;

        try {
          matcher = isRegex
            ? new RegExp(query, "iu")
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "search_workspace",
            error instanceof Error
              ? `Invalid search pattern: ${error.message}`
              : "Invalid search pattern.",
          );
        }

        const files = await createSearchScope(context.workspaceRoot, []);
        const results: string[] = [];

        for (const filePath of files) {
          if (results.length >= maxResults) {
            break;
          }

          try {
            const fileStats = await stat(filePath);

            if (!fileStats.isFile() || fileStats.size > MAX_TEXT_FILE_BYTES) {
              continue;
            }

            const raw = await readFile(filePath);

            if (isBinaryBuffer(raw)) {
              continue;
            }

            const content = raw
              .toString("utf8")
              .replace(/\r\n/g, "\n")
              .replace(/\r/g, "\n");
            const lines = content.split("\n");
            const workspacePath = normalizeWorkspacePath(
              relative(context.workspaceRoot, filePath),
            );

            for (const [index, line] of lines.entries()) {
              if (!matcher.test(line)) {
                continue;
              }

              results.push(`${workspacePath}:${index + 1}: ${line}`);

              if (results.length >= maxResults) {
                break;
              }
            }
          } catch {
            continue;
          }
        }

        const output =
          results.length > 0
            ? [`Matches for ${query}:`, ...results].join("\n")
            : `No matches found for ${query}.`;

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "search_workspace",
            output: limitText(output),
          },
          sections: [
            {
              title: "Search results",
              lines: results.length > 0 ? results : ["No matches found."],
            },
          ],
          traceLines: [
            `search_workspace(${query}, regex=${isRegex ? "true" : "false"}) -> ${results.length} match${results.length === 1 ? "" : "es"}`,
          ],
        };
      },
    },
    {
      spec: {
        name: "create_file",
        description:
          "Create a brand-new workspace file. Use this only when the file does not already exist.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path of the new file.",
            },
            content: {
              type: "string",
              description: "Full file contents to write.",
            },
          },
          required: ["path", "content"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const content =
          typeof args.content === "string" ? args.content : undefined;

        if (!requestedPath || content === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_file",
            "Expected `path` and `content`.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_file",
            `Refusing to create \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        if (existsSync(target.resolvedPath)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_file",
            `The path \`${requestedPath}\` already exists. Use replace_in_file for edits instead.`,
          );
        }

        await mkdir(dirname(target.resolvedPath), { recursive: true });
        await writeFile(target.resolvedPath, content, "utf8");

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "create_file",
            output: `Created ${target.workspacePath ?? requestedPath}.`,
          },
          sections: [
            {
              title: "File target",
              lines: [
                `requested: ${requestedPath}`,
                `workspace path: ${target.workspacePath ?? requestedPath}`,
              ],
            },
            createTextSection("File preview", content),
          ],
          traceLines: [`create_file(${target.workspacePath ?? requestedPath})`],
        };
      },
    },
    {
      spec: {
        name: "replace_in_file",
        description:
          "Replace exact text in an existing workspace file. Use this for targeted edits after reading the file first.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path of the file to edit.",
            },
            oldText: {
              type: "string",
              description: "Exact existing text to replace.",
            },
            newText: {
              type: "string",
              description: "Replacement text.",
            },
            replaceAll: {
              type: "boolean",
              description:
                "Whether to replace every exact occurrence instead of only one.",
            },
          },
          required: ["path", "oldText", "newText", "replaceAll"],
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      execute: async (args, context) => {
        const requestedPath = coerceString(args, "path");
        const oldText =
          typeof args.oldText === "string" ? args.oldText : undefined;
        const newText =
          typeof args.newText === "string" ? args.newText : undefined;
        const replaceAll = coerceBoolean(args, "replaceAll");

        if (
          !requestedPath ||
          oldText === undefined ||
          newText === undefined ||
          replaceAll === undefined
        ) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            "Expected `path`, `oldText`, `newText`, and `replaceAll`.",
          );
        }

        if (oldText.length === 0) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            "`oldText` must not be empty.",
          );
        }

        const target = resolveWorkspaceTarget(
          context.workspaceRoot,
          requestedPath,
        );

        if (!target.insideWorkspace) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            `Refusing to edit \`${requestedPath}\` because it resolves outside the workspace.`,
          );
        }

        try {
          const raw = await readFile(target.resolvedPath);

          if (isBinaryBuffer(raw)) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "replace_in_file",
              `The file \`${requestedPath}\` appears to be binary and cannot be edited safely.`,
            );
          }

          const original = raw.toString("utf8");
          const candidates = [
            {
              match: oldText,
              replacement: newText,
            },
            ...(oldText.includes("\n")
              ? [
                  {
                    match: oldText.replace(/\n/g, "\r\n"),
                    replacement: newText.replace(/\n/g, "\r\n"),
                  },
                ]
              : []),
          ];
          const selectedCandidate = candidates.find(({ match }) =>
            original.includes(match),
          );

          if (!selectedCandidate) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "replace_in_file",
              `The exact text to replace was not found in \`${requestedPath}\`.`,
            );
          }

          const matchCount = original.split(selectedCandidate.match).length - 1;

          if (matchCount > 1 && !replaceAll) {
            return createToolErrorResult(
              crypto.randomUUID(),
              "replace_in_file",
              `Found ${matchCount} matching occurrences in \`${requestedPath}\`; provide more precise text or set replaceAll=true.`,
            );
          }

          const updated = replaceAll
            ? original
                .split(selectedCandidate.match)
                .join(selectedCandidate.replacement)
            : original.replace(
                selectedCandidate.match,
                selectedCandidate.replacement,
              );

          await writeFile(target.resolvedPath, updated, "utf8");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "replace_in_file",
              output: `Updated ${target.workspacePath ?? requestedPath} by replacing ${replaceAll ? `${matchCount} occurrences` : "1 occurrence"}.`,
            },
            sections: [
              {
                title: "Edited file",
                lines: [
                  `requested: ${requestedPath}`,
                  `workspace path: ${target.workspacePath ?? requestedPath}`,
                  `replacement count: ${replaceAll ? matchCount : 1}`,
                ],
              },
              createTextSection("Updated file preview", updated),
            ],
            traceLines: [
              `replace_in_file(${target.workspacePath ?? requestedPath}) -> ${replaceAll ? `${matchCount} replacements` : "1 replacement"}`,
            ],
          };
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "replace_in_file",
            `The file \`${requestedPath}\` could not be edited.`,
          );
        }
      },
    },
  ];
};
