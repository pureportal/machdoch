import { describe, expect, it } from "vitest";
import {
  createCloudIssueDirectory,
  machdochCloudConnected,
  parseCloudIssueSearch,
} from "./workspace-cloud-issues";

const issue = (
  identifier: string,
  title: string,
  statusName = "In Progress",
) => ({
  id: `${identifier}-id`,
  identifier,
  title,
  statusName,
  state: "started",
  revision: 3,
});

const toolOutput = (issues: unknown[]) => ({
  workspaceRoot: "C:\\Work",
  result: { content: [{ type: "text", text: JSON.stringify(issues) }] },
});

const enabledCloud = [{ id: "machdoch-cloud", enabled: true }];

describe("machdoch.cloud issues", () => {
  it("treats only an enabled machdoch.cloud server as connected", () => {
    expect(machdochCloudConnected(enabledCloud)).toBe(true);
    expect(
      machdochCloudConnected([{ id: "machdoch-cloud", enabled: false }]),
    ).toBe(false);
    expect(machdochCloudConnected([{ id: "github", enabled: true }])).toBe(
      false,
    );
  });

  it("reads issues from the tool result and reports tool errors", () => {
    expect(
      parseCloudIssueSearch(
        toolOutput([issue("CLOUD-2972", "Fix login"), { identifier: 4 }]),
      ),
    ).toEqual([
      {
        identifier: "CLOUD-2972",
        title: "Fix login",
        statusName: "In Progress",
        state: "started",
      },
    ]);
    expect(() =>
      parseCloudIssueSearch({
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "forbidden",
                error: "Sign in again.",
              }),
            },
          ],
        },
      }),
    ).toThrow("Sign in again.");
  });

  it("looks up branch issue keys once and matches the exact identifier", async () => {
    const queries: string[] = [];
    const directory = createCloudIssueDirectory({
      servers: async () => enabledCloud,
      search: async (query) => {
        queries.push(query);
        return toolOutput([
          issue("CLOUD-29720", "Other"),
          issue("CLOUD-2972", "Fix login"),
        ]);
      },
    });
    expect(await directory.lookup("cloud-2972")).toMatchObject({
      title: "Fix login",
    });
    expect(await directory.lookup("CLOUD-2972")).toMatchObject({
      statusName: "In Progress",
    });
    expect(await directory.lookup("CLOUD-2")).toBeNull();
    expect(queries).toEqual(["CLOUD-2972", "CLOUD-2"]);
  });

  it("asks nothing when machdoch.cloud is not connected and retries once it is", async () => {
    let servers: unknown[] = [];
    let time = 0;
    let searches = 0;
    const directory = createCloudIssueDirectory(
      {
        servers: async () => servers,
        search: async () => {
          searches += 1;
          return toolOutput([issue("CLOUD-1", "Connected")]);
        },
      },
      () => time,
    );
    expect(await directory.lookup("CLOUD-1")).toBeNull();
    expect(await directory.search("login")).toBeNull();
    expect(searches).toBe(0);
    servers = enabledCloud;
    time = 61_000;
    expect(await directory.lookup("CLOUD-1")).toMatchObject({
      title: "Connected",
    });
  });

  it("does not keep failed lookups and runs at most two searches at once", async () => {
    let active = 0;
    let peak = 0;
    let fail = true;
    const directory = createCloudIssueDirectory({
      servers: async () => enabledCloud,
      search: async (query) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (fail && query === "CLOUD-9") throw new Error("offline");
        return toolOutput([issue(query, `Issue ${query}`)]);
      },
    });
    await expect(directory.lookup("CLOUD-9")).rejects.toThrow("offline");
    fail = false;
    expect(await directory.lookup("CLOUD-9")).toMatchObject({
      title: "Issue CLOUD-9",
    });
    await Promise.all(
      ["CLOUD-1", "CLOUD-2", "CLOUD-3", "CLOUD-4"].map((key) =>
        directory.lookup(key),
      ),
    );
    expect(peak).toBe(2);
  });
});
