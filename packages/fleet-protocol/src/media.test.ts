import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";

import {
  hostMessageSchema,
  hostRequestSchema,
  hostResponseSchema,
  managerMessageSchema,
} from "./index.ts";
import {
  mediaCommands,
  mediaRequestSchema,
  mediaResponseSchema,
} from "./media.ts";

const corpus = z
  .strictObject({
    cases: z.array(
      z.strictObject({
        name: z.string(),
        accepted: z.boolean(),
        request: z.json(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/media-request-conformance.json", import.meta.url),
        "utf8",
      ),
    ),
  );

for (const fixture of corpus.cases) {
  void test(`media request ${fixture.name}`, () => {
    const hostRequest = { type: "media", request: fixture.request };
    assert.equal(
      mediaRequestSchema.safeParse(fixture.request).success,
      fixture.accepted,
    );
    assert.equal(
      hostRequestSchema.safeParse(hostRequest).success,
      fixture.accepted,
    );
    assert.equal(
      managerMessageSchema.safeParse({
        type: "request",
        requestId: "request-1",
        request: hostRequest,
      }).success,
      fixture.accepted,
    );
  });
}

void test("all declared media commands are valid invoke requests", () => {
  for (const command of mediaCommands) {
    assert.equal(
      mediaRequestSchema.safeParse({
        kind: "invoke",
        id: "123e4567-e89b-42d3-a456-426614174000",
        command,
        args:
          command === "media_move_asset_storage"
            ? { folder: "C:\\Assets" }
            : {},
      }).success,
      true,
      command,
    );
  }
});

const completeResponseCases = [
  { name: "partial chunk", accepted: true, chunk: "abc", offset: 2, total: 10 },
  { name: "empty result", accepted: true, chunk: "", offset: 0, total: 0 },
  { name: "empty final chunk", accepted: true, chunk: "", offset: 3, total: 3 },
  {
    name: "offset beyond total",
    accepted: false,
    chunk: "",
    offset: 11,
    total: 10,
  },
  {
    name: "chunk overruns total",
    accepted: false,
    chunk: "abc",
    offset: 8,
    total: 10,
  },
  {
    name: "empty partial chunk",
    accepted: false,
    chunk: "",
    offset: 2,
    total: 10,
  },
  {
    name: "total at maximum",
    accepted: true,
    chunk: "a",
    offset: 64 * 1024 * 1024 - 1,
    total: 64 * 1024 * 1024,
  },
  {
    name: "total beyond maximum",
    accepted: false,
    chunk: "a",
    offset: 64 * 1024 * 1024,
    total: 64 * 1024 * 1024 + 1,
  },
  {
    name: "chunk at maximum",
    accepted: true,
    chunk: "a".repeat(262144),
    offset: 0,
    total: 262144,
  },
  {
    name: "chunk beyond maximum",
    accepted: false,
    chunk: "a".repeat(262145),
    offset: 0,
    total: 262145,
  },
] as const;

for (const fixture of completeResponseCases) {
  void test(`complete media response ${fixture.name}`, () => {
    const response = {
      state: "complete",
      chunk: fixture.chunk,
      offset: fixture.offset,
      total: fixture.total,
    };
    const hostResponse = { type: "media", response };
    assert.equal(
      mediaResponseSchema.safeParse(response).success,
      fixture.accepted,
    );
    assert.equal(
      hostResponseSchema.safeParse(hostResponse).success,
      fixture.accepted,
    );
    assert.equal(
      hostMessageSchema.safeParse({
        type: "response",
        requestId: "request-1",
        response: hostResponse,
      }).success,
      fixture.accepted,
    );
  });
}
