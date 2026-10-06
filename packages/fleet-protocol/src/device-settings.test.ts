import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  hostMessageSchema,
  hostRequestSchema,
  managerMessageSchema,
} from "./index.ts";
import { deviceSettingsRequestSchema } from "./device-settings.ts";

await test("actual device settings notifications survive gateway validation", () => {
  for (const name of [
    "machdoch://user-settings-changed",
    "machdoch://desktop-settings-changed",
    "machdoch://settings-imported",
    "unregistered-settings-event",
  ]) {
    const message = {
      type: "response",
      requestId: "settings-subscription",
      response: {
        type: "deviceSettings",
        response: {
          state: "events",
          cursor: 1,
          events: [{ name, payload: { kind: "answer-language" } }],
        },
      },
    };
    assert.equal(
      hostMessageSchema.safeParse(message).success,
      name !== "unregistered-settings-event",
      name,
    );
  }
});

await test("device settings requests match Rust conformance", () => {
  const corpus = JSON.parse(
    readFileSync(
      new URL("../fixtures/device-settings-conformance.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: Array<{ name: string; request: unknown; accepted: boolean }> };
  for (const entry of corpus.cases) {
    const request = { type: "deviceSettings", request: entry.request };
    assert.equal(
      hostRequestSchema.safeParse(request).success,
      entry.accepted,
      entry.name,
    );
    assert.equal(
      managerMessageSchema.safeParse({
        type: "request",
        requestId: "request-1",
        request,
      }).success,
      entry.accepted,
      entry.name,
    );
  }
});

await test("device settings bound documents, credentials and UTF-8 passphrases", () => {
  const invoke = (command: string, args: unknown) =>
    deviceSettingsRequestSchema.safeParse({
      kind: "invoke",
      id: "c6f1f070-2b65-4d17-a64d-b05e6c54ecbe",
      command,
      args,
    }).success;
  assert.equal(
    invoke("save_user_provider_api_key", {
      provider: "openai",
      apiKey: "x".repeat(8193),
    }),
    false,
  );
  assert.equal(
    invoke("save_user_mcp_config_document", {
      raw: "x".repeat(1_048_577),
      expectedRaw: "",
    }),
    false,
  );
  assert.equal(
    invoke("export_encrypted_settings_file", {
      request: {
        categories: ["memory.global"],
        destinationPath: "/transfers/export",
        passphrase: "é".repeat(513),
      },
    }),
    false,
  );
  assert.equal(
    invoke("save_user_speech_to_text_context", {
      speechContext: "bad\0context",
    }),
    false,
  );
});
