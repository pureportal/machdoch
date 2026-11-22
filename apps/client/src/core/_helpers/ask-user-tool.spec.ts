import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentControlEndpoint,
  AgentLiveState,
} from "@machdoch/fleet-protocol/task-thinking";
import { createAskUserToolSession } from "./ask-user-tool.js";
import type { AgentToolExecutionContext } from "./agent-tools-shared.js";

const createSession = (questionTimeoutMs: number | undefined) => {
  const lives: AgentLiveState[] = [];
  const controls: (AgentControlEndpoint | null)[] = [];
  const session = createAskUserToolSession({
    provider: "anthropic",
    model: "claude-opus-5-5",
    questionTimeoutMs,
    publish: (extras) => {
      if (extras.agentLive) lives.push(extras.agentLive);
      if (extras.agentControl !== undefined) controls.push(extras.agentControl);
    },
  });
  return { session, lives, controls };
};

const createContext = (signal?: AbortSignal): AgentToolExecutionContext =>
  ({
    workspaceRoot: process.cwd(),
    memory: {},
    ...(signal ? { signal } : {}),
  }) as unknown as AgentToolExecutionContext;

const waitForPendingQuestion = async (lives: AgentLiveState[]) => {
  await vi.waitFor(() => {
    expect(lives.at(-1)?.question?.status).toBe("pending");
  });
  return lives.at(-1)!.question!;
};

const postAnswer = (
  endpoint: AgentControlEndpoint,
  questionId: string,
  answers: Record<string, string>,
) =>
  fetch(`${endpoint.url}/v1/answer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ questionId, answers }),
  });

describe("ask_user tool", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the question on the live card and returns the user's answer", async () => {
    const { session, lives, controls } = createSession(600_000);
    const call = session.definition.execute(
      {
        questions: [
          { question: "Which database?", header: "Database", options: ["Postgres", "SQLite"] },
        ],
      },
      createContext(),
    );

    const question = await waitForPendingQuestion(lives);
    expect(lives.at(-1)).toMatchObject({ provider: "anthropic", transport: "api" });
    expect(question.items[0]).toMatchObject({
      id: "q1",
      header: "Database",
      options: [{ label: "Postgres" }, { label: "SQLite" }],
      allowOther: true,
    });
    expect(question.expiresAt).toBeGreaterThan(Date.now());
    const endpoint = controls[0]!;
    expect(endpoint.capabilities).toEqual(["answer"]);

    const stale = await postAnswer(endpoint, "native-0", { q1: "Postgres" });
    expect(stale.status).toBe(409);
    const answered = await postAnswer(endpoint, question.id, { q1: "Postgres" });
    expect(answered.status).toBe(200);

    const result = await call;
    expect(JSON.parse(result.toolResult.output)).toEqual({
      status: "answered",
      answers: [{ question: "Which database?", answer: "Postgres" }],
    });
    expect(lives.at(-1)?.question).toMatchObject({
      status: "answered",
      answers: { q1: "Postgres" },
    });

    await session.close();
    expect(controls.at(-1)).toBeNull();
  });

  it("tells the agent to decide on its own when the question times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { session, lives } = createSession(60_000);
    const call = session.definition.execute(
      { questions: [{ question: "Keep the old API?" }] },
      createContext(),
    );
    await waitForPendingQuestion(lives);

    await vi.advanceTimersByTimeAsync(60_000);

    const result = await call;
    expect(JSON.parse(result.toolResult.output)).toMatchObject({
      status: "unanswered",
      note: expect.stringContaining("did not answer within 1 minute"),
    });
    expect(lives.at(-1)?.question?.status).toBe("expired");
    await session.close();
  });

  it("cancels the question when the run stops", async () => {
    const abort = new AbortController();
    const { session, lives } = createSession(undefined);
    const call = session.definition.execute(
      { questions: [{ question: "Deploy now?" }] },
      createContext(abort.signal),
    );
    const question = await waitForPendingQuestion(lives);
    expect(question.expiresAt).toBeUndefined();

    abort.abort();

    const result = await call;
    expect(result.toolResult.isError).toBe(true);
    expect(lives.at(-1)?.question?.status).toBe("cancelled");
    await session.close();
  });

  it("opens no endpoint until the agent asks", async () => {
    const { session, lives, controls } = createSession(600_000);
    await session.close();
    expect(lives).toEqual([]);
    expect(controls).toEqual([]);
  });
});
