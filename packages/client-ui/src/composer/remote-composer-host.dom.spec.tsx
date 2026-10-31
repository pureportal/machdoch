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
    attachments: {
      select: (kind: string) => void;
      open: (attachment: unknown) => void;
    };
    pending: boolean;
  }) => (
    <>
      <button disabled={pending} onClick={() => attachments.select("files")}>
        Files
      </button>
      <button onClick={() => attachments.select("images")}>Images</button>
      <button onClick={() => attachments.select("folders")}>Folders</button>
      <button
        onClick={() =>
          attachments.open({
            id: "outside",
            source: "path",
            kind: "directory",
            name: "Outside",
            path: "D:\\Outside",
          })
        }
      >
        Outside folder
      </button>
    </>
  ),
}));

afterEach(cleanup);

function harness(workspace: string | null = "/workspace") {
  const invoke = vi
    .fn()
    .mockResolvedValue({ path: "", entries: [], nextOffset: null });
  const onCommand = vi.fn().mockResolvedValue(true);
  const upload = vi.fn().mockResolvedValue("/transfer/photo.png");
  const release = vi.fn().mockResolvedValue(undefined);
  const props = {
    session: { id: "session-1", workspace },
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
  it.each(["/workspace", null])(
    "browses an attached folder outside workspace %s",
    async (workspace) => {
      const { invoke } = harness(workspace);
      fireEvent.click(screen.getByText("Outside folder"));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(
          "list_context_attachment_directory",
          { path: "D:/Outside", offset: 0 },
        ),
      );
      expect(screen.getByRole("dialog", { name: "Outside" })).toBeTruthy();
    },
  );

  it("starts with source choices and opens the local file picker without confirmation", () => {
    const { invoke, onCommand } = harness();
    fireEvent.click(screen.getByText("Files"));
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const input = screen.getByLabelText("Upload attachments");
    const click = vi.spyOn(input, "click");
    fireEvent.click(
      screen.getByRole("button", { name: "Upload from this device" }),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("shows directory loading, counts selections, and retries attachment errors", async () => {
    const { invoke, onCommand } = harness();
    let finishBrowse!: (page: unknown) => void;
    invoke.mockReturnValueOnce(
      new Promise((resolve) => {
        finishBrowse = resolve;
      }),
    );
    fireEvent.click(screen.getByText("Files"));
    fireEvent.click(screen.getByText("Browse workspace"));
    expect(screen.getByRole("status").textContent).toBe("Loading files…");
    expect(screen.queryByText("Attaching…")).toBeNull();
    await act(async () =>
      finishBrowse({
        path: "",
        entries: [{ path: "report.txt", name: "report.txt", kind: "file" }],
        nextOffset: null,
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Attach",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select report.txt" }),
    );
    onCommand.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Attach (1)" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The attachments could not be added. Try again.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Attach (1)" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onCommand).toHaveBeenLastCalledWith({
      kind: "add-context-attachments",
      sessionId: "session-1",
      paths: ["/workspace/report.txt"],
    });
  });

  it("returns to source choices without leaving hidden workspace selections", async () => {
    const { invoke } = harness();
    invoke.mockResolvedValue({
      path: "",
      entries: [{ path: "report.txt", name: "report.txt", kind: "file" }],
      nextOffset: null,
    });
    fireEvent.click(screen.getByText("Files"));
    fireEvent.click(screen.getByText("Browse workspace"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select report.txt" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Back to attachment sources" }),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Attach \(/ })).toBeNull();
    fireEvent.click(screen.getByText("Browse workspace"));
    expect(
      (
        (await screen.findByRole("checkbox", {
          name: "Select report.txt",
        })) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });

  it("shows an empty image folder and omits files that cannot be selected", async () => {
    const { invoke } = harness();
    invoke.mockResolvedValue({
      path: "",
      entries: [{ path: "report.txt", name: "report.txt", kind: "file" }],
      nextOffset: null,
    });
    fireEvent.click(screen.getByText("Images"));
    fireEvent.click(screen.getByText("Browse workspace"));
    await screen.findByText("No images in this folder.");
    expect(screen.queryByText("report.txt")).toBeNull();
  });

  it("lets a failed directory load be retried", async () => {
    const { invoke } = harness();
    invoke.mockRejectedValueOnce(new Error("Device disconnected. Try again."));
    fireEvent.click(screen.getByText("Files"));
    fireEvent.click(screen.getByText("Browse workspace"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("No files in this folder.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps more files available when the first page contains no images", async () => {
    const { invoke } = harness();
    invoke.mockResolvedValueOnce({
      path: ".",
      entries: [{ path: "report.txt", name: "report.txt", kind: "file" }],
      nextOffset: 1,
    });
    fireEvent.click(screen.getByText("Images"));
    fireEvent.click(screen.getByText("Browse workspace"));
    const more = await screen.findByRole("button", { name: "More files" });
    expect(screen.queryByText("No images in this folder.")).toBeNull();
    invoke.mockResolvedValueOnce({
      path: ".",
      entries: [{ path: "photo.png", name: "photo.png", kind: "file" }],
      nextOffset: null,
    });
    fireEvent.click(more);
    await screen.findByRole("checkbox", { name: "Select photo.png" });
    expect(invoke).toHaveBeenLastCalledWith("list_workspace_directory", {
      workspaceRoot: "/workspace",
      relativePath: ".",
      offset: 1,
    });
  });

  it("keeps uploads available and explains browsing when there is no workspace", () => {
    harness(null);
    fireEvent.click(screen.getByText("Files"));
    expect(
      (
        screen.getByRole("button", {
          name: "Upload from this device",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Browse workspace",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText("Choose a workspace to browse files."),
    ).toBeTruthy();
  });

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
    expect(screen.getByRole("status").textContent).toBe("Uploading…");
    expect(
      (
        screen.getByRole("button", {
          name: "Upload from this device",
        }) as HTMLButtonElement
      ).disabled,
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
    fireEvent.click(screen.getByText("Browse workspace"));
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
      expect(
        (
          screen.getByRole("button", {
            name: "Up",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
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
      (
        screen.getByRole("button", {
          name: "Upload from this device",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
