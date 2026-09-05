/// <reference types="node" />
import { expect, it } from "vitest";
import { ManagedMcpStdioTransport } from "./stdio-transport.js";

it("drains noisy MCP stderr and closes Windows descendant processes with their wrapper", async () => {
  const transport = new ManagedMcpStdioTransport({
    command: process.execPath,
    args: [
      "-e",
      `
      const { spawn } = require("node:child_process");
      const child = process.platform === "win32" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true }) : undefined;
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
      process.stderr.write("x".repeat(2 * 1024 * 1024), () => {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready", params: { childPid: child?.pid } }) + "\\n");
      });
    `,
    ],
    stderr: "pipe",
  });
  let finish = (_message: unknown) => {};
  const ready = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  transport.onmessage = finish;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await transport.start();
    const message = (await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MCP stderr blocked the child")),
          4_000,
        );
      }),
    ])) as { params: { childPid?: number } };
    const closing = transport.close();
    expect(transport.close()).toBe(closing);
    await closing;
    if (process.platform === "win32") {
      expect(message.params.childPid).toBeGreaterThan(0);
      expect(() => process.kill(message.params.childPid!, 0)).toThrow();
    }
  } finally {
    clearTimeout(timeout);
    await transport.close();
  }
}, 10_000);
