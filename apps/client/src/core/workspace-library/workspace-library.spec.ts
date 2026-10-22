import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  KnowledgeSearchResult,
  ResearchProject,
  ResearchProjectInput,
  ResearchSourceCheck,
} from "@machdoch/fleet-protocol/workspace-library";
import { runWorkspaceLibraryRequest } from "./index.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "machdoch-knowledge-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const search = (query: string) =>
  runWorkspaceLibraryRequest(root, {
    action: "search",
    query,
  }) as Promise<KnowledgeSearchResult>;
const projectInput = (): ResearchProjectInput => ({
  title: "Study",
  question: "How does retrieval work?",
  notes: "",
  status: "active",
  revision: 0,
  sources: [],
  findings: [],
});
const save = (project: ResearchProjectInput) =>
  runWorkspaceLibraryRequest(root, {
    action: "save-project",
    project,
  }) as Promise<ResearchProject>;
const edit = ({
  createdAt: _created,
  updatedAt: _updated,
  ...project
}: ResearchProject): ResearchProjectInput => project;

it("indexes source-aligned text and refreshes changes, deletions and Git exclusions", async () => {
  await promisify(execFile)("git", ["init", "--quiet"], {
    cwd: root,
    windowsHide: true,
  });
  await writeFile(join(root, ".gitignore"), "ignored.md\n");
  await writeFile(
    join(root, "guide.md"),
    "# Design\nRetrieval uses source fingerprints.\n",
  );
  await writeFile(join(root, "ignored.md"), "private retrieval");
  await writeFile(join(root, ".env"), "retrieval=secret");
  let result = await search("retrieval");
  expect(result.hits.map((hit) => hit.path)).toEqual(["guide.md"]);
  expect(result.hits[0]).toMatchObject({ startLine: 1, endLine: 3 });
  const fingerprint = result.hits[0]!.fingerprint;
  await writeFile(join(root, "guide.md"), "Retrieval changed.");
  result = await search("retrieval");
  expect(result.hits[0]!.fingerprint).not.toBe(fingerprint);
  expect(result.hits[0]!.excerpt).toBe("Retrieval changed.");
  await rm(join(root, "guide.md"));
  expect((await search("retrieval")).hits).toEqual([]);
});

