import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environment: {} as Record<string, string>,
  runCli: vi.fn(),
  exit: vi.fn(),
  streams: [] as Array<
    EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      errored: Error | null;
    }
  >,
}));

vi.mock("./app.js", () => ({ runCli: mocks.runCli }));
vi.mock("node:process", () => ({
  default: {
    get env() {
      return mocks.environment;
    },
    argv: ["node", "machdoch"],
    get stdout() {
      return mocks.streams[0];
    },
    get stderr() {
      return mocks.streams[1];
    },
    stdin: { isTTY: false },
    exit: mocks.exit,
  },
}));

describe("CLI output lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.environment = {};
    mocks.exit.mockReset();
    mocks.runCli.mockReset().mockImplementation(() => new Promise(() => {}));
    mocks.streams = [0, 1].map(() =>
      Object.assign(new EventEmitter(), {
        errored: null as Error | null,
        write: vi.fn((_: string, callback?: (error: Error | null) => void) => {
          callback?.(null);
          return true;
        }),
      }),
    );
  });

  it("ends an ordinary command when its output consumer closes", async () => {
    await import("./main.js");
    mocks.streams[0]!.emit("error", { code: "EPIPE" });
    expect(mocks.exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ["run", 0],
    ["run", 1],
    ["resume", 0],
    ["resume", 1],
  ] as const)(
    "keeps a supervised Ralph %s worker alive after stream %s loses its consumer",
    async (command, stream) => {
      mocks.environment.MACHDOCH_RALPH_CANCEL_PATH = "ralph-stop.request";
      if (command === "run") {
        mocks.environment.MACHDOCH_RALPH_RUN_ID = "desktop-1-2-0";
      }
      await import("./main.js");
      mocks.streams[stream]!.emit("error", { code: "EPIPE" });
      expect(mocks.exit).not.toHaveBeenCalled();
    },
  );

  it("keeps unexpected output failures explicit", async () => {
    mocks.environment.MACHDOCH_RALPH_CANCEL_PATH = "ralph-stop.request";
    await import("./main.js");
    const error = Object.assign(new Error("output unavailable"), {
      code: "EIO",
    });
    expect(() => mocks.streams[1]!.emit("error", error)).toThrow(error);
    expect(mocks.exit).not.toHaveBeenCalled();
  });

  it("finishes after saving the run without flushing an already broken pipe", async () => {
    mocks.environment.MACHDOCH_RALPH_CANCEL_PATH = "ralph-stop.request";
    mocks.streams[1]!.errored = Object.assign(new Error("consumer exited"), {
      code: "EPIPE",
    });
    mocks.runCli.mockResolvedValue("run");
    await import("./main.js");
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalled());
    expect(mocks.streams[0]!.write).toHaveBeenCalledWith(
      "",
      expect.any(Function),
    );
    expect(mocks.streams[1]!.write).not.toHaveBeenCalled();
  });
});
