export interface FakeCall {
  method: string;
  host: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

export interface FakeChange {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  updatedAt: string;
}

export const githubApiUrl = "https://api.github.test";
export const gitlabApiUrl = "https://gitlab.test/api/v4";
export const gitlabProject = "group/sub/app";

export function sha(seed: number): string {
  return seed.toString(16).padStart(40, "0");
}

export class FakeGitServer {
  readonly calls: FakeCall[] = [];
  readonly github = new Map<number, FakeChange>();
  readonly gitlab = new Map<number, FakeChange>();
  readonly logins = new Map<string, string>();
  readonly oauthGrants: {
    code?: string;
    refreshToken?: string;
    login: string;
    expiresIn?: number;
  }[] = [];
  private issued = 0;

  private oauthToken(body: Record<string, string>): Response {
    const grant = this.oauthGrants.find((entry) =>
      body.grant_type === "refresh_token"
        ? entry.refreshToken === body.refresh_token
        : entry.code === body.code,
    );
    if (!grant) return Response.json({ error: "invalid_grant" });
    const accessToken = `oauth-access-${++this.issued}`;
    const refreshToken = `oauth-refresh-${this.issued}`;
    this.logins.set(accessToken, grant.login);
    grant.refreshToken = refreshToken;
    grant.code = undefined;
    return Response.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(grant.expiresIn ? { expires_in: grant.expiresIn } : {}),
    });
  }
  private clock = Date.now() + 60_000;

  later(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  add(
    store: Map<number, FakeChange>,
    number: number,
    fields: Partial<FakeChange> & Pick<FakeChange, "headRef">,
  ): FakeChange {
    const change: FakeChange = {
      number,
      title: `Change ${number}`,
      body: "",
      state: "open",
      draft: false,
      author: "octo",
      headSha: sha(number),
      baseRef: "main",
      updatedAt: this.later(),
      ...fields,
    };
    store.set(number, change);
    return change;
  }

  update(change: FakeChange, fields: Partial<FakeChange>): void {
    Object.assign(change, fields, { updatedAt: this.later() });
  }

  callsTo(path: string | RegExp, method?: string): FakeCall[] {
    return this.calls.filter(
      (call) =>
        (typeof path === "string"
          ? call.path === path
          : path.test(call.path)) &&
        (!method || call.method === method),
    );
  }

  private githubPull(change: FakeChange) {
    return {
      number: change.number,
      title: change.title,
      body: change.body,
      html_url: `https://github.test/acme/app/pull/${change.number}`,
      state: change.state === "open" ? "open" : "closed",
      draft: change.draft,
      merged_at: change.state === "merged" ? change.updatedAt : null,
      user: { login: change.author },
      head: { ref: change.headRef, sha: change.headSha },
      base: { ref: change.baseRef },
      mergeable: true,
      mergeable_state: "clean",
      updated_at: change.updatedAt,
    };
  }

  private gitlabRequest(change: FakeChange) {
    return {
      iid: change.number,
      title: change.title,
      description: change.body,
      web_url: `https://gitlab.test/${gitlabProject}/-/merge_requests/${change.number}`,
      state: change.state === "open" ? "opened" : change.state,
      draft: change.draft,
      author: { username: change.author },
      source_branch: change.headRef,
      target_branch: change.baseRef,
      sha: change.headSha,
      detailed_merge_status: "mergeable",
      has_conflicts: false,
      changes_count: "2",
      updated_at: change.updatedAt,
      merged_at: change.state === "merged" ? change.updatedAt : null,
    };
  }

  private sorted(store: Map<number, FakeChange>) {
    return [...store.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private handleGitHub(method: string, path: string, body: unknown): Response {
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status });
    if (path === "/repos/acme/app")
      return json({
        id: 7,
        full_name: "acme/app",
        private: true,
        default_branch: "main",
        html_url: "https://github.test/acme/app",
      });
    if (path === "/repos/acme/app/hooks" && method === "POST")
      return json({ id: 99 }, 201);
    if (path === "/repos/acme/app/pulls")
      return json(
        this.sorted(this.github).map((change) => this.githubPull(change)),
      );
    if (/^\/repos\/acme\/app\/commits\/[0-9a-f]{40}\/check-runs$/u.test(path))
      return json({
        check_runs: [
          { name: "unit", status: "completed", conclusion: "success" },
        ],
      });
    const comment = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/u.exec(path);
    if (comment && method === "POST")
      return json(
        {
          id: 1,
          html_url: `https://github.test/acme/app/pull/${comment[1]}#issuecomment-1`,
        },
        201,
      );
    const match = /^\/repos\/acme\/app\/pulls\/(\d+)(?:\/([\w-]+))?$/u.exec(
      path,
    );
    const change = match ? this.github.get(Number(match[1])) : undefined;
    if (!match || !change) return json({ message: "Not Found" }, 404);
    if (!match[2] && method === "PATCH") {
      this.update(change, { baseRef: (body as { base: string }).base });
      return json({ number: change.number });
    }
    if (!match[2]) return json(this.githubPull(change));
    if (match[2] === "merge") {
      this.update(change, { state: "merged" });
      return json({ merged: true });
    }
    if (match[2] === "reviews" && method === "POST") return json({ id: 3 });
    if (match[2] === "reviews" || match[2] === "comments") return json([]);
    return json({ message: "Not Found" }, 404);
  }

  private handleGitLab(method: string, path: string): Response {
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status });
    const project = `/api/v4/projects/${encodeURIComponent(gitlabProject)}`;
    if (path === project)
      return json({
        id: 42,
        path_with_namespace: gitlabProject,
        visibility: "private",
        default_branch: "main",
        web_url: `https://gitlab.test/${gitlabProject}`,
      });
    if (path === `${project}/hooks` && method === "POST")
      return json({ id: 77 }, 201);
    if (path === `${project}/merge_requests`)
      return json(
        this.sorted(this.gitlab).map((change) => this.gitlabRequest(change)),
      );
    if (path.startsWith(`${project}/repository/commits/`))
      return json([
        { id: 1, name: "test", status: "success", target_url: null },
      ]);
    const match = new RegExp(
      `^${project}/merge_requests/(\\d+)(?:/([\\w-]+))?$`,
      "u",
    ).exec(path);
    const change = match ? this.gitlab.get(Number(match[1])) : undefined;
    if (!match || !change) return json({ message: "404 Not Found" }, 404);
    if (!match[2]) return json(this.gitlabRequest(change));
    if (match[2] === "approvals") return json({ approved_by: [] });
    if (match[2] === "reviewers" || match[2] === "discussions") return json([]);
    if (match[2] === "merge") {
      this.update(change, { state: "merged" });
      return json({ iid: change.number });
    }
    if (match[2] === "notes" && method === "POST") return json({ id: 5 }, 201);
    return json({ message: "404 Not Found" }, 404);
  }

  readonly transport = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    const authorization = new Headers(init?.headers).get("authorization");
    this.calls.push({
      method,
      host: url.host,
      path: url.pathname,
      body,
      authorization,
    });
    const token = authorization?.replace(/^Bearer /u, "") ?? "";
    if (
      method === "POST" &&
      ["/login/oauth/access_token", "/oauth/token"].includes(url.pathname)
    )
      return this.oauthToken(body as Record<string, string>);
    if (url.pathname === "/user" || url.pathname === "/api/v4/user") {
      const login = this.logins.get(token);
      if (!login)
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      return Response.json(
        url.host === "gitlab.test" ? { username: login } : { login },
      );
    }
    return url.host === "gitlab.test"
      ? this.handleGitLab(method, url.pathname)
      : this.handleGitHub(method, url.pathname, body);
  }) as typeof fetch;
}
