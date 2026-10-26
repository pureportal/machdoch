import { describe, expect, it } from "vitest";
import {
  speechRequestSchema,
  type SpeechRequest,
} from "@machdoch/fleet-protocol/speech";
import { scopeSpeechRequest } from "./speech-identity";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  clientId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request: SpeechRequest = {
  kind: "invoke",
  id,
  command: "speech_execute",
  args: {
    clientId,
    disconnectPolicy: "cancel",
    request: {
      operation: "listJobs",
      input: { owner: "remote:caller-controlled" },
    },
  },
};

describe("authenticated speech identity", () => {
  it("binds invocation, response receipts and downloads to the authenticated session and device", () => {
    const scoped = scopeSpeechRequest(request, "session-a", "device-a");
    expect(speechRequestSchema.parse(scoped)).toEqual(scoped);
    expect(scoped.id).not.toBe(id);
    if (scoped.kind !== "invoke") throw new Error("Expected invocation");
    expect(scoped.args.clientId).not.toBe(clientId);
    expect(scoped.args.request.input.owner).toBe(
      `remote:${scoped.args.clientId}`,
    );
    expect(
      scopeSpeechRequest(
        { kind: "read", id, offset: 0 },
        "session-a",
        "device-a",
      ).id,
    ).toBe(scoped.id);
    expect(
      scopeSpeechRequest({ kind: "release", id }, "session-a", "device-a").id,
    ).toBe(scoped.id);
    expect(scopeSpeechRequest(request, "session-b", "device-a").id).not.toBe(
      scoped.id,
    );
    expect(scopeSpeechRequest(request, "session-a", "device-b").id).not.toBe(
      scoped.id,
    );
    const download = scopeSpeechRequest(
      {
        ...request,
        args: {
          ...request.args,
          request: {
            operation: "readAsset",
            input: { id: "asset", offset: 0, maxBytes: 1024 },
          },
        },
      },
      "session-a",
      "device-a",
    );
    if (download.kind !== "invoke") throw new Error("Expected invocation");
    expect(download.args.clientId).toBe(scoped.args.clientId);
    expect(request.args.request.input.owner).toBe("remote:caller-controlled");
  });
});
