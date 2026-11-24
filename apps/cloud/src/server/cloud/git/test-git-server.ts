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
  mergeable: boolean;
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
  readonly revoked = new Set<string>();
  readonly gitlabUsers = new Map<string, number>();
  readonly deletedComments = new Set<string>();
  readonly branches = new Map<string, string>();
  readonly files = new Map<string, string>();
  readonly statuses = new Map<
    string,
    { context: string; state: string; description: string }[]
  >();
  readonly pullFiles = new Map<
    number,
    {
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string;
    }[]
  >();
  readonly comparisons = new Map<
    string,
    { commits: { sha: string; message: string }[]; files: string[] }
  >();
  readonly branchRules: unknown[] = [];
  readonly checkRuns = new Map<
    string,
    {
      id?: number;
      name: string;
      status: string;
      conclusion: string | null;
      app?: { slug: string };
      output?: { title?: string; summary?: string; text?: string };
    }[]
  >();
  readonly jobLogs = new Map<number, string>();
  readonly reviewComments = new Map<
    number,
    { author: string; body: string; path: string; line: number }[]
  >();
  readonly reviews = new Map<number, { login: string; state: string }[]>();
  readonly teams = new Map<string, string[]>();
  readonly mergeQueue = new Set<number>();
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
      mergeable: true,
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
      mergeable: change.mergeable,
      mergeable_state: change.mergeable ? "clean" : "dirty",
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
      detailed_merge_status: change.mergeable ? "mergeable" : "conflict",
      has_conflicts: !change.mergeable,
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

  private githubGraphql(body: unknown): Response {
    const request = body as {
      query: string;
      variables: { number?: number; id?: string };
    };
    if (request.query.startsWith("mutation")) {
      this.mergeQueue.add(Number(request.variables.id!.replace("PR_", "")));
      return Response.json({
        data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_1" } } },
      });
    }
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            id: `PR_${request.variables.number}`,
            isInMergeQueue: this.mergeQueue.has(request.variables.number!),
          },
        },
      },
    });
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
    if (path === "/repos/acme/app/pulls" && method === "POST") {
      const draft = body as {
        title: string;
        body: string;
        head: string;
        base: string;
      };
      const number = Math.max(0, ...this.github.keys()) + 1;
      return json(
        this.githubPull(
          this.add(this.github, number, {
            title: draft.title,
            body: draft.body,
            headRef: draft.head,
            baseRef: draft.base,
            author: "acme-bot",
            headSha: this.branches.get(draft.head) ?? sha(number),
          }),
        ),
        201,
      );
    }
    if (path === "/repos/acme/app/pulls")
      return json(
        this.sorted(this.github).map((change) => this.githubPull(change)),
      );
    const branch = /^\/repos\/acme\/app\/git\/refs\/heads\/(.+)$/u.exec(path);
    if (branch && method === "DELETE") {
      this.branches.delete(decodeURIComponent(branch[1]!));
      return new Response(null, { status: 204 });
    }
    const file = /^\/repos\/acme\/app\/contents\/(.+)$/u.exec(path);
    if (file) {
      const content = this.files.get(decodeURIComponent(file[1]!));
      return content === undefined
        ? json({ message: "Not Found" }, 404)
        : json({
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          });
    }
    if (/^\/repos\/acme\/app\/commits\/[0-9a-f]{40}\/check-runs$/u.test(path))
      return json({
        check_runs: (
          this.checkRuns.get(path.split("/")[5]!) ?? [
            { name: "unit", status: "completed", conclusion: "success" },
          ]
        ).map((run, index) => ({ id: index + 1, ...run })),
      });
    const jobLog = /^\/repos\/acme\/app\/actions\/jobs\/(\d+)\/logs$/u.exec(
      path,
    );
    if (jobLog)
      return this.jobLogs.has(Number(jobLog[1]))
        ? new Response(null, {
            status: 302,
            headers: { location: `https://logs.github.test/jobs/${jobLog[1]}` },
          })
        : json({ message: "Not Found" }, 404);
    if (path === "/repos/acme/app/rules/branches/main")
      return json(this.branchRules);
    if (path === "/repos/acme/app/branches/main")
      return json({ name: "main", protected: false });
    const team = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/members$/u.exec(path);
    if (team)
      return json(
        (this.teams.get(`${team[1]}/${team[2]}`) ?? []).map((login) => ({
          login,
        })),
      );
    if (path === "/graphql" && method === "POST")
      return this.githubGraphql(body);
    const compare =
      /^\/repos\/acme\/app\/compare\/([^.]+)\.\.\.([0-9a-f]{40})$/u.exec(path);
    if (compare) {
      const comparison = this.comparisons.get(`${compare[1]}...${compare[2]}`);
      return json({
        base_commit: {
          sha: this.branches.get(decodeURIComponent(compare[1]!)) ?? sha(1),
        },
        merge_base_commit: { sha: sha(2) },
        commits: (comparison?.commits ?? []).map((commit) => ({
          sha: commit.sha,
          commit: { message: commit.message },
        })),
        files: (comparison?.files ?? []).map((filename) => ({ filename })),
      });
    }
    const combined =
      /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/status$/u.exec(path);
    if (combined)
      return json({ statuses: this.statuses.get(combined[1]!) ?? [] });
    const status = /^\/repos\/acme\/app\/statuses\/([0-9a-f]{40})$/u.exec(path);
    if (status && method === "POST") {
      const draft = body as {
        state: string;
        context: string;
        description: string;
      };
      const existing = (this.statuses.get(status[1]!) ?? []).filter(
        (entry) => entry.context !== draft.context,
      );
      this.statuses.set(status[1]!, [...existing, draft]);
      return json({ id: existing.length + 1 }, 201);
    }
    const comment = /^\/repos\/acme\/app\/issues\/(\d+)\/comments$/u.exec(path);
    if (comment && method === "GET") return json([]);
    if (comment && method === "POST") {
      const id = this.callsTo(path, "POST").length;
      return json(
        {
          id,
          html_url: `https://github.test/acme/app/pull/${comment[1]}#issuecomment-${id}`,
        },
        201,
      );
    }
    const editedComment = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/u.exec(
      path,
    );
    if (editedComment && method === "PATCH")
      return this.deletedComments.has(editedComment[1]!)
        ? json({ message: "Not Found" }, 404)
        : json({ id: Number(editedComment[1]) });
    if (/^\/repos\/acme\/app\/issues\/\d+$/u.test(path) && method === "PATCH")
      return json({ number: Number(path.split("/").at(-1)) });
    if (/^\/repos\/acme\/app\/issues\/\d+\/labels(?:\/.+)?$/u.test(path))
      return json([]);
    const match = /^\/repos\/acme\/app\/pulls\/(\d+)(?:\/([\w-]+))?$/u.exec(
      path,
    );
    const change = match ? this.github.get(Number(match[1])) : undefined;
    if (!match || !change) return json({ message: "Not Found" }, 404);
    if (!match[2] && method === "PATCH") {
      const patch = body as { base?: string; state?: "closed" };
      this.update(
        change,
        patch.state ? { state: patch.state } : { baseRef: patch.base! },
      );
      return json({ number: change.number });
    }
    if (!match[2]) return json(this.githubPull(change));
    if (match[2] === "merge") {
      this.update(change, { state: "merged" });
      return json({ merged: true });
    }
    if (match[2] === "files")
      return json(this.pullFiles.get(change.number) ?? []);
    if (match[2] === "reviews" && method === "POST") return json({ id: 3 });
    if (match[2] === "reviews")
      return json(
        (this.reviews.get(change.number) ?? []).map((review, index) => ({
          id: index + 1,
          user: { login: review.login },
          state: review.state,
          body: "",
          submitted_at: this.later(),
        })),
      );
    if (match[2] === "comments")
      return json(
        (this.reviewComments.get(change.number) ?? []).map(
          (comment, index) => ({
            id: index + 1,
            user: { login: comment.author },
            body: comment.body,
            path: comment.path,
            line: comment.line,
            diff_hunk: "@@ -1 +1 @@",
            html_url: `https://github.test/acme/app/pull/${change.number}#discussion_r${index + 1}`,
            created_at: this.later(),
          }),
        ),
      );
    if (match[2] === "commits") return json([]);
    return json({ message: "Not Found" }, 404);
  }

  private handleGitLab(
    method: string,
    path: string,
    query: URLSearchParams,
  ): Response {
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status });
    const project = `/api/v4/projects/${encodeURIComponent(gitlabProject)}`;
    if (path === `${project}/repository/compare`) {
      const comparison = this.comparisons.get(
        `${query.get("from")}...${query.get("to")}`,
      );
      return json({
        commits: (comparison?.commits ?? []).map((commit) => ({
          id: commit.sha,
          title: commit.message.split("\n")[0],
          message: commit.message,
          author_name: "octo",
        })),
        diffs: (comparison?.files ?? []).map((file) => ({ new_path: file })),
      });
    }
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
    if (path.startsWith(`${project}/statuses/`) && method === "POST")
      return json({ id: 9 }, 201);
    if (path === "/api/v4/users")
      return json(
        this.gitlabUsers.has(query.get("username") ?? "")
          ? [{ id: this.gitlabUsers.get(query.get("username")!) }]
          : [],
      );
    const issue = new RegExp(`^${project}/issues/(\\d+)(/notes)?$`, "u").exec(
      path,
    );
    if (issue && !issue[2] && method === "PUT")
      return json({ iid: Number(issue[1]) });
    if (issue?.[2] && method === "POST")
      return json({ id: 500 + this.callsTo(path, "POST").length }, 201);
    const editedNote = new RegExp(
      `^${project}/merge_requests/\\d+/notes/(\\d+)$`,
      "u",
    ).exec(path);
    if (editedNote && method === "PUT")
      return this.deletedComments.has(editedNote[1]!)
        ? json({ message: "404 Not Found" }, 404)
        : json({ id: Number(editedNote[1]) });
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
    if (match[2] === "notes" || match[2] === "commits") return json([]);
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
    if (this.revoked.has(token))
      return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.host === "logs.github.test")
      return new Response(
        this.jobLogs.get(Number(url.pathname.split("/").at(-1))) ?? "",
      );
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
      ? this.handleGitLab(method, url.pathname, url.searchParams)
      : this.handleGitHub(method, url.pathname, body);
  }) as typeof fetch;
}
