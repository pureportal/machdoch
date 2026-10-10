import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { hostResponseSchema } from "@machdoch/fleet-protocol";
import { createMobileMedia } from "./mobile-media-fixture.mjs";
import { productFixture } from "../src/test/product-fixture.ts";

export function createMobileDevice(socket) {
  const snapshot = productFixture();
  snapshot.shell.composer.provider = "codex-cli";
  snapshot.shell.composer.providerLabel = "Codex CLI";
  snapshot.shell.composer.chooserProviders = ["codex-cli"];
  snapshot.shell.composer.modelCatalog = [
    {
      provider: "codex-cli",
      label: "Codex CLI",
      available: true,
      models: [
        {
          id: "gpt-6",
          label: "GPT 6.1 Sol",
          reasoningOptions: ["default", "xhigh"],
        },
      ],
    },
  ];
  snapshot.shell.composer.workspace = "/projects/example";
  snapshot.shell.composer.workspaceLabel = "Example";
  snapshot.shell.composer.imageInputSupported = true;
  snapshot.shell.sessionRoutingAvailable = false;
  snapshot.shell.visibleMessages = [];
  const operations = new Map();
  const transfers = new Map();
  const media = createMobileMedia(transfers);
  const uploaded = [];
  const browsed = [];
  const attachedPaths = [];
  const transferWrites = [];
  let failImport = false;
  let failedWriteOffset = null;
  function invoke(domain, command, args) {
    if (domain === "media") {
      if (command === "media_create_transfer") {
        const path = `/transfers/${args.id}-${args.name}`;
        transfers.set(args.id, {
          name: args.name,
          path,
          bytes: Buffer.alloc(0),
        });
        return { path };
      }
      if (command === "media_write_transfer") {
        if (failedWriteOffset !== null && args.offset >= failedWriteOffset)
          throw new Error(
            "File upload was interrupted. Select the file again.",
          );
        const transfer = transfers.get(args.id);
        assert.equal(args.offset, transfer.bytes.length);
        transferWrites.push({ name: transfer.name, offset: args.offset });
        transfer.bytes = Buffer.concat([
          transfer.bytes,
          Buffer.from(args.data, "base64"),
        ]);
        return { offset: transfer.bytes.length };
      }
      if (command === "media_remove_transfer") {
        transfers.delete(args.id);
        return null;
      }
      return media.invoke(command, args);
    }
    if (command === "import_context_attachment") {
      if (failImport) throw new Error("Could not save the file. Try again.");
      const transfer = [...transfers.values()].find(
        ({ path }) => path === args.path,
      );
      assert.equal(args.name, transfer.name);
      uploaded.push({ name: args.name, bytes: transfer.bytes });
      return { path: `/attachments/${args.name}` };
    }
    if (command === "list_workspace_directory") {
      assert.ok(args.relativePath);
      browsed.push(args.relativePath);
      return {
        path: args.relativePath === "." ? "" : args.relativePath,
        entries:
          args.relativePath === "."
            ? [
                {
                  name: "photos",
                  path: "photos",
                  kind: "directory",
                  size: null,
                  modifiedAt: null,
                },
                {
                  name: "report.txt",
                  path: "report.txt",
                  kind: "file",
                  size: 10,
                  modifiedAt: null,
                },
              ]
            : Array.from({ length: 24 }, (_, index) => ({
                name: `Urlaub – März 📷 ${String(index + 1).padStart(2, "0")} – Sonnenuntergang am Meer mit der Familie.png`,
                path: `photos/holiday-${index + 1}.png`,
                kind: "file",
                size: 1024,
                modifiedAt: null,
              })),
        nextOffset: null,
        total: args.relativePath === "." ? 2 : 24,
      };
    }
    if (command === "get_context_pack_documents") return [];
    if (command === "get_session_index")
      return {
        sessions: snapshot.shell.sessions,
        total: 1,
        nextOffset: null,
        sessionIds: ["session-1"],
        projects: [
          {
            id: "/projects/example",
            label: "Example",
            path: "/projects/example",
            count: 1,
          },
        ],
        tags: [],
        statuses: ["idle"],
      };
    if (command === "get_session_composer_text")
      return {
        sessionId: "session-1",
        draft: "",
        draftRevision: 0,
        queuedMessages: [],
        history: [],
      };
    if (command === "get_session_message_page")
      return {
        sessionId: "session-1",
        messages: [],
        revision: "0".repeat(64),
        hasEarlier: false,
        total: 0,
      };
    throw new Error(`Unexpected fixture operation: ${command}`);
  }
  function respond(request) {
    if (request.type === "getProductSnapshot")
      return { type: "productSnapshot", snapshot };
    if (request.type === "executeProductCommand") {
      const command = request.command;
      if (command.kind === "add-context-attachments") {
        attachedPaths.push(...command.paths);
        snapshot.shell.composer.attachments.push(
          ...command.paths.map((path) => ({
            id: randomUUID(),
            source: "path",
            kind: path.endsWith(".png") ? "image" : "file",
            path,
            name: path.split("/").at(-1),
          })),
        );
      }
      if (command.kind === "clear-attachments")
        snapshot.shell.composer.attachments = [];
      return {
        type: "commandAccepted",
        receipt: { commandId: command.commandId, duplicate: false },
      };
    }
    const operation = request.request;
    let response;
    if (operation.kind === "invoke") {
      try {
        operations.set(
          operation.id,
          Buffer.from(
            JSON.stringify(
              invoke(request.type, operation.command, operation.args),
            ),
          ).toString("base64"),
        );
        response = { state: "pending" };
      } catch (error) {
        response = { state: "failed", error: error.message };
      }
    } else if (operation.kind === "read") {
      const content = operations.get(operation.id);
      response = {
        state: "complete",
        chunk: content.slice(operation.offset, operation.offset + 262144),
        offset: operation.offset,
        total: content.length,
      };
    } else if (operation.kind === "release") {
      operations.delete(operation.id);
      response = { state: "pending" };
    } else if (operation.kind === "events") {
      response = { state: "events", cursor: 0, events: [] };
    } else throw new Error(`Unexpected request: ${operation.kind}`);
    return { type: request.type, response };
  }
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type !== "request") return;
    let response;
    try {
      response = hostResponseSchema.parse(respond(message.request));
    } catch (error) {
      response = { type: "error", code: "internal", message: error.message };
    }
    socket.send(
      JSON.stringify({
        type: "response",
        requestId: message.requestId,
        response,
      }),
    );
  });
  return {
    uploaded,
    browsed,
    transfers,
    transferWrites,
    attachedPaths,
    mediaImports: media.imports,
    failImport: (value) => {
      failImport = value;
    },
    failWriteAfter: (offset) => {
      failedWriteOffset = offset;
    },
  };
}
