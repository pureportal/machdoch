import { spawn, type ChildProcess } from "node:child_process";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
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

const WINDOWS_POWERSHELL_BOOTSTRAP_LINES = [
  "$PSDefaultParameterValues['Invoke-WebRequest:UseBasicParsing'] = $true",
  "$PSDefaultParameterValues['Invoke-RestMethod:UseBasicParsing'] = $true",
] as const;

const WRITE_LIKE_SHELL_PATTERN =
  /\b(?:add-content|clear-content|copy|cp|del|erase|git\s+(?:add|apply|checkout|clean|commit|merge|pull|push|rebase|reset|restore|switch)|mkdir|move|mv|new-item|npm\s+(?:ci|exec|i|install|link|publish|run|test|uninstall|update)|pnpm\s+(?:add|exec|i|install|publish|remove|run|test|update)|remove-item|rm|rmdir|set-content|touch|yarn\s+(?:add|exec|install|publish|remove|run|test|upgrade))\b/i;
const SHELL_CONTROL_OPERATOR_PATTERN = /(?:&&?|\|\|?|\r|\n|;|<|>>?|`|\$\()/u;
const SHELL_WRITE_OPTION_PATTERN =
  /(?:^|\s)(?:--output(?:=|\s+)|--open-files-in-pager(?:=|\s+)|--pre(?:=|\s+))/iu;
const SHELL_OUT_OF_WORKSPACE_PATH_PATTERN =
  /(?:^|\s|["'])(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/]|\.{2}(?:[\\/]|$)|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)/u;
const READ_ONLY_SHELL_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:dir|ls|pwd)\b/i,
  /^(?:cat|type)\s+/i,
  /^(?:get-childitem|gci|get-content|gc|select-string)\b/i,
  /^(?:rg|grep|findstr)\b/i,
  /^git\s+(?:branch|diff|grep|log|ls-files|show|status)\b/i,
  /^(?:npm|pnpm|yarn|bun)\s+(?:info|list|ls|outdated|view|why)\b/i,
  /^(?:node|npm|pnpm|yarn|bun|cargo|rustc|python|python3|pip|pip3)\s+(?:--version|-v|version)\b/i,
];
const FETCH_URL_TIMEOUT_MS = 15_000;
const MAX_FETCH_URL_RESPONSE_BYTES = 1_000_000;

export const isReadOnlyShellCommand = (
  args: Record<string, unknown>,
): boolean => {
  const command = coerceString(args, "command");

  if (!command) {
    return false;
  }

  const normalizedCommand = command.trim();

  if (
    SHELL_CONTROL_OPERATOR_PATTERN.test(normalizedCommand) ||
    WRITE_LIKE_SHELL_PATTERN.test(normalizedCommand) ||
    SHELL_WRITE_OPTION_PATTERN.test(normalizedCommand) ||
    SHELL_OUT_OF_WORKSPACE_PATH_PATTERN.test(normalizedCommand)
  ) {
    return false;
  }

  return READ_ONLY_SHELL_PATTERNS.some((pattern) =>
    pattern.test(normalizedCommand),
  );
};

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

const getResponseContentLength = (response: Response): number | undefined => {
  const rawContentLength = response.headers.get("content-length");

  if (!rawContentLength) {
    return undefined;
  }

  const contentLength = Number(rawContentLength);

  return Number.isFinite(contentLength) && contentLength >= 0
    ? contentLength
    : undefined;
};

const createFetchUrlSizeError = (): Error => {
  return new Error(
    `Fetched content exceeded ${MAX_FETCH_URL_RESPONSE_BYTES} bytes.`,
  );
};

const readLimitedResponseText = async (response: Response): Promise<string> => {
  const contentLength = getResponseContentLength(response);

  if (
    contentLength !== undefined &&
    contentLength > MAX_FETCH_URL_RESPONSE_BYTES
  ) {
    throw createFetchUrlSizeError();
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;

    if (totalBytes > MAX_FETCH_URL_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw createFetchUrlSizeError();
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
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

interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const normalizeShellOutput = (value: string): string => {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
};

const createCommandProcessError = (
  message: string,
  result: {
    stdout: string;
    stderr: string;
    exitCode?: number;
  },
): Error & { stdout: string; stderr: string; code?: number } => {
  const error = new Error(message) as Error & {
    stdout: string;
    stderr: string;
    code?: number;
  };

  error.stdout = result.stdout;
  error.stderr = result.stderr;

  if (result.exitCode !== undefined) {
    error.code = result.exitCode;
  }

  return error;
};

const terminateChildProcessTree = (child: ChildProcess): void => {
  const pid = child.pid;

  if (pid === undefined) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const fallbackToChildKill = (): void => {
        if (!child.killed) {
          child.kill();
        }
      };

      killer.once("error", fallbackToChildKill);
      killer.once("exit", (code) => {
        if (code !== 0) {
          fallbackToChildKill();
        }
      });
      return;
    } catch {
      child.kill();
      return;
    }
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill();
  }
};

const runStreamingShellCommand = async (
  shellExecutable: string,
  shellArgs: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    maxBufferBytes: number;
    onOutput?: (
      output: { stream: "stdout" | "stderr"; chunk: string },
    ) => void | Promise<void>;
  },
): Promise<ShellCommandResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(shellExecutable, shellArgs, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = {
      stdout: [] as string[],
      stderr: [] as string[],
    };
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let exceededBuffer = false;
    let outputHandlerError: unknown;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      terminateChildProcessTree(child);
    }, options.timeoutMs);

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      callback();
    };

    const appendOutput = (
      stream: "stdout" | "stderr",
      value: string | Buffer,
    ): void => {
      const chunk = value.toString();

      outputBytes += Buffer.byteLength(chunk);
      chunks[stream].push(chunk);

      try {
        void Promise.resolve(options.onOutput?.({ stream, chunk })).catch(
          () => undefined,
        );
      } catch (error) {
        outputHandlerError ??= error;
        terminateChildProcessTree(child);
      }

      if (outputBytes > options.maxBufferBytes && !exceededBuffer) {
        exceededBuffer = true;
        terminateChildProcessTree(child);
      }
    };

    child.stdout?.on("data", (chunk: string | Buffer) => {
      appendOutput("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: string | Buffer) => {
      appendOutput("stderr", chunk);
    });
    child.once("error", (error) => {
      settle(() => {
        reject(
          createCommandProcessError(error.message, {
            stdout: chunks.stdout.join(""),
            stderr: chunks.stderr.join(""),
          }),
        );
      });
    });
    child.once("close", (code, signal) => {
      settle(() => {
        const stdout = chunks.stdout.join("");
        const stderr = chunks.stderr.join("");

        if (timedOut) {
          reject(
            createCommandProcessError(
              `Command timed out after ${options.timeoutMs}ms.`,
              { stdout, stderr },
            ),
          );
          return;
        }

        if (outputHandlerError !== undefined) {
          reject(
            createCommandProcessError(
              `Command output handler failed: ${
                outputHandlerError instanceof Error
                  ? outputHandlerError.message
                  : String(outputHandlerError)
              }`,
              { stdout, stderr },
            ),
          );
          return;
        }

        if (exceededBuffer) {
          reject(
            createCommandProcessError(
              `Command output exceeded ${options.maxBufferBytes} bytes.`,
              { stdout, stderr },
            ),
          );
          return;
        }

        if (code === null) {
          reject(
            createCommandProcessError(
              `Command terminated by signal ${signal ?? "unknown"}.`,
              { stdout, stderr },
            ),
          );
          return;
        }

        const exitCode = code;

        if (exitCode !== 0) {
          reject(
            createCommandProcessError(
              `Command failed with exit code ${exitCode}.`,
              { stdout, stderr, exitCode },
            ),
          );
          return;
        }

        resolve({
          stdout: normalizeShellOutput(stdout),
          stderr: normalizeShellOutput(stderr),
          exitCode,
        });
      });
    });
  });
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
      effect: "external-side-effect",
      isReadOnlyInPlanMode: isReadOnlyShellCommand,
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
          const { stdout, stderr } = await runStreamingShellCommand(
            shellExecutable,
            shellArgs,
            {
              cwd: context.workspaceRoot,
              timeoutMs: SHELL_TIMEOUT_MS,
              maxBufferBytes: 1_000_000,
              ...(context.onOutput ? { onOutput: context.onOutput } : {}),
            },
          );
          const normalizedStdout = stdout;
          const normalizedStderr = stderr;
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
              ? normalizeShellOutput(error.stdout)
              : "";
          const stderrFromError =
            error instanceof Error &&
            "stderr" in error &&
            typeof error.stderr === "string"
              ? normalizeShellOutput(error.stderr)
              : "";
          const stderr =
            stderrFromError ||
            (error instanceof Error ? error.message : String(error));
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
      effect: "external-side-effect",
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
      effect: "external-read",
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

        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => {
          abortController.abort();
        }, FETCH_URL_TIMEOUT_MS);
        let response: Response;
        let rawText: string;

        try {
          response = await fetch(parsedUrl, {
            headers: {
              "user-agent": "machdoch/0.1",
            },
            signal: abortController.signal,
          });
          rawText = await readLimitedResponseText(response);
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "fetch_url",
            error instanceof Error ? error.message : "Failed to fetch URL.",
          );
        } finally {
          clearTimeout(timeoutHandle);
        }

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
    effect: "external-read",
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
