import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createFilesystemToolDefinitions } from "./filesystem-tool-definitions.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    mkdir: vi.fn(original.mkdir),
    readFile: vi.fn(original.readFile),
  };
});

const workspaces: string[] = [];
afterEach(async () => {
  vi.mocked(mkdir).mockReset();
  vi.mocked(readFile).mockReset();
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const setup = async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-write-safety-"));
  workspaces.push(workspaceRoot);
  const controller = new AbortController();
  const context = {
    workspaceRoot,
    signal: controller.signal,
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
  };
  const definitions = createFilesystemToolDefinitions();
  return {
    context,
    controller,
    create: definitions.find((tool) => tool.spec.name === "create_file")!,
    replace: definitions.find((tool) => tool.spec.name === "replace_in_file")!,
  };
};

it("creates files exclusively when concurrent calls target the same path", async () => {
  const { context, create } = await setup();
  const results = await Promise.all([
    create.execute({ path: "report.txt", content: "First" }, context),
    create.execute({ path: "report.txt", content: "Second" }, context),
  ]);
  expect(results.filter((result) => !result.toolResult.isError)).toHaveLength(
    1,
  );
  expect(
    results.find((result) => result.toolResult.isError)?.toolResult.output,
  ).toContain("already exists");
  const winner = await readFile(
    join(context.workspaceRoot, "report.txt"),
    "utf8",
  );
  expect(["First", "Second"]).toContain(winner);
  expect(
    (
      await create.execute(
        { path: "report.txt", content: "Overwritten" },
        context,
      )
    ).toolResult.isError,
  ).toBe(true);
  expect(
    await readFile(join(context.workspaceRoot, "report.txt"), "utf8"),
  ).toBe(winner);
});

it("does not create a file after cancellation during directory preparation", async () => {
  const { context, controller, create } = await setup();
  vi.mocked(mkdir).mockImplementationOnce(async () => {
    controller.abort();
    return undefined;
  });
  await expect(
    create.execute({ path: "report.txt", content: "Late" }, context),
  ).rejects.toThrow();
  await expect(
    readFile(join(context.workspaceRoot, "report.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not replace file content after cancellation during the read", async () => {
  const { context, controller, replace } = await setup();
  await writeFile(join(context.workspaceRoot, "report.txt"), "Before");
  vi.mocked(readFile).mockImplementationOnce(async () => {
    controller.abort();
    return Buffer.from("Before");
  });
  await expect(
    replace.execute(
      {
        path: "report.txt",
        oldText: "Before",
        newText: "After",
        replaceAll: false,
      },
      context,
    ),
  ).rejects.toThrow();
  expect(
    await readFile(join(context.workspaceRoot, "report.txt"), "utf8"),
  ).toBe("Before");
});

it("returns creation errors to the model for correction", async () => {
  const { context, create } = await setup();
  vi.mocked(mkdir).mockRejectedValueOnce(new Error("Permission denied"));
  const result = await create.execute(
    { path: "report.txt", content: "Report" },
    context,
  );
  expect(result.toolResult.isError).toBe(true);
  expect(result.toolResult.output).toContain("Permission denied");
});
