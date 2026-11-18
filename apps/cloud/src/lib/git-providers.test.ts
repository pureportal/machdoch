import { expect, it } from "vitest";
import { gitTokenUrl } from "./git-providers";

it("links to token creation with the needed scopes", () => {
  expect(gitTokenUrl("github", "https://api.github.com")).toBe(
    "https://github.com/settings/tokens/new?description=Machdoch&scopes=repo,admin:repo_hook",
  );
  expect(gitTokenUrl("github", "https://ghe.example.test/api/v3")).toBe(
    "https://ghe.example.test/settings/tokens/new?description=Machdoch&scopes=repo,admin:repo_hook",
  );
  expect(gitTokenUrl("gitlab", "https://gitlab.com/api/v4")).toBe(
    "https://gitlab.com/-/user_settings/personal_access_tokens?name=Machdoch&scopes=api",
  );
  expect(gitTokenUrl("gitlab", "not a url")).toBeNull();
});
