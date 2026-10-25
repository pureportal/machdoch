import assert from "node:assert/strict";
import { get } from "node:http";
import { test } from "node:test";
import {
  closeRepositoryGateway,
  openRepositoryGateway,
  repositoryResponse,
} from "../../guest/repository.ts";

await test("acknowledges a closed Git consumer and drains its transfer before closing the gateway", async () => {
  const messages: Record<string, unknown>[] = [];
  let started!: (message: Record<string, unknown>) => void;
  const transfer = new Promise<Record<string, unknown>>((resolve) => {
    started = resolve;
  });
  const url = await openRepositoryGateway((message) => {
    messages.push(message);
    if (message.kind === "repository_request") started(message);
  });
  const request = get(`${url}/info/refs?service=git-upload-pack`);
  request.on("error", () => {});
  const current = await transfer;
  let closed = false;
  const closing = closeRepositoryGateway().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => request.once("close", resolve));
  assert.equal(closed, false);
  await repositoryResponse({
    id: current.id,
    sequence: 0,
    chunk: Buffer.from("packet").toString("base64"),
    done: false,
  });
  await closing;
  assert.deepEqual(messages.at(-1), {
    kind: "repository_ack",
    id: current.id,
    sequence: 0,
    closed: true,
  });
  await assert.rejects(
    repositoryResponse({ id: current.id, sequence: 1, chunk: "", done: true }),
    /Unknown repository transfer/,
  );
});

await test("delivers a normal Git response and acknowledges its terminal chunk", async () => {
  const messages: Record<string, unknown>[] = [];
  let started!: (message: Record<string, unknown>) => void;
  const transfer = new Promise<Record<string, unknown>>((resolve) => {
    started = resolve;
  });
  const url = await openRepositoryGateway((message) => {
    messages.push(message);
    if (message.kind === "repository_request") started(message);
  });
  const request = get(`${url}/info/refs?service=git-upload-pack`);
  const body = new Promise<string>((resolve, reject) => {
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  });
  const current = await transfer;
  try {
    await repositoryResponse({
      id: current.id,
      sequence: 0,
      chunk: Buffer.from("packet").toString("base64"),
      done: false,
    });
    await repositoryResponse({
      id: current.id,
      sequence: 1,
      chunk: "",
      done: true,
    });
    assert.equal(await body, "packet");
    assert.deepEqual(messages.slice(1), [
      { kind: "repository_ack", id: current.id, sequence: 0, closed: false },
      { kind: "repository_ack", id: current.id, sequence: 1, closed: false },
    ]);
  } finally {
    request.destroy();
    await closeRepositoryGateway();
  }
});
