import { createServer } from "node:http";

const repository = "northstar/cloud-workspace";
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const sha = (seed) => seed.toString(16).padStart(2, "0").repeat(20);
const owner = "alex-morgan";

const pulls = [
  {
    number: 41,
    title: "ENG-1 Reconnect clients after an interrupted session",
    body: "Closes ENG-1.\n\nRetries the websocket with backoff and restores the selected workspace.\n\n- Keeps pending edits in memory\n- Shows a reconnect banner after 5 s",
    user: owner,
    head: "alex/eng-1-reconnect",
    draft: false,
    state: "open",
    reviewers: ["sam-lee"],
    additions: 182,
    deletions: 37,
    files: 4,
    updated: 12,
    checks: "success",
  },
  {
    number: 42,
    title: "ENG-2 Add project context to agent handoffs",
    body: "Part of ENG-2.",
    user: "sam-lee",
    head: "sam/eng-2-context",
    draft: false,
    state: "open",
    reviewers: [owner],
    additions: 96,
    deletions: 12,
    files: 3,
    updated: 45,
    checks: "pending",
  },
  {
    number: 43,
    title: "ENG-3 Review changes before applying a patch",
    body: "Closes ENG-3.",
    user: owner,
    head: "alex/eng-3-review",
    draft: true,
    state: "open",
    reviewers: [],
    additions: 40,
    deletions: 4,
    files: 2,
    updated: 90,
    checks: "success",
  },
  {
    number: 39,
    title: "ENG-4 Keep issue filters when switching views",
    body: "Closes ENG-4.",
    user: owner,
    head: "alex/eng-4-filters",
    draft: false,
    state: "merged",
    reviewers: [],
    additions: 64,
    deletions: 21,
    files: 2,
    updated: 600,
    checks: "success",
  },
  {
    number: 44,
    title: "ENG-6 Show live execution progress",
    body: "Closes ENG-6.",
    user: owner,
    head: "alex/eng-6-progress",
    draft: false,
    state: "open",
    reviewers: ["riley-chen"],
    additions: 210,
    deletions: 58,
    files: 6,
    updated: 30,
    checks: "failure",
  },
];

function pullJson(pull) {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    html_url: `https://github.com/${repository}/pull/${pull.number}`,
    state: pull.state === "open" ? "open" : "closed",
    draft: pull.draft,
    merged_at: pull.state === "merged" ? ago(pull.updated) : null,
    user: { login: pull.user },
    head: { ref: pull.head, sha: sha(pull.number) },
    base: { ref: "main" },
    mergeable: true,
    mergeable_state: pull.checks === "failure" ? "unstable" : "clean",
    additions: pull.additions,
    deletions: pull.deletions,
    changed_files: pull.files,
    updated_at: ago(pull.updated),
    requested_reviewers: pull.reviewers.map((login) => ({ login })),
  };
}

const patch = `@@ -12,7 +12,14 @@ export function connect(url: string) {
   const socket = new WebSocket(url);
-  socket.onclose = () => fail();
+  socket.onclose = () => {
+    if (attempts < maximumAttempts) {
+      attempts += 1;
+      setTimeout(() => connect(url), backoff(attempts));
+      return;
+    }
+    fail();
+  };
   return socket;
 }`;

