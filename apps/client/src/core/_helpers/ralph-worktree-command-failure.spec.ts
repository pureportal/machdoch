import { afterEach, expect, it, vi } from "vitest";
import { runStreamingCommand } from "./streaming-command.js";
import { runRalphWorktreeGit } from "./ralph-worktree-git.helper.js";

vi.mock("./streaming-command.js", () => ({ runStreamingCommand: vi.fn() }));

afterEach(() => vi.resetAllMocks());

it("retains a checkout timeout together with its Git progress and original cause", async () => {
  const failure = Object.assign(
    new Error("Command timed out after 120000ms."),
    {
      stderr: "Preparing worktree (checking out 'ralph/run')\n",
    },
  );
  vi.mocked(runStreamingCommand).mockRejectedValue(failure);
  await expect(
    runRalphWorktreeGit("workspace", ["worktree", "add", "candidate"]),
  ).rejects.toMatchObject({
    message:
      "Command timed out after 120000ms.\nPreparing worktree (checking out 'ralph/run')",
    cause: failure,
  });
});

it("keeps abort failures with no Git stderr intact", async () => {
  const failure = Object.assign(new Error("Cancelled"), {
    name: "AbortError",
    code: "ABORT_ERR",
    stderr: "",
  });
  vi.mocked(runStreamingCommand).mockRejectedValue(failure);
  await expect(runRalphWorktreeGit("workspace", ["status"])).rejects.toBe(
    failure,
  );
});
