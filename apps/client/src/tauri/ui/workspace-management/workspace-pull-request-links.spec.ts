import { describe, expect, it } from "vitest";
import {
  cloudOriginForWorkspace,
  cloudPullRequestUrl,
} from "./workspace-pull-request-links";

describe("pull request links", () => {
  it("opens GitHub pull requests on their machdoch.cloud page", () => {
    expect(
      cloudPullRequestUrl(
        "https://machdoch.cloud/",
        "https://github.com/acme/api.v2/pull/31",
      ),
    ).toBe(
      "https://machdoch.cloud/cloud/pull-requests/reference/acme/api.v2/31",
    );
    expect(
      cloudPullRequestUrl(
        "https://machdoch.cloud",
        "https://gitlab.com/a/b/-/merge_requests/1",
      ),
    ).toBeNull();
    expect(
      cloudPullRequestUrl(
        "javascript:alert(1)",
        "https://github.com/a/b/pull/1",
      ),
    ).toBeNull();
  });

  it("finds the connected cloud for a workspace", () => {
    const connections = [
      {
        origin: "https://old.test",
        workspaceRoot: "C:\\Work\\App",
        status: "disconnected",
      },
      {
        origin: "https://cloud.test",
        workspaceRoot: "C:\\Work\\App",
        status: "connected",
      },
    ];
    expect(cloudOriginForWorkspace(connections, "C:\\Work\\App")).toBe(
      "https://cloud.test",
    );
    expect(cloudOriginForWorkspace(connections, "C:\\Work\\Other")).toBeNull();
  });
});
