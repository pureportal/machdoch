import { describe, expect, it } from "vitest";
import { emptySettingsDocument } from "../server/settings";
import {
  applySettingsItem,
  mcpSecretPlaceholderProblem,
  mcpServerProblem,
  renamedSettingsItem,
  SettingsItemConflictError,
  type SettingsItem,
} from "./settings-items";

const firstId = "123e4567-e89b-42d3-a456-426614174000";
const secondId = "123e4567-e89b-42d3-a456-426614174001";
const instruction = (id: string, name: string, body = "Body") => ({
  id,
  name,
  body,
  enabled: true,
  global: true,
  tags: [],
});
const server = (
  transport: SettingsItem<"mcpServer">["transport"],
): SettingsItem<"mcpServer"> => ({
  id: "github",
  title: "GitHub",
  enabled: true,
  transport,
});

describe("settings items", () => {
  it("adds, replaces or keeps both when a proposal matches an item", () => {
    const document = emptySettingsDocument();
    document.instructions = [instruction(firstId, "Review", "Old")];
    const incoming = instruction(secondId, "review", "New");
    expect(() =>
      applySettingsItem(document, "instruction", incoming, "add"),
    ).toThrow(SettingsItemConflictError);
    expect(
      applySettingsItem(document, "instruction", incoming, "replace")
        .instructions,
    ).toEqual([{ ...incoming, id: firstId }]);
    const both = applySettingsItem(
      document,
      "instruction",
      incoming,
      "keep-both",
    ).instructions;
    expect(both.map((item) => item.name)).toEqual(["Review", "review (2)"]);
    expect(both[1]!.id).not.toBe(firstId);
  });

  it("gives a new item a fresh id only when its id is taken", () => {
    const document = emptySettingsDocument();
    document.instructions = [instruction(firstId, "Review")];
    const added = applySettingsItem(
      document,
      "instruction",
      instruction(firstId, "Security"),
      "add",
    ).instructions;
    expect(added.map((item) => item.name)).toEqual(["Review", "Security"]);
    expect(added[1]!.id).not.toBe(firstId);
    expect(
      applySettingsItem(
        document,
        "instruction",
        instruction(secondId, "Security"),
        "add",
      ).instructions[1]!.id,
    ).toBe(secondId);
  });

  it("keeps renamed copies within the name and path limits", () => {
    const component = `${"a".repeat(110)}.prompt.md`;
    const prompt = {
      id: firstId,
      relativePath: `team/${component}`,
      content: "Review",
    };
    const copy = renamedSettingsItem("prompt", prompt, [prompt]);
    expect(copy.relativePath).toMatch(/^team\/a+-2\.prompt\.md$/u);
    expect(copy.relativePath.split("/").at(-1)!.length).toBeLessThanOrEqual(
      120,
    );
    expect(
      renamedSettingsItem(
        "prompt",
        { ...prompt, relativePath: "Review.prompt.md" },
        [
          { ...prompt, relativePath: "review.prompt.md" },
          { ...prompt, relativePath: "review-2.prompt.md" },
        ],
      ).relativePath,
    ).toBe("Review-3.prompt.md");
    const titled = server({
      type: "stdio",
      command: "npx",
      args: [],
      env: {},
    });
    titled.title = "t".repeat(200);
    expect(
      renamedSettingsItem("mcpServer", titled, [titled]).title!.length,
    ).toBeLessThanOrEqual(200);
  });

  it("explains MCP servers the protocol rejects", () => {
    const stdio = (env: Record<string, string>) =>
      server({ type: "stdio", command: "npx", args: [], env });
    expect(mcpServerProblem(stdio({ GITHUB_TOKEN: "x" }))).toBeNull();
    expect(mcpServerProblem({ ...stdio({}), id: "GitHub" })).toMatch(
      /server id/u,
    );
    expect(mcpServerProblem(stdio({ "1TOKEN": "x" }))).toMatch(
      /^1TOKEN is not a valid environment variable name/u,
    );
    expect(
      mcpServerProblem(
        server({ type: "sse", url: "ftp://example.test", headers: {} }),
      ),
    ).toBe("Enter an http:// or https:// URL.");
    expect(
      mcpServerProblem(
        server({
          type: "sse",
          url: "https://example.test",
          headers: { "Bad Header": "x" },
        }),
      ),
    ).toBe("Bad Header is not a valid header name.");
    expect(mcpServerProblem({ ...stdio({}), extra: true })).toBe(
      "Remove the unknown field extra.",
    );
  });

  it("flags secret placeholders that devices cannot resolve", () => {
    const storable = (id: string) => id === "openai" || id.startsWith("mcp_");
    const withToken = (value: string) =>
      server({
        type: "stdio",
        command: "npx",
        args: [],
        env: { TOKEN: value },
      });
    expect(
      mcpSecretPlaceholderProblem(withToken("{{secret:mcp_github}}"), storable),
    ).toBeNull();
    expect(
      mcpSecretPlaceholderProblem(withToken("{{secret:openai}}"), storable),
    ).toBeNull();
    expect(
      mcpSecretPlaceholderProblem(withToken("{{secret:MCP_GitHub}}"), storable),
    ).toMatch(/^\{\{secret:MCP_GitHub\}\} is not a valid secret placeholder/u);
    expect(
      mcpSecretPlaceholderProblem(
        withToken("{{ secret:mcp_github }}"),
        storable,
      ),
    ).toMatch(/is not a valid secret placeholder/u);
    expect(
      mcpSecretPlaceholderProblem(withToken("{{secret:github}}"), storable),
    ).toMatch(/^\{\{secret:github\}\} cannot be stored/u);
  });
});
