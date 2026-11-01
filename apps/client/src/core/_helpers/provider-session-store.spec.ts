import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationHistoryEntry } from "../types.js";
import {
  hasAlignedProviderSession,
  planProviderSessionRun,
  pruneProviderSessions,
  withProviderSessionLock,
} from "./provider-session-store.js";

const entry = (
  role: ConversationHistoryEntry["role"],
  content: string,
): ConversationHistoryEntry => ({ role, content });

const firstMessages = [entry("user", "one"), entry("assistant", "two")];
const nextMessages = [
  ...firstMessages,
  entry("user", "three"),
  entry("assistant", "four"),
];

let directory: string;
const target = () => ({ chatSessionId: "chat", workspaceRoot: directory });

const plan = (
  overrides: Partial<Parameters<typeof planProviderSessionRun>[1]> = {},
) =>
  planProviderSessionRun(target(), {
    provider: "claude-cli",
    instructionDigest: "instructions",
    history: firstMessages,
    continuing: false,
    ...overrides,
  });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "machdoch-provider-session-"));
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("provider session continuity", () => {
  it("starts a new conversation when the chat has none", async () => {
    expect((await plan()).resumeId).toBeUndefined();
  });

  it("continues after the exchange the conversation already saw", async () => {
    await (await plan()).save("session-1");
    const next = await plan({ history: nextMessages });
    expect(next.resumeId).toBe("session-1");
    expect(
      await hasAlignedProviderSession(target(), "claude-cli", nextMessages),
    ).toBe(true);
  });

  it("starts over and drops transcripts after switching provider", async () => {
    const first = await plan();
    await writeFile(join(first.storePath, "transcript.jsonl"), "old");
    await first.save("session-1");
    const switched = await plan({
      provider: "codex-cli",
      history: nextMessages,
    });
    expect(switched.resumeId).toBeUndefined();
    expect(await readdir(switched.storePath)).toEqual([]);
    expect(
      await hasAlignedProviderSession(target(), "codex-cli", nextMessages),
    ).toBe(false);
  });

  it("does not return to a provider's old conversation after another provider ran", async () => {
    await (await plan()).save("claude-session");
    await (
      await plan({ provider: "codex-cli", history: nextMessages })
    ).save("codex-session");
    const back = await plan({
      history: [
        ...nextMessages,
        entry("user", "five"),
        entry("assistant", "six"),
      ],
    });
    expect(back.resumeId).toBeUndefined();
  });

  it("starts over when turns happened that it never saw", async () => {
    await (await plan()).save("session-1");
    const next = await plan({
      history: [
        ...nextMessages,
        entry("user", "five"),
        entry("assistant", "from an API provider"),
      ],
    });
    expect(next.resumeId).toBeUndefined();
  });

  it("starts over when an earlier message was edited", async () => {
    await (await plan()).save("session-1");
    const next = await plan({
      history: [entry("user", "edited"), ...nextMessages.slice(1)],
    });
    expect(next.resumeId).toBeUndefined();
  });

  it("starts over when the last exchange was removed for a retry", async () => {
    await (await plan()).save("session-1");
    expect((await plan()).resumeId).toBeUndefined();
  });

  it("starts over when the instructions changed", async () => {
    await (await plan()).save("session-1");
    const next = await plan({
      history: nextMessages,
      instructionDigest: "changed",
    });
    expect(next.resumeId).toBeUndefined();
  });

  it("keeps a chat's conversations apart per workspace", async () => {
    await (await plan()).save("session-1");
    const elsewhere = await planProviderSessionRun(
      { chatSessionId: "chat", workspaceRoot: join(directory, "other") },
      {
        provider: "claude-cli",
        instructionDigest: "instructions",
        history: nextMessages,
        continuing: false,
      },
    );
    expect(elsewhere.resumeId).toBeUndefined();
  });

  it("continues a goal's later turns and keeps the chat's position", async () => {
    await (await plan()).save("session-1");
    const later = await plan({
      continuing: true,
      history: [...firstMessages, entry("user", "internal directive")],
    });
    expect(later.resumeId).toBe("session-1");
    await later.save("session-1");
    expect((await plan({ history: nextMessages })).resumeId).toBe("session-1");
  });

  it("starts over after its binding is cleared", async () => {
    const first = await plan();
    await first.save("session-1");
    await first.clear();
    expect((await plan({ history: nextMessages })).resumeId).toBeUndefined();
  });
});

describe("provider session lock", () => {
  it("runs a second run at the same time without a session", async () => {
    let release!: () => void;
    const holding = withProviderSessionLock(
      target(),
      () => new Promise<string>((resolve) => (release = () => resolve("held"))),
      async () => "busy",
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(
      withProviderSessionLock(
        target(),
        async () => "second",
        async () => "busy",
      ),
    ).resolves.toBe("busy");
    release();
    await expect(holding).resolves.toBe("held");
  });

  it("does not hide failures from inside the run", async () => {
    await expect(
      withProviderSessionLock(
        target(),
        async () => {
          throw new Error("provider failed");
        },
        async () => "busy",
      ),
    ).rejects.toThrow("provider failed");
  });
});

describe("provider session retention", () => {
  it("removes only conversations that have not run for 30 days", async () => {
    const root = join(directory, "provider-sessions");
    const old = join(root, "old");
    const recent = join(root, "recent");
    await mkdir(old, { recursive: true });
    await mkdir(recent, { recursive: true });
    await writeFile(join(old, "binding.json"), "{}");
    await writeFile(join(recent, "binding.json"), "{}");
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(join(old, "binding.json"), longAgo, longAgo);
    await pruneProviderSessions();
    expect(await readdir(root)).toEqual(["recent"]);
  });
});
