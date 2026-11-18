import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative } from "node:path";
const identity = {
  GIT_AUTHOR_NAME: "Local GitHub",
  GIT_AUTHOR_EMAIL: "github@local.test",
  GIT_COMMITTER_NAME: "Local GitHub",
  GIT_COMMITTER_EMAIL: "github@local.test",
};

export interface LocalRepositorySeed {
  fullName: string;
  source: string;
  sourcePath: string;
}

interface Review {
  id: number;
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  commitId: string;
  submittedAt: string;
}

interface Comment {
  id: number;
  login: string;
  body: string;
  createdAt: string;
}

interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  author: string;
  state: "open" | "closed" | "merged";
  headSha: string;
  mergeBase: string | null;
  mergeable: boolean;
  updatedAt: string;
  createdAt: string;
  mergedAt: string | null;
  reviews: Review[];
  comments: Comment[];
}

interface Repository {
  id: number;
  fullName: string;
  bare: string;
  work: string;
  pulls: Pull[];
  statuses: Map<
    string,
    {
      context: string;
      state: string;
      description: string;
      target_url: string | null;
    }[]
  >;
}

export interface LocalGitHub {
  apiUrl: string;
  origin: string;
  webUrl(fullName: string): string;
  barePath(fullName: string): string;
  rewrite(url: string): string;
  commit(
    fullName: string,
    branch: string,
    message: string,
    files: Record<string, (content: string) => string>,
  ): Promise<string>;
  readFile(fullName: string, ref: string, path: string): Promise<string>;
  pulls(fullName: string): Pull[];
  close(): Promise<void>;
}