function detail(pull, kind) {
  if (kind === "reviews")
    return pull.number === 41
      ? [
          {
            id: 1,
            user: { login: "riley-chen" },
            state: "APPROVED",
            body: "Looks solid. The backoff cap is sensible.",
            html_url: `https://github.com/${repository}/pull/41#review-1`,
            submitted_at: ago(20),
          },
          {
            id: 2,
            user: { login: "kim-park" },
            state: "CHANGES_REQUESTED",
            body: "Please cover the offline case with a test.",
            html_url: `https://github.com/${repository}/pull/41#review-2`,
            submitted_at: ago(15),
          },
        ]
      : [];
  if (kind === "comments")
    return pull.number === 41
      ? [
          {
            id: 7,
            user: { login: "kim-park" },
            body: "Should this reset `attempts` after a successful reconnect?",
            path: "src/connection.ts",
            line: 18,
            diff_hunk: patch,
            html_url: `https://github.com/${repository}/pull/41#discussion_r7`,
            created_at: ago(14),
          },
        ]
      : [];
  if (kind === "commits")
    return [
      {
        sha: sha(pull.number + 100),
        html_url: `https://github.com/${repository}/commit/${sha(pull.number + 100)}`,
        author: { login: pull.user },
        commit: {
          message: "Retry the connection with backoff",
          author: { name: pull.user, date: ago(pull.updated + 120) },
        },
      },
      {
        sha: sha(pull.number + 120),
        html_url: `https://github.com/${repository}/commit/${sha(pull.number + 120)}`,
        author: { login: pull.user },
        commit: {
          message: "Restore the selected workspace\n\nKeeps pending edits.",
          author: { name: pull.user, date: ago(pull.updated + 30) },
        },
      },
    ];
  if (kind === "files")
    return [
      {
        filename: "src/connection.ts",
        status: "modified",
        additions: 38,
        deletions: 6,
        patch,
      },
      {
        filename: "src/workspace/restore.ts",
        status: "added",
        additions: 52,
        deletions: 0,
        patch:
          "@@ -0,0 +1,3 @@\n+export function restore() {\n+  return load();\n+}",
      },
      {
        filename: "src/ui/reconnect-banner.tsx",
        status: "modified",
        additions: 12,
        deletions: 4,
        patch: "@@ -1,2 +1,2 @@\n-const delay = 1000;\n+const delay = 5000;",
      },
    ];
  return null;
}

function conversation(number) {
  return number === 41
    ? [
        {
          id: 11,
          user: { login: "sam-lee" },
          body: "Tested on a flaky connection – reconnects within two seconds.",
          html_url: `https://github.com/${repository}/pull/41#issuecomment-11`,
          created_at: ago(30),
        },
      ]
    : [];
}

function checks(pull) {
  const state = pull?.checks ?? "success";
  return {
    check_runs: [
      {
        name: "Unit tests",
        status: "completed",
        conclusion: state === "failure" ? "failure" : "success",
        html_url: null,
      },
      {
        name: "Lint",
        status: "completed",
        conclusion: "success",
        html_url: null,
      },
      {
        name: "Build",
        status: state === "pending" ? "in_progress" : "completed",
        conclusion: state === "pending" ? null : "success",
        html_url: null,
      },
    ],
  };
}

export async function startGitFixture() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname;
    const json = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const token = (request.headers.authorization ?? "").replace(
      /^Bearer /u,
      "",
    );
    if (path === "/user")
      return json({ login: token.includes("owner") ? owner : "northstar-bot" });
    if (path === "/user/repos")
      return json([
        {
          id: 7,
          full_name: repository,
          private: true,
          default_branch: "main",
          html_url: `https://github.com/${repository}`,
        },
      ]);
    if (path === `/repos/${repository}`)
      return json({
        id: 7,
        full_name: repository,
        private: true,
        default_branch: "main",
        html_url: `https://github.com/${repository}`,
      });
    if (path === `/repos/${repository}/pulls`) return json(pulls.map(pullJson));
    const run = new RegExp(
      `^/repos/${repository}/commits/([0-9a-f]{40})/check-runs$`,
      "u",
    ).exec(path);
    if (run)
      return json(checks(pulls.find((pull) => sha(pull.number) === run[1])));
    const issueComments = new RegExp(
      `^/repos/${repository}/issues/(\\d+)/comments$`,
      "u",
    ).exec(path);
    if (issueComments)
      return request.method === "POST"
        ? json(
            {
              id: 99,
              html_url: `https://github.com/${repository}/pull/${issueComments[1]}#issuecomment-99`,
            },
            201,
          )
        : json(conversation(Number(issueComments[1])));
    const match = new RegExp(
      `^/repos/${repository}/pulls/(\\d+)(?:/([\\w-]+))?$`,
      "u",
    ).exec(path);
    const pull =
      match && pulls.find((entry) => entry.number === Number(match[1]));
    if (!pull) return json({ message: "Not Found" }, 404);
    if (!match[2]) return json(pullJson(pull));
    if (request.method === "POST" && match[2] === "reviews")
      return json({ id: 5 });
    const value = detail(pull, match[2]);
    return value ? json(value) : json({ message: "Not Found" }, 404);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}
