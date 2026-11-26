import { expect, it } from "vitest";
import { gitTokenUrl } from "./git-providers";

it("links to token creation with the needed scopes", () => {
  expect(gitTokenUrl("github", "https://api.github.com", "connection")).toBe(
    "https://github.com/settings/tokens/new?description=Machdoch&scopes=repo,admin:repo_hook,read:org",
  );
  expect(
    gitTokenUrl("github", "https://ghe.example.test/api/v3", "connection"),
  ).toBe(
    "https://ghe.example.test/settings/tokens/new?description=Machdoch&scopes=repo,admin:repo_hook,read:org",
  );
  expect(gitTokenUrl("gitlab", "https://gitlab.com/api/v4", "connection")).toBe(
    "https://gitlab.com/-/user_settings/personal_access_tokens?name=Machdoch&scopes=api",
  );
  expect(gitTokenUrl("gitlab", "not a url", "connection")).toBeNull();
});

it("links personal tokens to the scopes acting as a member needs", () => {
  expect(gitTokenUrl("github", "https://api.github.com", "account")).toBe(
    "https://github.com/settings/tokens/new?description=Machdoch&scopes=repo,workflow,read:org",
  );
  expect(gitTokenUrl("gitlab", "https://gitlab.com/api/v4", "account")).toBe(
    "https://gitlab.com/-/user_settings/personal_access_tokens?name=Machdoch&scopes=api",
  );
});
