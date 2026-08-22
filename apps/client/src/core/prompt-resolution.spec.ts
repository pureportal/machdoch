import {
  parsePromptInvocation,
  resolveInvokedPrompt,
} from "./prompt-resolution.ts";
import type { DiscoveredPrompt } from "./types.ts";

const createPrompt = (
  overrides?: Partial<DiscoveredPrompt>,
): DiscoveredPrompt => {
  return {
    path: ".machdoch/prompts/example.prompt.md",
    name: "example",
    inputs: [],
    tools: [],
    body: "Prompt body.",
    ...overrides,
  };
};

describe("resolveInvokedPrompt", () => {
  it("parses slash-command and prompt: style prompt invocations", () => {
    expect(parsePromptInvocation("  /debug-build   tsc fails  ")).toEqual({
      name: "debug-build",
      arguments: "tsc fails",
    });
    expect(
      parsePromptInvocation("prompt:release/review version=1.2.3"),
    ).toEqual({
      name: "release/review",
      arguments: "version=1.2.3",
    });
    expect(parsePromptInvocation("debug-build without prefix")).toBeUndefined();
  });

  it("resolves named input variables from quoted name=value arguments", () => {
    const resolved = resolveInvokedPrompt(
      createPrompt({
        inputs: ["error"],
        body: [
          "Investigate ${input:error}.",
          "Use ${input:logs:Paste logs here} for additional context.",
        ].join("\n"),
      }),
      'error="TypeScript compile fails" logs="TS2304 at src/core/task-runner.ts"',
    );

    expect(resolved.expectedInputs).toEqual(["error", "logs"]);
    expect(resolved.inputValues).toEqual({
      error: "TypeScript compile fails",
      logs: "TS2304 at src/core/task-runner.ts",
    });
    expect(resolved.missingInputs).toEqual([]);
    expect(resolved.resolvedBody).toBe(
      [
        "Investigate TypeScript compile fails.",
        "Use TS2304 at src/core/task-runner.ts for additional context.",
      ].join("\n"),
    );
  });

  it("maps a single freeform argument to the last unresolved input", () => {
    const resolved = resolveInvokedPrompt(
      createPrompt({
        inputs: ["topic"],
        body: "Summarize ${input:topic} for the release notes.",
      }),
      "README.md",
    );

    expect(resolved.inputValues).toEqual({ topic: "README.md" });
    expect(resolved.missingInputs).toEqual([]);
    expect(resolved.resolvedBody).toBe(
      "Summarize README.md for the release notes.",
    );
  });

  it("ignores blank named argument values so a remaining freeform value can still resolve the input", () => {
    const resolved = resolveInvokedPrompt(
      createPrompt({
        inputs: ["file"],
        body: "Show ${input:file}.",
      }),
      "file= README.md",
    );

    expect(resolved.inputValues).toEqual({ file: "README.md" });
    expect(resolved.missingInputs).toEqual([]);
    expect(resolved.resolvedBody).toBe("Show README.md.");
  });

  it("leaves unresolved placeholders in place when required inputs are still missing", () => {
    const resolved = resolveInvokedPrompt(
      createPrompt({
        body: "Review ${input:file} using ${input:mode:review mode}.",
      }),
      "file=README.md",
    );

    expect(resolved.inputValues).toEqual({ file: "README.md" });
    expect(resolved.missingInputs).toEqual(["mode"]);
    expect(resolved.resolvedBody).toBe(
      "Review README.md using ${input:mode:review mode}.",
    );
  });

  it("deduplicates expected inputs and supports escaped or backtick-quoted values", () => {
    const resolved = resolveInvokedPrompt(
      createPrompt({
        inputs: ["file", "", "file"],
        body: [
          "Review ${input:file:document}.",
          "Revisit ${input:file} in ${input:mode}.",
        ].join("\n"),
      }),
      'file="docs/\\"draft\\".md" mode=`full review`',
    );

    expect(resolved.expectedInputs).toEqual(["file", "mode"]);
    expect(resolved.inputValues).toEqual({
      file: 'docs/"draft".md',
      mode: "full review",
    });
    expect(resolved.missingInputs).toEqual([]);
  });

  it("treats blank-only named argument values as missing inputs", () => {
    const resolved = resolveInvokedPrompt(
      createPrompt({
        inputs: ["file"],
        body: "Review ${input:file}.",
      }),
      'file="   "',
    );

    expect(resolved.inputValues).toEqual({});
    expect(resolved.missingInputs).toEqual(["file"]);
    expect(resolved.resolvedBody).toBe("Review ${input:file}.");
  });

  it("does not bind freeform text when multiple inputs remain unresolved", () => {
    const resolved = resolveInvokedPrompt(
      createPrompt({
        body: [
          "Review ${input:file}.",
          "Use ${input:mode} for tone and ${input:audience} for scope.",
        ].join("\n"),
      }),
      "1mode=quick review notes",
    );

    expect(resolved.inputValues).toEqual({});
    expect(resolved.missingInputs).toEqual(["file", "mode", "audience"]);
    expect(resolved.resolvedBody).toContain("${input:file}");
    expect(resolved.resolvedBody).toContain("${input:mode}");
    expect(resolved.resolvedBody).toContain("${input:audience}");
  });
});
