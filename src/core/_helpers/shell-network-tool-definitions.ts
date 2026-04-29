import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { RuntimeConfig } from "../types.js";
import {
  executeWebSearch,
  getConfiguredWebSearchProvider,
} from "../web-search.js";
import {
  SHELL_TIMEOUT_MS,
  coerceInteger,
  coerceString,
  createToolErrorResult,
  stripHtmlToText,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
} from "./runtime-text.js";

const execFileAsync = promisify(execFile);

const WINDOWS_POWERSHELL_BOOTSTRAP_LINES = [
  "$PSDefaultParameterValues['Invoke-WebRequest:UseBasicParsing'] = $true",
  "$PSDefaultParameterValues['Invoke-RestMethod:UseBasicParsing'] = $true",
] as const;

export const resolveShellCommandInvocation = (
  command: string,
  platform: NodeJS.Platform = process.platform,
): {
  shellExecutable: string;
  shellArgs: string[];
} => {
  if (platform === "win32") {
    return {
      shellExecutable: "powershell.exe",
      shellArgs: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [...WINDOWS_POWERSHELL_BOOTSTRAP_LINES, command].join(";\n"),
      ],
    };
  }

  return {
    shellExecutable: "sh",
    shellArgs: ["-lc", command],
  };
};

export const startDetachedShellCommand = async (
  command: string,
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number | undefined> => {
  const { shellExecutable, shellArgs } = resolveShellCommandInvocation(
    command,
    platform,
  );
  const child = spawn(shellExecutable, shellArgs, {
    cwd: workspaceRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  const pid = await new Promise<number | undefined>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    child.once("spawn", () => {
      settle(() => {
        resolve(child.pid);
      });
    });
    child.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
  });

  child.unref();

  return pid;
};

export const createShellNetworkToolDefinitions = (
  config: RuntimeConfig,
): AgentToolDefinition[] => {
  const toolDefinitions: AgentToolDefinition[] = [
    {
      spec: {
        name: "run_shell_command",
        description:
          "Run a shell command inside the workspace. Use this only when filesystem tools are insufficient and you need real command output for verification, build/test steps, or other grounded runtime checks. Prefer focused, non-interactive commands with predictable output.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: {
              type: "string",
              description: "The shell command to run inside the workspace.",
            },
          },
          required: ["command"],
        },
      },
      backingTool: "shell",
      riskLevel: "high",
      execute: async (args, context) => {
        const command = coerceString(args, "command");

        if (!command) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "run_shell_command",
            "Expected a non-empty `command`.",
          );
        }

        const { shellExecutable, shellArgs } =
          resolveShellCommandInvocation(command);

        try {
          const { stdout, stderr } = await execFileAsync(
            shellExecutable,
            shellArgs,
            {
              cwd: context.workspaceRoot,
              timeout: SHELL_TIMEOUT_MS,
              maxBuffer: 1_000_000,
            },
          );
          const normalizedStdout = stdout.trim();
          const normalizedStderr = stderr.trim();
          const output = [
            `Command: ${command}`,
            `Exit code: 0`,
            normalizedStdout.length > 0
              ? `STDOUT:\n${normalizedStdout}`
              : undefined,
            normalizedStderr.length > 0
              ? `STDERR:\n${normalizedStderr}`
              : undefined,
          ]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "run_shell_command",
              output: limitText(output),
            },
            sections: [
              {
                title: "Shell command",
                lines: [`command: ${command}`, `cwd: ${context.workspaceRoot}`],
              },
              createTextSection(
                "Command output",
                [normalizedStdout, normalizedStderr]
                  .filter(Boolean)
                  .join("\n\n") || "(no output)",
              ),
            ],
            traceLines: [
              `run_shell_command(${compactTraceText(command)}) -> success`,
            ],
          };
        } catch (error) {
          const stdout =
            error instanceof Error &&
            "stdout" in error &&
            typeof error.stdout === "string"
              ? error.stdout.trim()
              : "";
          const stderr =
            error instanceof Error &&
            "stderr" in error &&
            typeof error.stderr === "string"
              ? error.stderr.trim()
              : error instanceof Error
                ? error.message
                : String(error);
          const exitCode =
            error instanceof Error &&
            "code" in error &&
            typeof error.code === "number"
              ? error.code
              : undefined;
          const output = [
            `Command: ${command}`,
            exitCode !== undefined ? `Exit code: ${exitCode}` : undefined,
            stdout.length > 0 ? `STDOUT:\n${stdout}` : undefined,
            stderr.length > 0 ? `STDERR:\n${stderr}` : undefined,
          ]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join("\n\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "run_shell_command",
              output: limitText(output),
              isError: true,
            },
            sections: [
              {
                title: "Shell command",
                lines: [`command: ${command}`, `cwd: ${context.workspaceRoot}`],
              },
              createTextSection(
                "Command output",
                [stdout, stderr].filter(Boolean).join("\n\n") || "(no output)",
              ),
            ],
            traceLines: [
              `run_shell_command(${compactTraceText(command)}) -> error`,
            ],
          };
        }
      },
    },
    {
      spec: {
        name: "start_detached_command",
        description:
          "Launch a GUI app, document, URL, or other command detached from machdoch so it can keep running after machdoch exits. Use this instead of run_shell_command when you do not need stdout or stderr.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            command: {
              type: "string",
              description:
                "The shell command to launch detached from the current machdoch process.",
            },
          },
          required: ["command"],
        },
      },
      backingTool: "shell",
      riskLevel: "high",
      execute: async (args, context) => {
        const command = coerceString(args, "command");

        if (!command) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "start_detached_command",
            "Expected a non-empty `command`.",
          );
        }

        try {
          const pid = await startDetachedShellCommand(
            command,
            context.workspaceRoot,
          );
          const output = [
            `Command: ${command}`,
            `Launch mode: detached`,
            `Workspace: ${context.workspaceRoot}`,
            pid !== undefined ? `PID: ${pid}` : undefined,
          ]
            .filter(
              (part): part is string =>
                typeof part === "string" && part.length > 0,
            )
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "start_detached_command",
              output: limitText(output),
            },
            sections: [
              {
                title: "Detached command",
                lines: [
                  `command: ${command}`,
                  `cwd: ${context.workspaceRoot}`,
                  `launch mode: detached from machdoch`,
                  ...(pid !== undefined ? [`pid: ${pid}`] : []),
                ],
              },
            ],
            traceLines: [
              `start_detached_command(${compactTraceText(command)}) -> launched`,
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "start_detached_command",
              output: limitText(
                [
                  `Command: ${command}`,
                  `Launch mode: detached`,
                  `Error: ${message}`,
                ].join("\n"),
              ),
              isError: true,
            },
            sections: [
              {
                title: "Detached command",
                lines: [
                  `command: ${command}`,
                  `cwd: ${context.workspaceRoot}`,
                  `launch mode: detached from machdoch`,
                  `error: ${message}`,
                ],
              },
            ],
            traceLines: [
              `start_detached_command(${compactTraceText(command)}) -> error`,
            ],
          };
        }
      },
    },
    {
      spec: {
        name: "fetch_url",
        description:
          "Fetch an HTTP or HTTPS URL and return a text preview. Use this when the task explicitly requires a web page or remote API response, especially after search_web or when the user provides a specific URL. Prefer primary sources over secondary summaries.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: {
              type: "string",
              description: "Absolute HTTP or HTTPS URL to fetch.",
            },
          },
          required: ["url"],
        },
      },
      backingTool: "network",
      riskLevel: "medium",
      execute: async (args) => {
        const url = coerceString(args, "url");

        if (!url) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "fetch_url",
            "Expected a non-empty `url`.",
          );
        }

        let parsedUrl: URL;

        try {
          parsedUrl = new URL(url);
        } catch {
          return createToolErrorResult(
            crypto.randomUUID(),
            "fetch_url",
            `The URL \`${url}\` is not valid.`,
          );
        }

        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "fetch_url",
            "Only HTTP and HTTPS URLs are supported.",
          );
        }

        const response = await fetch(parsedUrl, {
          headers: {
            "user-agent": "machdoch/0.1",
          },
        });

        const rawText = await response.text();
        const contentType = response.headers.get("content-type") ?? "unknown";
        const text = contentType.includes("html")
          ? stripHtmlToText(rawText)
          : rawText;
        const limitedText = limitText(text);

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "fetch_url",
            output: [
              `URL: ${parsedUrl.toString()}`,
              `Status: ${response.status}`,
              limitedText,
            ].join("\n\n"),
            ...(response.ok ? {} : { isError: true }),
          },
          sections: [
            {
              title: "Fetched URL",
              lines: [
                `url: ${parsedUrl.toString()}`,
                `status: ${response.status}`,
                `content type: ${contentType}`,
              ],
            },
            createTextSection("Fetched content", limitedText),
          ],
          traceLines: [
            `fetch_url(${parsedUrl.toString()}) -> ${response.status}`,
          ],
        };
      },
    },
  ];

  const activeProvider = getConfiguredWebSearchProvider(config);

  if (!activeProvider) {
    return toolDefinitions;
  }

  toolDefinitions.splice(1, 0, {
    spec: {
      name: "search_web",
      description:
        "Search the public web with the active provider and return ranked results plus concise snippets. Use focused queries, prefer official or maintainer-authored sources, and fetch primary pages before making specific claims.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Focused web-search query. Keep it concise and specific.",
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Maximum number of results to return.",
          },
        },
        required: ["query"],
      },
    },
    backingTool: "network",
    riskLevel: "medium",
    execute: async (args, context) => {
      const query = coerceString(args, "query");
      const maxResults = coerceInteger(args, "maxResults");

      if (!query) {
        return createToolErrorResult(
          crypto.randomUUID(),
          "search_web",
          "Expected a non-empty `query`.",
        );
      }

      try {
        const response = await executeWebSearch(
          context.workspaceRoot,
          activeProvider,
          query,
          maxResults,
        );
        const resultLines = response.results.flatMap((result, index) => [
          `${index + 1}. ${result.title}`,
          `   url: ${result.url}`,
          `   snippet: ${result.snippet}`,
          ...(result.date ? [`   date: ${result.date}`] : []),
        ]);
        const output = [
          `Provider: ${response.provider}`,
          `Query: ${response.query}`,
          ...(response.summary ? [`Summary: ${response.summary}`] : []),
          ...(resultLines.length > 0 ? resultLines : ["No results returned."]),
        ].join("\n");

        return {
          toolResult: {
            callId: crypto.randomUUID(),
            name: "search_web",
            output: limitText(output),
          },
          sections: [
            {
              title: "Web search",
              lines: [
                `provider: ${response.provider}`,
                `query: ${response.query}`,
                `results: ${response.results.length}`,
                ...(response.summary ? [`summary: ${response.summary}`] : []),
              ],
            },
            {
              title: "Web search results",
              lines:
                resultLines.length > 0
                  ? resultLines
                  : ["No results were returned by the active provider."],
            },
          ],
          traceLines: [
            `search_web(${response.provider}, ${compactTraceText(query)}) -> ${response.results.length} result${response.results.length === 1 ? "" : "s"}`,
          ],
        };
      } catch (error) {
        return createToolErrorResult(
          crypto.randomUUID(),
          "search_web",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  return toolDefinitions;
};
