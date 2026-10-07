import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "./cli-args.js";
import { runCli } from "../app.js";
import { createSignedArtifact } from "../../update/__test__/signed-update.js";

afterEach(() => vi.unstubAllGlobals());

describe("update command", () => {
  it("parses installed updates and read-only JSON checks", () => {
    expect(parseCliArgs(["update"]).command).toBe("update");
    expect(parseCliArgs(["update", "--check", "--json"])).toMatchObject({
      command: "update",
      json: true,
      update: { check: true },
    });
    expect(parseCliArgs(["update", "--help"])).toMatchObject({
      command: "help",
      helpTopic: "update",
    });
    expect(() => parseCliArgs(["update", "extra"])).toThrow(/Usage/);
    expect(() => parseCliArgs(["chat", "--check"])).toThrow(/only valid/);
  });

  it("checks without changing files or initializing provider synchronization", async () => {
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            version: "99.0.0",
            platforms: {
              "linux-headless": createSignedArtifact("99.0.0").artifact,
            },
          }),
        ),
      ),
    );
    await expect(runCli(["update", "--check", "--json"])).resolves.toBe(
      "update",
    );
    const result = JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    expect(result).toMatchObject({
      latestVersion: "99.0.0",
      updateAvailable: true,
      installed: false,
    });
  });
});
