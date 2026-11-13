import { expect, it } from "vitest";
import { oauthAuthorizeUrl, providerWebOrigin } from "./oauth";

it("derives the sign-in host from each provider's API address", () => {
  expect(providerWebOrigin("github", "https://api.github.com")).toBe(
    "https://github.com",
  );
  expect(providerWebOrigin("github", "https://git.example.test/api/v3")).toBe(
    "https://git.example.test",
  );
  expect(providerWebOrigin("gitlab", "https://gitlab.com/api/v4")).toBe(
    "https://gitlab.com",
  );
  expect(
    providerWebOrigin("gitlab", "https://example.test/gitlab/api/v4"),
  ).toBe("https://example.test/gitlab");
});

it("asks GitHub for repository access without a response type", () => {
  const url = new URL(
    oauthAuthorizeUrl(
      "github",
      "https://api.github.com",
      "client",
      "https://cloud.example.test/callback",
      "state",
    ),
  );
  expect(`${url.origin}${url.pathname}`).toBe(
    "https://github.com/login/oauth/authorize",
  );
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "client",
    redirect_uri: "https://cloud.example.test/callback",
    scope: "repo read:user",
    state: "state",
  });
});
