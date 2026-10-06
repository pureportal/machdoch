import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportEncryptedSettingsFile,
  inspectEncryptedSettingsFile,
  subscribeToSettingsTransfer,
} from "./settings-transfer";

const { invoke, download, release, remote } = vi.hoisted(() => {
  const invoke = vi.fn();
  return { invoke, download: vi.fn(), release: vi.fn(), remote: { invoke } };
});
vi.mock("./device-settings-platform", () => ({
  getRemoteDeviceSettingsPlatform: () => remote,
  getRemoteDeviceSettingsFiles: () => ({ download, release }),
  invokeDeviceSettingsCommand: invoke,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});
const categories = ["memory.global"] as const;

describe("remote encrypted settings files", () => {
  it("downloads only after the client successfully encrypts the export", async () => {
    const result = {
      categories: [...categories],
      itemCount: 1,
      fileBytes: 200,
    };
    let complete!: (value: unknown) => void;
    invoke.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const request = {
      categories: [...categories],
      destinationPath: "/transfers/export",
      passphrase: "a fixture passphrase",
    };
    const pending = exportEncryptedSettingsFile(request);
    expect(download).not.toHaveBeenCalled();
    complete(result);
    await expect(pending).resolves.toEqual(result);
    expect(invoke).toHaveBeenCalledWith("export_encrypted_settings_file", {
      request,
    });
    expect(download).toHaveBeenCalledWith(request.destinationPath);
  });

  it("preserves a selected destination when encryption fails so the user can retry", async () => {
    invoke.mockRejectedValue(new Error("Use a longer passphrase."));
    await expect(
      exportEncryptedSettingsFile({
        categories: [...categories],
        destinationPath: "/transfers/export",
        passphrase: "short",
      }),
    ).rejects.toThrow("longer passphrase");
    expect(download).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("removes the uploaded encrypted file after the device has retained the review", async () => {
    const review = {
      token: "review-token",
      categories: [],
      effectiveCategories: [...categories],
      fileCreatedAt: 1,
      reviewExpiresAt: 2,
    };
    invoke.mockResolvedValue(review);
    const request = {
      categories: [...categories],
      sourcePath: "/transfers/import",
      operationId: "a".repeat(32),
      passphrase: "a fixture passphrase",
    };
    await expect(inspectEncryptedSettingsFile(request)).resolves.toEqual(
      review,
    );
    expect(release).toHaveBeenCalledWith(request.sourcePath);
    expect(download).not.toHaveBeenCalled();
  });

  it("retains an uploaded file after a wrong passphrase", async () => {
    invoke.mockRejectedValue(new Error("The passphrase is incorrect."));
    await expect(
      inspectEncryptedSettingsFile({
        categories: [...categories],
        sourcePath: "/transfers/import",
        operationId: "a".repeat(32),
        passphrase: "wrong",
      }),
    ).rejects.toThrow("incorrect");
    expect(release).not.toHaveBeenCalled();
  });
});

describe("remote transfer status", () => {
  it("does not overlap refreshes or deliver a response after unsubscribing", async () => {
    vi.useFakeTimers();
    let complete!: (value: unknown) => void;
    invoke.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const onChange = vi.fn();
    const stop = await subscribeToSettingsTransfer(onChange);
    await vi.advanceTimersByTimeAsync(3000);
    expect(invoke).toHaveBeenCalledTimes(1);
    stop();
    complete({ phase: "completed" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
