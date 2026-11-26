import { expect, it } from "vitest";
import { relayedPrompt, relayLabel } from "./agent-relay";

it("extracts the request from comments that mention @agent", () => {
  expect(relayedPrompt("@agent fix the flaky login test")).toBe(
    "fix the flaky login test",
  );
  expect(relayedPrompt("@Agent, please add retries")).toBe(
    "please add retries",
  );
  expect(relayedPrompt("Looks wrong. @agent can you check line 4?")).toBe(
    "Looks wrong. can you check line 4?",
  );
  expect(relayedPrompt("Context first\n@agent summarize this")).toBe(
    "Context first\nsummarize this",
  );
});

it("ignores comments without a standalone @agent mention", () => {
  expect(relayedPrompt("Ping @agents team")).toBeNull();
  expect(relayedPrompt("mail me at ops@agent.example")).toBeNull();
  expect(relayedPrompt("Use `@agent` in comments")).toBeNull();
  expect(relayedPrompt("@agent-smith take a look")).toBeNull();
  expect(relayedPrompt("@agent")).toBeNull();
  expect(relayedPrompt("No mention here")).toBeNull();
});

it("labels relayed turns with their author", () => {
  expect(
    relayLabel({ source: "pull_request_comment", author: "ada", url: null }),
  ).toBe("ada · from pull request comment");
});
