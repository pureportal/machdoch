import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RemoteComposerHost,
  type RemoteComposerHostProps,
} from "./remote-composer-host";

vi.mock("./use-remote-composer-history", () => ({
  useRemoteComposerHistory: (props: RemoteComposerHostProps) => ({
    composer: props.composer,
    execute: props.onCommand,
  }),
}));
vi.mock("../file-preview/use-remote-file-preview", () => ({
  useRemoteFilePreview: () => ({ open: vi.fn(), dialog: null, error: null }),
}));
vi.mock("./remote-composer", () => ({
  RemoteComposer: ({
    attachments,
    pending,
  }: {
    attachments: { select: (kind: string) => void };
    pending: boolean;
  }) => (
    <>
      <button disabled={pending} onClick={() => attachments.select("files")}>
        Files
      </button>
      <button onClick={() => attachments.select("images")}>Images</button>
      <button onClick={() => attachments.select("folders")}>Folders</button>
    </>
  ),
}));

afterEach(cleanup);

function harness() {
  const invoke = vi
    .fn()
    .mockResolvedValue({ path: "", entries: [], nextOffset: null });
  const onCommand = vi.fn().mockResolvedValue(true);
  const upload = vi.fn().mockResolvedValue("/transfer/photo.png");
  const release = vi.fn().mockResolvedValue(undefined);
  const props = {
    session: { id: "session-1", workspace: "/workspace" },
    onCommand,
    workspaceTransport: { invoke, listen: vi.fn() },
    mediaTransport: { upload, release },
  } as unknown as RemoteComposerHostProps;
  const { rerender } = render(<RemoteComposerHost {...props} />);
  const switchSession = () =>
    rerender(
      <RemoteComposerHost
        {...props}
        session={{ ...props.session, id: "session-2" }}
      />,
    );
  return { invoke, onCommand, upload, release, switchSession };
}

describe("remote attachments", () => {
  it("unblocks the new session and discards an old directory request error", async () => {
    const { invoke, switchSession } = harness();
    let rejectBrowse!: (error: Error) => void;
    invoke.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectBrowse = reject;
      }),
    );
    fireEvent.click(screen.getByText("Folders"));
    expect((screen.getByText("Files") as HTMLButtonElement).disabled).toBe(
      true,
    );
    switchSession();
    expect((screen.getByText("Files") as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => rejectBrowse(new Error("Old device disconnected")));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a new session upload busy when the old session upload fails", async () => {
    const { upload, invoke, release, switchSession } = harness();
    let rejectOld!: (error: Error) => void;
    let finishNew!: (path: string) => void;
    upload.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectOld = reject;
      }),
    );
    upload.mockReturnValueOnce(
      new Promise((resolve) => {
        finishNew = resolve;
      }),
    );
    invoke.mockResolvedValue({ path: "/attachments/new-photo.png" });
    const file = new File(["photo"], "photo.png");
    fireEvent.click(screen.getByText("Files"));
    fireEvent.change(screen.getByLabelText("Upload attachments"), {
      target: { files: [file] },
    });
    switchSession();
    fireEvent.click(screen.getByText("Files"));
    fireEvent.change(screen.getByLabelText("Upload attachments"), {
      target: { files: [file] },
    });
    await act(async () => rejectOld(new Error("Old device disconnected")));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByText("Upload files") as HTMLButtonElement).disabled,
    ).toBe(true);
    finishNew("/transfer/new-photo.png");
    await waitFor(() =>
      expect(release).toHaveBeenCalledWith("/transfer/new-photo.png"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("browses the workspace root and returns from a child with a valid path", async () => {
    const { invoke } = harness();
    invoke.mockResolvedValueOnce({
      path: "",
      entries: [{ path: "photos", name: "photos", kind: "directory" }],
      nextOffset: null,
    });
    fireEvent.click(screen.getByText("Files"));
    fireEvent.click(screen.getByText("Browse device"));
    await screen.findByText("photos/");
    expect(invoke).toHaveBeenLastCalledWith("list_workspace_directory", {
      workspaceRoot: "/workspace",
      relativePath: ".",
      offset: 0,
    });
    invoke.mockResolvedValueOnce({
      path: "photos",
      entries: [],
      nextOffset: null,
    });
    fireEvent.click(screen.getByText("photos/"));
    await waitFor(() =>
      expect((screen.getByText("Up") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByText("Up"));
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith("list_workspace_directory", {
        workspaceRoot: "/workspace",
        relativePath: ".",
        offset: 0,
      }),
    );
  });

  it("uploads multiple phone files, imports them, and releases each transfer", async () => {
    const { invoke, upload, release, onCommand } = harness();
    invoke.mockResolvedValue({ path: "/attachments/photo.png" });
    fireEvent.click(screen.getByText("Images"));
    const input = screen.getByLabelText("Upload attachments");
    expect(input.getAttribute("accept")).toBe("image/*");
    expect(document.body.contains(input)).toBe(true);
    const files = [
      new File(["photo"], "photo.png"),
      new File(["other"], "other.png"),
    ];
    fireEvent.change(input, { target: { files } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(release).toHaveBeenCalledTimes(2));
    expect(upload).toHaveBeenNthCalledWith(1, files[0], "photo.png");
    expect(invoke).toHaveBeenNthCalledWith(1, "import_context_attachment", {
      path: "/transfer/photo.png",
      name: "photo.png",
    });
    expect(onCommand).toHaveBeenCalledWith({
      kind: "add-context-attachments",
      sessionId: "session-1",
      paths: ["/attachments/photo.png"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps a failed upload open so the same file can be selected again", async () => {
    const { upload, invoke, release } = harness();
    upload.mockRejectedValueOnce(new Error("Connection lost. Try again."));
    invoke.mockResolvedValue({ path: "/attachments/photo.png" });
    fireEvent.click(screen.getByText("Files"));
    const file = new File(["photo"], "photo.png");
    const input = screen.getByLabelText("Upload attachments");
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByRole("alert");
    expect(release).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("releases a transfer when importing fails and leaves a retry available", async () => {
    const { invoke, release } = harness();
    invoke.mockRejectedValue(new Error("Could not save the file. Try again."));
    fireEvent.click(screen.getByText("Files"));
    fireEvent.change(screen.getByLabelText("Upload attachments"), {
      target: { files: [new File(["data"], "report.txt")] },
    });
    await screen.findByRole("alert");
    expect(release).toHaveBeenCalledWith("/transfer/photo.png");
    expect(
      (screen.getByText("Upload files") as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
