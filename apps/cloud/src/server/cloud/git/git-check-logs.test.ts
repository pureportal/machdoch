import { describe, expect, it } from "vitest";
import { gitClient } from "./git-client";

interface Call {
  url: string;
  authorization: string | null;
}

function transport(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const route = routes[url.replace(/\?.*$/u, "")];
    return route
      ? route()
      : Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: send };
}

const head = "a".repeat(40);
const githubApi = "https://api.github.test";
const gitlabApi = "https://gitlab.test/api/v4";
const gitlabProject = `${gitlabApi}/projects/${encodeURIComponent("group/app")}`;

describe("failed check logs", () => {
  it("reads GitHub Actions logs from the signed address without the token and keeps only the tail", async () => {
    const log = `${"early line\n".repeat(10_000)}##[error]Process completed with exit code 1.`;
    const { calls, fetch } = transport({
      [`${githubApi}/repos/acme/app/commits/${head}/check-runs`]: () =>
        Response.json({
          check_runs: [
            {
              id: 7,
              name: "unit",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.test/acme/app/runs/7",
              app: { slug: "github-actions" },
            },
            {
              id: 8,
              name: "expired",
              status: "completed",
              conclusion: "failure",
              app: { slug: "github-actions" },
              output: { title: "Build failed", summary: "Missing module" },
            },
            {
              id: 9,
              name: "external",
              status: "completed",
              conclusion: "failure",
              app: { slug: "ci-app" },
              output: { title: "Coverage dropped", text: "Below 80%" },
            },
            {
              id: 10,
              name: "lint",
              status: "completed",
              conclusion: "success",
            },
          ],
        }),
      [`${githubApi}/repos/acme/app/commits/${head}/status`]: () =>
        Response.json({
          state: "failure",
          statuses: [
            {
              context: "deploy",
              state: "failure",
              description: "Preview failed",
              target_url: null,
            },
            { context: "docs", state: "success", target_url: null },
          ],
        }),
      [`${githubApi}/repos/acme/app/actions/jobs/7/logs`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://logs.github.test/jobs/7" },
        }),
      "https://logs.github.test/jobs/7": () => new Response(log),
    });
    const logs = await gitClient(
      { provider: "github", apiUrl: githubApi, token: "secret" },
      fetch,
    ).failedCheckLogs("acme/app", head);
    expect(logs.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: "unit", url: "https://github.test/acme/app/runs/7" },
      { name: "expired", url: null },
      { name: "external", url: null },
      { name: "deploy", url: null },
    ]);
    expect(logs[0]!.log.length).toBe(64 * 1024);
    expect(
      logs[0]!.log.endsWith("##[error]Process completed with exit code 1."),
    ).toBe(true);
    expect(logs[1]!.log).toBe("Build failed\n\nMissing module");
    expect(logs[2]!.log).toBe("Coverage dropped\n\nBelow 80%");
    expect(logs[3]!.log).toBe("Preview failed");
    expect(
      calls.find((call) => call.url.endsWith("/actions/jobs/7/logs"))!
        .authorization,
    ).toBe("Bearer secret");
    expect(
      calls.find((call) => call.url === "https://logs.github.test/jobs/7")!
        .authorization,
    ).toBeNull();
  });

  it("refuses to follow a log redirect to an insecure address", async () => {
    const { fetch } = transport({
      [`${githubApi}/repos/acme/app/commits/${head}/check-runs`]: () =>
        Response.json({
          check_runs: [
            {
              id: 7,
              name: "unit",
              status: "completed",
              conclusion: "failure",
              app: { slug: "github-actions" },
            },
          ],
        }),
      [`${githubApi}/repos/acme/app/commits/${head}/status`]: () =>
        Response.json({ state: "failure", statuses: [] }),
      [`${githubApi}/repos/acme/app/actions/jobs/7/logs`]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://logs.github.test/jobs/7" },
        }),
    });
    await expect(
      gitClient(
        { provider: "github", apiUrl: githubApi, token: "secret" },
        fetch,
      ).failedCheckLogs("acme/app", head),
    ).rejects.toMatchObject({ code: "git_request" });
  });

  it("reads the trace of the latest failed GitLab job and falls back to its description", async () => {
    const { calls, fetch } = transport({
      [`${gitlabProject}/repository/commits/${head}/statuses`]: () =>
        Response.json([
          { id: 1, name: "test", status: "success", target_url: null },
          {
            id: 3,
            name: "test",
            status: "failed",
            target_url: "https://gitlab.test/group/app/-/jobs/3",
          },
          {
            id: 4,
            name: "deploy",
            status: "failed",
            description: "Environment unavailable",
            target_url: null,
          },
          { id: 5, name: "lint", status: "success", target_url: null },
        ]),
      [`${gitlabProject}/jobs/3/trace`]: () =>
        new Response("$ pnpm test\nERROR: Job failed: exit code 1"),
    });
    const logs = await gitClient(
      { provider: "gitlab", apiUrl: gitlabApi, token: "secret" },
      fetch,
    ).failedCheckLogs("group/app", head);
    expect(logs).toEqual([
      {
        name: "test",
        url: "https://gitlab.test/group/app/-/jobs/3",
        log: "$ pnpm test\nERROR: Job failed: exit code 1",
      },
      { name: "deploy", url: null, log: "Environment unavailable" },
    ]);
    expect(
      calls.find((call) => call.url.endsWith("/jobs/3/trace"))!.authorization,
    ).toBe("Bearer secret");
  });
});
