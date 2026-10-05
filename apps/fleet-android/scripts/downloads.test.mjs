import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const script = readFileSync(
  new URL("../app/src/main/assets/downloads.js", import.meta.url),
  "utf8",
);

function downloadFixture({ response, cancelled = false } = {}) {
  const dom = new JSDOM(
    '<a download="image.png" href="blob:https://fleet.example/image">Save</a>',
    { url: "https://fleet.example/instances", runScripts: "outside-only" },
  );
  const messages = [];
  const requests = [];
  dom.window.fetch = async (url, options) => {
    requests.push({ url, options });
    if (response instanceof Error) throw response;
    return response ?? new Response(new Uint8Array([0, 1, 128, 255]));
  };
  dom.window.machdochDownload = {
    postMessage(value) {
      const message = JSON.parse(value);
      messages.push(message);
      const acknowledgement =
        message.operation === "begin"
          ? cancelled
            ? "cancel"
            : "ready"
          : "continue";
      queueMicrotask(() =>
        dom.window.machdochDownload.onmessage({ data: acknowledgement }),
      );
    },
  };
  dom.window.eval(script);
  const click = () =>
    dom.window.document
      .querySelector("a")
      .dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
  return { dom, messages, requests, click };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("streams a same-origin blob with acknowledgements and preserves binary bytes", async () => {
  const fixture = downloadFixture();
  try {
    assert.equal(fixture.click(), false);
    await settle();
    assert.deepEqual(
      fixture.messages.map((message) => message.operation),
      ["begin", "chunk", "complete"],
    );
    assert.deepEqual(
      Buffer.from(fixture.messages[1].data, "base64"),
      Buffer.from([0, 1, 128, 255]),
    );
    assert.equal(fixture.requests[0].options.redirect, "error");
    assert.equal(fixture.requests[0].options.credentials, "same-origin");
    assert.equal(fixture.requests[0].options.mode, "same-origin");
  } finally {
    fixture.dom.window.close();
  }
});

test("does not fetch another origin or an unsafe scheme", async () => {
  const fixture = downloadFixture();
  try {
    const link = fixture.dom.window.document.querySelector("a");
    link.addEventListener("click", (event) => event.preventDefault());
    for (const address of [
      "https://evil.example/image",
      "http://fleet.example/image",
      "blob:https://evil.example/image",
      "javascript:alert(1)",
    ]) {
      link.href = address;
      fixture.click();
    }
    await settle();
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.messages.length, 0);
  } finally {
    fixture.dom.window.close();
  }
});

test("cancelling the save dialog sends no file bytes", async () => {
  const fixture = downloadFixture({ cancelled: true });
  try {
    fixture.click();
    await settle();
    assert.deepEqual(
      fixture.messages.map((message) => message.operation),
      ["begin"],
    );
  } finally {
    fixture.dom.window.close();
  }
});

test("reports fetch failures and permits a subsequent attempt", async () => {
  const fixture = downloadFixture({ response: new Error("Disconnected") });
  try {
    fixture.click();
    await settle();
    assert.deepEqual(
      fixture.messages.map((message) => message.operation),
      ["error"],
    );
    fixture.click();
    await settle();
    assert.equal(fixture.requests.length, 2);
  } finally {
    fixture.dom.window.close();
  }
});

test("rejects oversized downloads before opening the save dialog", async () => {
  const fixture = downloadFixture({
    response: new Response("oversized", {
      headers: { "Content-Length": String(512 * 1024 * 1024 + 1) },
    }),
  });
  try {
    fixture.click();
    await settle();
    assert.deepEqual(
      fixture.messages.map(({ operation, reason }) => ({ operation, reason })),
      [{ operation: "error", reason: "size" }],
    );
  } finally {
    fixture.dom.window.close();
  }
});