it("does not follow linked directories or index binaries and treats FTS syntax as query text", async () => {
  const outside = await mkdtemp(join(tmpdir(), "machdoch-knowledge-outside-"));
  try {
    await writeFile(join(outside, "private.md"), "outsider");
    await symlink(outside, join(root, "linked"), "junction");
    await writeFile(join(root, "binary.txt"), Buffer.from([111, 117, 116, 0]));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "guide.md"), "outsider");
    expect((await search('outsider OR "*"')).hits).toEqual([]);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it("replaces all changed chunks and removes deleted files while retaining unchanged evidence", async () => {
  await writeFile(join(root, "changed.md"), "Obsolete evidence\n".repeat(200));
  await writeFile(join(root, "deleted.md"), "Deleted evidence\n".repeat(200));
  await writeFile(join(root, "retained.md"), "Retained evidence");
  const before = await search("evidence");
  expect(
    before.hits.filter((hit) => hit.path === "changed.md").length,
  ).toBeGreaterThan(1);
  const retained = before.hits.find((hit) => hit.path === "retained.md");
  await writeFile(join(root, "changed.md"), "Revised evidence");
  await rm(join(root, "deleted.md"));
  const after = await search("evidence");
  expect(after.indexedFiles).toBe(2);
  expect(after.hits).toHaveLength(2);
  expect(after.hits.find((hit) => hit.path === "retained.md")).toEqual(
    retained,
  );
  expect(after.hits.find((hit) => hit.path === "changed.md")?.excerpt).toBe(
    "Revised evidence",
  );
  expect((await search("Obsolete Deleted")).hits).toEqual([]);
});

it("respects repository exclusions when searching a subfolder workspace", async () => {
  await promisify(execFile)("git", ["init", "--quiet"], {
    cwd: root,
    windowsHide: true,
  });
  await writeFile(join(root, ".gitignore"), "ignored.md\n");
  const folder = join(root, "docs");
  await mkdir(folder);
  await writeFile(join(folder, "guide.md"), "retrieval evidence");
  await writeFile(join(folder, "ignored.md"), "private retrieval evidence");
  const result = (await runWorkspaceLibraryRequest(folder, {
    action: "search",
    query: "retrieval",
  })) as KnowledgeSearchResult;
  expect(result.hits.map((hit) => hit.path)).toEqual(["guide.md"]);
});

it("saves multiline search evidence from Windows files without changing byte fingerprints", async () => {
  await writeFile(
    join(root, "guide.md"),
    "# Evidence\r\nRetrieval uses fingerprints.\r\n",
  );
  const hit = (await search("retrieval")).hits[0]!;
  expect(hit.excerpt).toBe("# Evidence\nRetrieval uses fingerprints.\n");
  const project = await save({
    ...projectInput(),
    sources: [
      {
        id: randomUUID(),
        title: "Guide",
        uri: hit.path,
        excerpt: hit.excerpt,
        fingerprint: hit.fingerprint,
      },
    ],
  });
  expect(project.sources[0]!.fingerprint).toBe(hit.fingerprint);
  await writeFile(
    join(root, "guide.md"),
    "# Evidence\nRetrieval uses fingerprints.\n",
  );
  expect((await search("retrieval")).hits[0]!.fingerprint).not.toBe(
    hit.fingerprint,
  );
});

it("persists research across reopen, checks evidence changes and rejects stale writes", async () => {
  await writeFile(join(root, "guide.md"), "Sources have fingerprints.");
  const sourceId = randomUUID();
  let project = await save({
    ...projectInput(),
    sources: [
      {
        id: sourceId,
        title: "Guide",
        uri: "guide.md",
        excerpt: "Sources have fingerprints.",
      },
    ],
    findings: [
      {
        id: randomUUID(),
        claim: "Fingerprint tracking exists.",
        sourceIds: [sourceId],
        status: "supported",
      },
    ],
  });
  expect(project.sources[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    await runWorkspaceLibraryRequest(root, {
      action: "project",
      id: project.id,
    }),
  ).toEqual(project);
  expect(
    await runWorkspaceLibraryRequest(root, {
      action: "check-sources",
      id: project.id,
    }),
  ).toEqual([{ sourceId, state: "current" }]);
  await writeFile(join(root, "guide.md"), "Source content was replaced.");
  expect(
    await runWorkspaceLibraryRequest(root, {
      action: "check-sources",
      id: project.id,
    }),
  ).toEqual([{ sourceId, state: "changed" }]);
  const outdated = edit(project);
  project = await save({ ...outdated, notes: "Keep investigating." });
  expect(project.sources[0]!.fingerprint).toEqual(
    outdated.sources[0]!.fingerprint,
  );
  await expect(save({ ...outdated, notes: "Overwrite" })).rejects.toThrow(
    "changed elsewhere",
  );
  await expect(
    runWorkspaceLibraryRequest(root, {
      action: "delete-project",
      id: project.id,
      revision: outdated.revision,
    }),
  ).rejects.toThrow("changed elsewhere");
  await runWorkspaceLibraryRequest(root, {
    action: "delete-project",
    id: project.id,
    revision: project.revision,
  });
  expect(
    await runWorkspaceLibraryRequest(root, { action: "projects" }),
  ).toEqual([]);
});

it("rejects invented local excerpts, unsupported claims and paths outside the workspace", async () => {
  await writeFile(join(root, "guide.md"), "Actual evidence");
  const source = {
    id: randomUUID(),
    title: "Guide",
    uri: "guide.md",
    excerpt: "Fabricated evidence",
  };
  await expect(save({ ...projectInput(), sources: [source] })).rejects.toThrow(
    "does not match",
  );
  await expect(
    save({
      ...projectInput(),
      sources: [{ ...source, fingerprint: "a".repeat(64) }],
    }),
  ).rejects.toThrow("does not match");
  await expect(
    save({ ...projectInput(), sources: [{ ...source, uri: "../outside.md" }] }),
  ).rejects.toThrow();
  await expect(
    save({
      ...projectInput(),
      findings: [
        {
          id: randomUUID(),
          claim: "Unsupported",
          sourceIds: [],
          status: "supported",
        },
      ],
    }),
  ).rejects.toThrow("Link supported findings");
});

it("keeps saved evidence when a file is deleted while allowing notes to be updated", async () => {
  await writeFile(join(root, "guide.md"), "Saved evidence");
  const project = await save({
    ...projectInput(),
    sources: [
      {
        id: randomUUID(),
        title: "Guide",
        uri: "guide.md",
        excerpt: "Saved evidence",
      },
    ],
  });
  await rm(join(root, "guide.md"));
  const updated = await save({
    ...edit(project),
    notes: "Source removed; investigate.",
  });
  expect(updated.sources).toEqual(project.sources);
  expect(
    await runWorkspaceLibraryRequest(root, {
      action: "check-sources",
      id: project.id,
    }),
  ).toEqual([{ sourceId: project.sources[0]!.id, state: "missing" }]);
  await expect(
    save({
      ...edit(updated),
      sources: [{ ...updated.sources[0]!, excerpt: "Invented replacement" }],
    }),
  ).rejects.toThrow("Cannot read research source");
});

it("opens a current source with a fingerprint and rejects unsafe or excluded previews", async () => {
  await writeFile(join(root, "source.md"), "Current source text.");
  expect(
    await runWorkspaceLibraryRequest(root, {
      action: "source",
      path: "source.md",
    }),
  ).toEqual({
    path: "source.md",
    content: "Current source text.",
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  await writeFile(join(root, ".env"), "private");
  await expect(
    runWorkspaceLibraryRequest(root, {
      action: "source",
      path: "../source.md",
    }),
  ).rejects.toThrow();
  await expect(
    runWorkspaceLibraryRequest(root, { action: "source", path: ".env" }),
  ).rejects.toThrow();
});

it("keeps web evidence unverified until it is revisited", async () => {
  const sourceId = randomUUID();
  const project = await save({
    ...projectInput(),
    sources: [
      {
        id: sourceId,
        title: "Paper",
        uri: "https://example.org/paper",
        excerpt: "Saved passage",
      },
    ],
  });
  const checks = (await runWorkspaceLibraryRequest(root, {
    action: "check-sources",
    id: project.id,
  })) as ResearchSourceCheck[];
  expect(checks).toEqual([{ sourceId, state: "unverified" }]);
});
