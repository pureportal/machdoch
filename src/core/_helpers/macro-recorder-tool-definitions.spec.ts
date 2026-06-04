/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolExecutionContext } from "./agent-tools-shared.js";
import {
  createMacroRecorderToolDefinitions,
  recordMacroToolCall,
  resetMacroRecordingsForTests,
} from "./macro-recorder-tool-definitions.ts";

const createExecutionContext = (
  workspaceRoot: string,
): AgentToolExecutionContext => {
  return {
    workspaceRoot,
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
  };
};

const getMacroTool = (name: string) => {
  const tool = createMacroRecorderToolDefinitions().find(
    (definition) => definition.spec.name === name,
  );

  if (!tool) {
    throw new Error(`Missing macro recorder tool ${name}`);
  }

  return tool;
};

let workspaceRoot: string;

beforeEach(async () => {
  resetMacroRecordingsForTests();
  workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-macro-recorder-"));
});

afterEach(async () => {
  resetMacroRecordingsForTests();
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("createMacroRecorderToolDefinitions", () => {
  it("saves recorded browser and desktop steps as prompt and skill artifacts", async () => {
    const context = createExecutionContext(workspaceRoot);

    await getMacroTool("start_macro_recording").execute(
      {
        recordingId: "layout_flow",
        name: "Capture layout flow",
        scope: "browser-and-desktop",
      },
      context,
    );

    recordMacroToolCall({
      toolName: "start_browser_session",
      backingTool: "browser",
      riskLevel: "high",
      effect: "external-side-effect",
      arguments: {
        sessionId: "layout",
        url: "https://example.com",
        headless: true,
      },
      output: "session: layout\nurl: https://example.com/",
    });
    recordMacroToolCall({
      toolName: "type_browser_text",
      backingTool: "browser",
      riskLevel: "high",
      effect: "external-side-effect",
      arguments: {
        sessionId: "layout",
        locatorType: "label",
        locatorValue: "Email",
        text: "person@example.com",
      },
      output: "Filled locator: label=Email",
    });
    recordMacroToolCall({
      toolName: "click_ui_point",
      backingTool: "shell",
      riskLevel: "high",
      effect: "external-side-effect",
      arguments: {
        x: 120,
        y: 240,
      },
      output: "Clicked left mouse button 1 time(s) at (120, 240).",
    });

    const saveResult = await getMacroTool("save_macro_recording").execute(
      {
        recordingId: "layout_flow",
        kind: "both",
        name: "Layout Check",
        description: "Replay the layout capture workflow.",
      },
      context,
    );

    const promptContent = await readFile(
      join(
        workspaceRoot,
        ".machdoch",
        "prompts",
        "layout-check.prompt.md",
      ),
      "utf8",
    );
    const skillContent = await readFile(
      join(workspaceRoot, ".machdoch", "skills", "layout-check", "SKILL.md"),
      "utf8",
    );
    const sidecarContent = await readFile(
      join(workspaceRoot, ".machdoch", "macros", "layout-check.macro.json"),
      "utf8",
    );

    expect(saveResult.toolResult.isError).toBeUndefined();
    expect(saveResult.toolResult.output).toContain(
      "created: .machdoch/prompts/layout-check.prompt.md",
    );
    expect(saveResult.toolResult.output).toContain(
      "created: .machdoch/skills/layout-check/SKILL.md",
    );
    expect(saveResult.toolResult.output).toContain(
      "created: .machdoch/macros/layout-check.macro.json",
    );
    expect(promptContent).toContain("name: layout-check");
    expect(promptContent).toContain("tools:\n- browser\n- shell");
    expect(promptContent).toContain("inputs:\n- step_2_text");
    expect(promptContent).toContain("${input:step_2_text:Text for step 2}");
    expect(promptContent).toContain("Recorded tool-call JSON:");
    expect(promptContent).toContain('"schema": "machdoch.macroRecording"');
    expect(promptContent).toContain('"schemaVersion": 2');
    expect(promptContent).toContain('"toolName": "type_browser_text"');
    expect(promptContent).toContain('"fragility": "high"');
    expect(promptContent).not.toContain("person@example.com");
    expect(promptContent).toContain("3. Run `click_ui_point`.");
    expect(skillContent).toContain("user-invocable: true");
    expect(skillContent).toContain("Use this skill when");
    expect(sidecarContent).toContain('"replayPolicy"');
    expect(sidecarContent).toContain('"needsDesktopUiControl": true');
  });

  it("lists and inspects active recordings before saving", async () => {
    const context = createExecutionContext(workspaceRoot);

    await getMacroTool("start_macro_recording").execute(
      {
        recordingId: "inspectable",
        name: "Inspectable flow",
        scope: "browser",
      },
      context,
    );

    recordMacroToolCall({
      toolName: "click_browser_selector",
      backingTool: "browser",
      riskLevel: "high",
      effect: "external-side-effect",
      arguments: {
        sessionId: "inspectable",
        locatorType: "role",
        locatorValue: "button",
        locatorName: "Continue",
      },
      output: "Clicked locator: role=button name=Continue",
    });

    const listResult = await getMacroTool("list_macro_recordings").execute(
      {},
      context,
    );
    const inspectResult = await getMacroTool("inspect_macro_recording").execute(
      {
        recordingId: "inspectable",
      },
      context,
    );

    expect(listResult.toolResult.output).toContain("inspectable | recording");
    expect(inspectResult.toolResult.output).toContain(
      '"schema": "machdoch.macroRecording"',
    );
    expect(inspectResult.toolResult.output).toContain('"kind": "action"');
    expect(inspectResult.toolResult.output).toContain('"fragility": "low"');
    expect(inspectResult.toolResult.output).toContain(
      "Semantic browser locator recorded",
    );
  });

  it("can omit read-only steps and preserve literal text when requested", async () => {
    const context = createExecutionContext(workspaceRoot);

    await getMacroTool("start_macro_recording").execute(
      {
        recordingId: "literal",
        name: "Literal text flow",
        scope: "browser",
        includeReadOnlySteps: false,
        literalTextInputs: true,
      },
      context,
    );

    recordMacroToolCall({
      toolName: "read_browser_page",
      backingTool: "browser",
      riskLevel: "low",
      effect: "read",
      arguments: {
        sessionId: "literal",
      },
      output: "Page text",
    });
    recordMacroToolCall({
      toolName: "type_browser_text",
      backingTool: "browser",
      riskLevel: "high",
      effect: "external-side-effect",
      arguments: {
        sessionId: "literal",
        selector: "input[name=q]",
        text: "machdoch",
      },
      output: "Filled locator: selector=input[name=q]",
    });

    await getMacroTool("save_macro_recording").execute(
      {
        recordingId: "literal",
        kind: "prompt",
        name: "Literal Search",
        includeJsonSidecar: false,
      },
      context,
    );

    const promptContent = await readFile(
      join(
        workspaceRoot,
        ".machdoch",
        "prompts",
        "literal-search.prompt.md",
      ),
      "utf8",
    );

    expect(promptContent).not.toContain("read_browser_page");
    expect(promptContent).toContain("text: machdoch");
    expect(promptContent).not.toContain("${input:");
  });

  it("redacts typed desktop text from recorded output summaries", async () => {
    const context = createExecutionContext(workspaceRoot);

    await getMacroTool("start_macro_recording").execute(
      {
        recordingId: "desktop-text",
        name: "Desktop text flow",
        scope: "desktop",
      },
      context,
    );

    recordMacroToolCall({
      toolName: "type_ui_text",
      backingTool: "shell",
      riskLevel: "high",
      effect: "external-side-effect",
      arguments: {
        text: "secret desktop value",
      },
      output: "Typed text into the focused UI element: secret desktop value",
    });

    await getMacroTool("save_macro_recording").execute(
      {
        recordingId: "desktop-text",
        kind: "prompt",
        name: "Desktop Text",
        includeJsonSidecar: false,
      },
      context,
    );

    const promptContent = await readFile(
      join(
        workspaceRoot,
        ".machdoch",
        "prompts",
        "desktop-text.prompt.md",
      ),
      "utf8",
    );

    expect(promptContent).toContain("${input:step_1_text:Text for step 1}");
    expect(promptContent).toContain("literal tool output redacted");
    expect(promptContent).not.toContain("secret desktop value");
  });

  it("does not partially create artifacts when a combined save is blocked", async () => {
    const context = createExecutionContext(workspaceRoot);

    await mkdir(join(workspaceRoot, ".machdoch", "skills", "partial"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, ".machdoch", "skills", "partial", "SKILL.md"),
      "existing skill",
      "utf8",
    );

    await getMacroTool("start_macro_recording").execute(
      {
        recordingId: "partial",
        name: "Partial",
        scope: "desktop",
      },
      context,
    );

    recordMacroToolCall({
      toolName: "click_ui_point",
      backingTool: "shell",
      riskLevel: "high",
      effect: "external-side-effect",
      arguments: {
        x: 10,
        y: 20,
      },
      output: "Clicked left mouse button 1 time(s) at (10, 20).",
    });

    const saveResult = await getMacroTool("save_macro_recording").execute(
      {
        recordingId: "partial",
        kind: "both",
        name: "Partial",
      },
      context,
    );

    expect(saveResult.toolResult.isError).toBe(true);
    expect(saveResult.toolResult.output).toContain("already exists");
    await expect(
      readFile(
        join(workspaceRoot, ".machdoch", "prompts", "partial.prompt.md"),
        "utf8",
      ),
    ).rejects.toThrow();
  });
});