async function git(directory: string, args: string[], input?: string) {
  const child = execFile("git", ["-C", directory, ...args], {
    env: { ...process.env, ...identity },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (input !== undefined) child.stdin?.end(input);
  return new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 || code === 1
        ? resolve({ stdout, code })
        : reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`)),
    );
  });
}

async function revParse(bare: string, ref: string): Promise<string | null> {
  const result = await git(bare, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  ]);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function strict(directory: string, args: string[]): Promise<string> {
  const result = await git(directory, args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} exited with 1`);
  return result.stdout;
}

function now(): string {
  return new Date().toISOString();
}

function escape(text: string): string {
  return text.replace(
    /[&<>"]/gu,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startLocalGitHub(options: {
  directory: string;
  tokens: Record<string, string>;
  repositories: LocalRepositorySeed[];
}): Promise<LocalGitHub> {
  await rm(options.directory, { recursive: true, force: true });
  const root = join(options.directory, "git");
  await mkdir(root, { recursive: true });
  const repositories = new Map<string, Repository>();
  let nextId = 1000;
  for (const seed of options.repositories) {
    const bare = join(root, `${seed.fullName}.git`);
    const work = join(options.directory, "work", seed.fullName);
    await mkdir(bare, { recursive: true });
    await mkdir(work, { recursive: true });
    await strict(bare, ["init", "--bare", "-q", "-b", "main"]);
    for (const [key, value] of [
      ["http.receivepack", "true"],
      ["uploadpack.allowFilter", "true"],
      ["uploadpack.allowAnySHA1InWant", "true"],
    ])
      await strict(bare, ["config", key, value]);
    const tracked = (
      await strict(seed.source, ["ls-files", "-z", seed.sourcePath])
    )
      .split("\0")
      .filter(Boolean);
    for (const file of tracked) {
      const target = join(work, relative(seed.sourcePath, file));
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(seed.source, file), target);
    }
    await strict(work, ["init", "-q", "-b", "main"]);
    await strict(work, ["add", "-A"]);
    await strict(work, [
      "commit",
      "-q",
      "-m",
      `Import ${seed.sourcePath} from machdoch`,
    ]);
    await strict(work, ["remote", "add", "origin", bare]);
    await strict(work, ["push", "-q", "origin", "main"]);
    repositories.set(seed.fullName.toLowerCase(), {
      id: nextId++,
      fullName: seed.fullName,
      bare,
      work,
      pulls: [],
      statuses: new Map(),
    });
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent)
        response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const apiUrl = `${origin}/api/v3`;
  let sequence = 1;

  function repository(fullName: string): Repository {
    const found = repositories.get(fullName.toLowerCase());
    if (!found) throw Object.assign(new Error("Not Found"), { status: 404 });
    return found;
  }

  async function refreshPull(repo: Repository, pull: Pull): Promise<Pull> {
    if (pull.state !== "open") return pull;
    const head = await revParse(repo.bare, `refs/heads/${pull.head}`);
    const base = await revParse(repo.bare, `refs/heads/${pull.base}`);
    if (!head || !base) return pull;
    const merged = await git(repo.bare, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      base,
      head,
    ]);
    const mergeable = merged.code === 0;
    if (head !== pull.headSha || mergeable !== pull.mergeable) {
      pull.headSha = head;
      pull.mergeable = mergeable;
      pull.updatedAt = now();
    }
    pull.mergeBase = (
      await strict(repo.bare, ["merge-base", base, head])
    ).trim();
    return pull;
  }

  async function numstat(repo: Repository, pull: Pull) {
    if (!pull.mergeBase) return [];
    const output = await strict(repo.bare, [
      "diff",
      "--numstat",
      pull.mergeBase,
      pull.headSha,
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [additions, deletions, filename] = line.split("\t");
        return {
          filename: filename!,
          additions: Number(additions) || 0,
          deletions: Number(deletions) || 0,
        };
      });
  }

  async function pullJson(repo: Repository, pull: Pull) {
    await refreshPull(repo, pull);
    const files = await numstat(repo, pull);
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      html_url: `${origin}/${repo.fullName}/pull/${pull.number}`,
      state: pull.state === "open" ? "open" : "closed",
      draft: false,
      merged: pull.state === "merged",
      merged_at: pull.mergedAt,
      user: { login: pull.author },
      head: { ref: pull.head, sha: pull.headSha },
      base: { ref: pull.base },
      mergeable: pull.state === "open" ? pull.mergeable : null,
      mergeable_state:
        pull.state !== "open" ? "unknown" : pull.mergeable ? "clean" : "dirty",
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      changed_files: files.length,
      updated_at: pull.updatedAt,
      created_at: pull.createdAt,
      requested_reviewers: [],
    };
  }

  async function pullFiles(repo: Repository, pull: Pull) {
    const files = await numstat(repo, pull);
    const statuses = new Map(
      (
        await strict(repo.bare, [
          "diff",
          "--name-status",
          pull.mergeBase!,
          pull.headSha,
        ])
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [status, filename] = line.split("\t");
          return [filename!, status!] as const;
        }),
    );
    return Promise.all(
      files.map(async (file) => {
        const diff = await strict(repo.bare, [
          "diff",
          pull.mergeBase!,
          pull.headSha,
          "--",
          file.filename,
        ]);
        const hunk = diff.indexOf("\n@@");
        const status = statuses.get(file.filename);
        return {
          ...file,
          status:
            status === "A" ? "added" : status === "D" ? "removed" : "modified",
          patch: hunk >= 0 ? diff.slice(hunk + 1).trimEnd() : undefined,
        };
      }),
    );
  }

  async function mergePull(
    repo: Repository,
    pull: Pull,
    method: string,
    sha: string | undefined,
  ) {
    await refreshPull(repo, pull);
    if (pull.state !== "open")
      return { status: 405, value: { message: "Pull Request is not open" } };
    if (sha && sha !== pull.headSha)
      return { status: 409, value: { message: "Head branch was modified." } };
    const base = (await revParse(repo.bare, `refs/heads/${pull.base}`))!;
    const merged = await git(repo.bare, [
      "merge-tree",
      "--write-tree",
      base,
      pull.headSha,
    ]);
    if (merged.code !== 0)
      return {
        status: 405,
        value: { message: "Pull Request is not mergeable" },
      };
    const tree = merged.stdout.split("\n")[0]!.trim();
    const parents =
      method === "merge" ? ["-p", base, "-p", pull.headSha] : ["-p", base];
    const commit = (
      await strict(repo.bare, [
        "commit-tree",
        tree,
        ...parents,
        "-m",
        `${pull.title} (#${pull.number})\n\n${pull.body}`,
      ])
    ).trim();
    await strict(repo.bare, [
      "update-ref",
      `refs/heads/${pull.base}`,
      commit,
      base,
    ]);
    pull.state = "merged";
    pull.mergedAt = now();
    pull.updatedAt = pull.mergedAt;
    return {
      status: 200,
      value: {
        merged: true,
        sha: commit,
        message: "Pull Request successfully merged",
      },
    };
  }

  async function updateBranch(repo: Repository, pull: Pull) {
    const base = (await revParse(repo.bare, `refs/heads/${pull.base}`))!;
    const merged = await git(repo.bare, [
      "merge-tree",
      "--write-tree",
      pull.headSha,
      base,
    ]);
    if (merged.code !== 0)
      return {
        status: 422,
        value: { message: "merge conflict between base and head" },
      };
    const tree = merged.stdout.split("\n")[0]!.trim();
    const commit = (
      await strict(repo.bare, [
        "commit-tree",
        tree,
        "-p",
        pull.headSha,
        "-p",
        base,
        "-m",
        `Merge branch '${pull.base}' into ${pull.head}`,
      ])
    ).trim();
    await strict(repo.bare, [
      "update-ref",
      `refs/heads/${pull.head}`,
      commit,
      pull.headSha,
    ]);
    await refreshPull(repo, pull);
    return { status: 202, value: { message: "Updating pull request branch." } };
  }

  async function serveGit(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    query: string,
  ) {
    const input = await body(request);
    const child = spawn("git", ["http-backend"], {
      windowsHide: true,
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: path,
        QUERY_STRING: query,
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(input.length),
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
        GIT_PROTOCOL: request.headers["git-protocol"]?.toString() ?? "",
        REMOTE_USER: "local",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    child.stdin.end(input);
    const chunks: Buffer[] = [];
    for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
    const output = Buffer.concat(chunks);
    const split = output.indexOf("\r\n\r\n");
    const headerText = output.subarray(0, split).toString("latin1");
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of headerText.split("\r\n")) {
      const index = line.indexOf(":");
      const name = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    const payload = output.subarray(split + 4);
    response.writeHead(status, {
      ...headers,
      "Content-Length": String(payload.length),
    });
    response.end(payload);
  }

  async function page(response: ServerResponse, repo: Repository, pull: Pull) {
    await refreshPull(repo, pull);
    const files = pull.mergeBase ? await pullFiles(repo, pull) : [];
    const timeline = [
      ...pull.reviews.map((review) => ({
        at: review.submittedAt,
        html: `<b>${escape(review.login)}</b> ${review.state.toLowerCase().replace("_", " ")}<pre>${escape(review.body.replace("<!-- machdoch-automation -->", "").trim())}</pre>`,
      })),
      ...pull.comments.map((comment) => ({
        at: comment.createdAt,
        html: `<b>${escape(comment.login)}</b> commented<pre>${escape(comment.body.replace("<!-- machdoch-automation -->", "").trim())}</pre>`,
      })),
    ].sort((left, right) => left.at.localeCompare(right.at));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>${escape(pull.title)} · #${pull.number}</title>
<style>body{font:14px system-ui;margin:32px auto;max-width:960px;color:#1f2328}pre{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:6px}.state{display:inline-block;padding:4px 10px;border-radius:999px;color:#fff;background:${pull.state === "merged" ? "#8250df" : pull.state === "open" ? "#1a7f37" : "#cf222e"}}li{margin:12px 0}</style>
<p>${escape(repo.fullName)}</p><h1>${escape(pull.title)} <small>#${pull.number}</small></h1>
<p><span class="state">${pull.state}</span> ${escape(pull.author)} wants to merge <code>${escape(pull.head)}</code> into <code>${escape(pull.base)}</code></p>
<pre>${escape(pull.body)}</pre><h2>Conversation</h2><ul>${timeline.map((entry) => `<li>${entry.html}</li>`).join("")}</ul>
<h2>Files changed</h2>${files.map((file) => `<h3>${escape(file.filename)}</h3><pre>${escape(file.patch ?? "")}</pre>`).join("")}`);
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const gitPath = /^(\/[^/]+\/[^/]+\.git)(\/.*)$/u.exec(url.pathname);
    if (gitPath)
      return serveGit(request, response, url.pathname, url.search.slice(1));
    const web = /^\/([^/]+\/[^/]+)\/pull\/(\d+)$/u.exec(url.pathname);
    if (web) {
      const repo = repository(web[1]!);
      const pull = repo.pulls.find((entry) => entry.number === Number(web[2]));
      if (!pull) return json({ message: "Not Found" }, 404);
      return page(response, repo, pull);
    }
    if (!url.pathname.startsWith("/api/v3/"))
      return json({ message: "Not Found" }, 404);
    const path = url.pathname.slice("/api/v3".length);
    const token = (request.headers.authorization ?? "").replace(
      /^Bearer /u,
      "",
    );
    const login = options.tokens[token];
    if (!login) return json({ message: "Bad credentials" }, 401);
    const raw = await body(request);
    const input = raw.length
      ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>)
      : {};
    if (path === "/user") return json({ login });
    const repoJson = (repo: Repository) => ({
      id: repo.id,
      full_name: repo.fullName,
      private: true,
      default_branch: "main",
      html_url: `https://github.com/${repo.fullName}`,
    });
    if (path === "/user/repos")
      return json([...repositories.values()].map(repoJson));
    const match = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/u.exec(path);
    if (!match) return json({ message: "Not Found" }, 404);
    let repo: Repository;
    try {
      repo = repository(match[1]!);
    } catch {
      return json({ message: "Not Found" }, 404);
    }
    const rest = match[2] ?? "";
    if (!rest) return json(repoJson(repo));
    if (rest === "/hooks" && method === "POST")
      return json({ id: sequence++ }, 201);
    if (/^\/hooks\/\d+$/u.test(rest))
      return method === "DELETE"
        ? json(null, 204)
        : json({ id: Number(rest.split("/")[2]) });
    if (rest === "/pulls" && method === "GET") {
      const pulls = await Promise.all(
        repo.pulls.map((pull) => pullJson(repo, pull)),
      );
      return json(
        pulls.sort((left, right) =>
          right.updated_at.localeCompare(left.updated_at),
        ),
      );
    }
    if (rest === "/pulls" && method === "POST") {
      const head = String(input.head);
      const headSha = await revParse(repo.bare, `refs/heads/${head}`);
      if (!headSha)
        return json(
          {
            message: "Validation Failed",
            errors: [{ field: "head", code: "invalid" }],
          },
          422,
        );
      const pull: Pull = {
        number: repo.pulls.length + 1,
        title: String(input.title),
        body: String(input.body ?? ""),
        head,
        base: String(input.base),
        author: login,
        state: "open",
        headSha,
        mergeBase: null,
        mergeable: true,
        updatedAt: now(),
        createdAt: now(),
        mergedAt: null,
        reviews: [],
        comments: [],
      };
      repo.pulls.push(pull);
      return json(await pullJson(repo, pull), 201);
    }
    const statusPost = /^\/statuses\/([0-9a-f]{40})$/u.exec(rest);
    if (statusPost && method === "POST") {
      const posted = {
        context: String(input.context),
        state: String(input.state),
        description: String(input.description ?? ""),
        target_url: (input.target_url as string | null) ?? null,
      };
      repo.statuses.set(statusPost[1]!, [
        ...(repo.statuses.get(statusPost[1]!) ?? []).filter(
          (entry) => entry.context !== posted.context,
        ),
        posted,
      ]);
      return json({ id: sequence++ }, 201);
    }
    const combined = /^\/commits\/([0-9a-f]{40})\/status$/u.exec(rest);
    if (combined)
      return json({ statuses: repo.statuses.get(combined[1]!) ?? [] });
    if (/^\/commits\/[0-9a-f]{40}\/check-runs$/u.test(rest))
      return json({ check_runs: [] });
    const compare = /^\/compare\/(.+)\.\.\.([0-9a-f]{40})$/u.exec(rest);
    if (compare) {
      const base = await revParse(
        repo.bare,
        `refs/heads/${decodeURIComponent(compare[1]!)}`,
      );
      if (!base) return json({ message: "Not Found" }, 404);
      return json({
        base_commit: { sha: base },
        merge_base_commit: {
          sha: (
            await strict(repo.bare, ["merge-base", base, compare[2]!])
          ).trim(),
        },
      });
    }
    const contents = /^\/contents\/(.+)$/u.exec(rest);
    if (contents) {
      const ref = url.searchParams.get("ref") ?? "main";
      const file = await git(repo.bare, [
        "show",
        `${ref}:${decodeURIComponent(contents[1]!)}`,
      ]);
      return file.code === 0
        ? json({
            content: Buffer.from(file.stdout).toString("base64"),
            encoding: "base64",
          })
        : json({ message: "Not Found" }, 404);
    }
    const ref = /^\/git\/refs\/heads\/(.+)$/u.exec(rest);
    if (ref && method === "DELETE") {
      await git(repo.bare, [
        "update-ref",
        "-d",
        `refs/heads/${decodeURIComponent(ref[1]!)}`,
      ]);
      return json(null, 204);
    }
    const issueComments = /^\/issues\/(\d+)\/comments$/u.exec(rest);
    const pullMatch = /^\/pulls\/(\d+)(?:\/([\w-]+))?$/u.exec(rest);
    const number = Number(issueComments?.[1] ?? pullMatch?.[1]);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return json({ message: "Not Found" }, 404);
    const htmlUrl = `${origin}/${repo.fullName}/pull/${pull.number}`;
    if (issueComments && method === "POST") {
      const comment = {
        id: sequence++,
        login,
        body: String(input.body),
        createdAt: now(),
      };
      pull.comments.push(comment);
      pull.updatedAt = comment.createdAt;
      return json(
        { id: comment.id, html_url: `${htmlUrl}#issuecomment-${comment.id}` },
        201,
      );
    }
    if (issueComments)
      return json(
        pull.comments.map((comment) => ({
          id: comment.id,
          user: { login: comment.login },
          body: comment.body,
          html_url: `${htmlUrl}#issuecomment-${comment.id}`,
          created_at: comment.createdAt,
        })),
      );
    const action = pullMatch![2];
    if (!action && method === "PATCH") {
      if (input.state === "closed") pull.state = "closed";
      if (typeof input.base === "string") pull.base = input.base;
      pull.updatedAt = now();
      return json(await pullJson(repo, pull));
    }
    if (!action) return json(await pullJson(repo, pull));
    if (action === "merge" && method === "PUT") {
      const result = await mergePull(
        repo,
        pull,
        String(input.merge_method ?? "squash"),
        input.sha as string | undefined,
      );
      return json(result.value, result.status);
    }
    if (action === "update-branch" && method === "PUT") {
      const result = await updateBranch(repo, pull);
      return json(result.value, result.status);
    }
    await refreshPull(repo, pull);
    if (action === "files")
      return json(pull.mergeBase ? await pullFiles(repo, pull) : []);
    if (action === "commits") {
      if (!pull.mergeBase) return json([]);
      const log = await strict(repo.bare, [
        "log",
        "--reverse",
        "--format=%H%x1f%an%x1f%aI%x1f%B%x1e",
        `${pull.mergeBase}..${pull.headSha}`,
      ]);
      return json(
        log
          .split("\x1e")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const [sha, name, date, message] = entry.split("\x1f");
            return {
              sha,
              html_url: null,
              author: null,
              commit: { message: message!.trim(), author: { name, date } },
            };
          }),
      );
    }
    if (action === "reviews" && method === "POST") {
      const events = {
        APPROVE: "APPROVED",
        REQUEST_CHANGES: "CHANGES_REQUESTED",
        COMMENT: "COMMENTED",
      } as const;
      const review: Review = {
        id: sequence++,
        login,
        state:
          events[String(input.event) as keyof typeof events] ?? "COMMENTED",
        body: String(input.body ?? ""),
        commitId: String(input.commit_id ?? pull.headSha),
        submittedAt: now(),
      };
      pull.reviews.push(review);
      pull.updatedAt = review.submittedAt;
      return json({ id: review.id });
    }
    if (action === "reviews")
      return json(
        pull.reviews.map((review) => ({
          id: review.id,
          user: { login: review.login },
          state: review.state,
          body: review.body,
          html_url: `${htmlUrl}#pullrequestreview-${review.id}`,
          submitted_at: review.submittedAt,
        })),
      );
    if (action === "comments") return json([]);
    return json({ message: "Not Found" }, 404);
  }

  return {
    apiUrl,
    origin,
    webUrl: (fullName) => `https://github.com/${fullName}`,
    barePath: (fullName) => repository(fullName).bare,
    rewrite: (url) => url.replace(/^https:\/\/github\.com\//u, `${origin}/`),
    async commit(fullName, branch, message, files) {
      const repo = repository(fullName);
      const exists = await revParse(repo.bare, `refs/heads/${branch}`);
      await strict(repo.work, [
        "fetch",
        "-q",
        "origin",
        exists ? branch : "main",
      ]);
      await strict(repo.work, ["checkout", "-q", "-B", branch, "FETCH_HEAD"]);
      for (const [path, edit] of Object.entries(files)) {
        const current = (await git(repo.work, ["show", `HEAD:${path}`])).stdout;
        await writeFile(join(repo.work, path), edit(current));
      }
      await strict(repo.work, ["commit", "-q", "-am", message]);
      await strict(repo.work, [
        "push",
        "-q",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
      return (await strict(repo.work, ["rev-parse", "HEAD"])).trim();
    },
    async readFile(fullName, ref, path) {
      return strict(repository(fullName).bare, ["show", `${ref}:${path}`]);
    },
    pulls: (fullName) => repository(fullName).pulls,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
