/// <reference types="vitest/globals" />
import { resolveShellCommandInvocation } from "./shell-network-tool-definitions.ts";

describe("resolveShellCommandInvocation", () => {
  it("adds a non-interactive basic-parsing bootstrap on Windows", () => {
    const invocation = resolveShellCommandInvocation(
      "Invoke-WebRequest https://example.com",
      "win32",
    );

    expect(invocation.shellExecutable).toBe("powershell.exe");
    expect(invocation.shellArgs.slice(0, 3)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
    expect(invocation.shellArgs[3]).toContain(
      "Invoke-WebRequest:UseBasicParsing",
    );
    expect(invocation.shellArgs[3]).toContain(
      "Invoke-RestMethod:UseBasicParsing",
    );
    expect(invocation.shellArgs[3]).toContain(
      "Invoke-WebRequest https://example.com",
    );
  });

  it("keeps non-Windows shell execution unchanged", () => {
    expect(resolveShellCommandInvocation("echo hello", "linux")).toEqual({
      shellExecutable: "sh",
      shellArgs: ["-lc", "echo hello"],
    });
  });
});
