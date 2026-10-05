import { readFileSync } from "node:fs";
import {
  productSnapshotSchema,
  type ProductSnapshot,
} from "@machdoch/fleet-protocol";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/fleet-protocol/fixtures/desktop-snapshot.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

export function productFixture(): ProductSnapshot {
  const snapshot = structuredClone(fixture.response.snapshot);
  snapshot.shell.sessions = [
    {
      id: "session-1",
      title: "Example session",
      status: "idle",
      workspace: "/projects/example",
      provider: "openai",
      model: "example-model",
      effectiveMode: "machdoch",
      createdAt: 1,
      updatedAt: 2,
      tags: [],
      messageCount: 0,
      promptHistoryCount: 0,
      attachmentCount: 0,
      canRename: true,
      canDelete: true,
      canArchive: true,
      canPin: true,
      canDuplicate: true,
      canBranch: true,
    },
  ];
  snapshot.shell.activeSessionId = "session-1";
  snapshot.shell.workspaces = [
    { root: "/projects/example", label: "Example", sessionCount: 1 },
  ];
  return productSnapshotSchema.parse(snapshot);
}
