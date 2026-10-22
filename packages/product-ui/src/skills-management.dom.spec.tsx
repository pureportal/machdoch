import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SkillsManagement,
  type ManagedSkill,
  type SkillsManagementProps,
} from "./skills-management";

const dialogMethods = {
  showModal: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal"),
  close: Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close"),
};

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});

afterEach(() => {
  cleanup();
  for (const [name, descriptor] of Object.entries(dialogMethods)) {
    if (descriptor) {
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    }
  }
});

const review: ManagedSkill = {
  name: "code-review",
  description: "Review pull requests.",
  content: "Check correctness and tests.",
  enabled: true,
  fingerprint: "a".repeat(64),
  path: "/skills/code-review/SKILL.md",
};

const docs: ManagedSkill = {
  name: "write-docs",
  description: "Write documentation.",
  content: "Include a glossary.",
  enabled: false,
  fingerprint: "b".repeat(64),
  path: "/skills/write-docs/SKILL.disabled.md",
};

const renderLibrary = (overrides: Partial<SkillsManagementProps> = {}) => {
  const props: SkillsManagementProps = {
    listSkills: vi.fn().mockResolvedValue([review, docs]),
    saveSkill: vi.fn().mockResolvedValue(review),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ...render(<SkillsManagement {...props} />), props };
};

const change = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

it("loads skills and searches names, descriptions, and content without changing the editor", async () => {
  renderLibrary();
  expect(screen.getByRole("status").textContent).toBe("Loading skills…");
  expect((screen.getByRole("button", { name: "New skill" }) as HTMLButtonElement).disabled).toBe(true);

  await screen.findByRole("button", { name: review.name });
  expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);

  for (const query of ["WRITE", "documentation", " glossary "]) {
    change("Search skills", query);
    expect(screen.getByRole("button", { name: docs.name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: review.name })).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(review.name);
  }

  change("Search skills", "unknown");
  expect(screen.getByText("No matching skills.")).toBeTruthy();
  change("Search skills", "");
  fireEvent.click(screen.getByRole("button", { name: docs.name }));
  expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("false");
});

it("creates an enabled skill without an expected fingerprint and uses the saved result", async () => {
  const saved = { ...review, name: "new-skill", content: "Saved content." };
  const saveSkill = vi.fn().mockResolvedValue(saved);
  renderLibrary({ listSkills: vi.fn().mockResolvedValue([]), saveSkill });
  await screen.findByText("No skills.");

  expect(screen.getByRole("switch", { name: "Enabled" }).getAttribute("aria-checked")).toBe("true");
  change("Name", saved.name);
  change("Description", review.description);
  change("Content", "Draft content.");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(saveSkill).toHaveBeenCalledWith({
    name: saved.name,
    description: review.description,
    content: "Draft content.",
    enabled: true,
  }));
  await screen.findByRole("button", { name: saved.name });
  expect((screen.getByLabelText("Content") as HTMLTextAreaElement).value).toBe(saved.content);
  expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});

it("uses the current fingerprint for updates and blocks duplicate saves while pending", async () => {
  const firstSave = deferred<ManagedSkill>();
  const saved = { ...review, content: "Revised content.", enabled: false, fingerprint: "c".repeat(64) };
  const saveSkill = vi.fn()
    .mockReturnValueOnce(firstSave.promise)
    .mockResolvedValueOnce({ ...saved, description: "Revised description." });
  renderLibrary({ saveSkill });
  await screen.findByRole("button", { name: review.name });

  change("Content", saved.content);
  fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.submit(screen.getByRole("form", { name: "Edit skill" }));

  expect(saveSkill).toHaveBeenCalledTimes(1);
  expect(saveSkill).toHaveBeenLastCalledWith({
    name: review.name,
    description: review.description,
    content: saved.content,
    enabled: false,
    expectedFingerprint: review.fingerprint,
  });
  for (const label of ["Saving…", "Reload", "New skill", "Delete", docs.name]) {
    expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
  }

  await act(async () => firstSave.resolve(saved));
  change("Description", "Revised description.");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(saveSkill).toHaveBeenLastCalledWith({
    name: review.name,
    description: "Revised description.",
    content: saved.content,
    enabled: false,
    expectedFingerprint: saved.fingerprint,
  }));
});

it.each(["select", "new", "reload"] as const)(
  "protects dirty edits before %s and lets the user cancel or discard",
  async (action) => {
    const refreshed = { ...review, content: "Changed elsewhere.", fingerprint: "d".repeat(64) };
    const listSkills = vi.fn()
      .mockResolvedValueOnce([review, docs])
      .mockResolvedValue([refreshed, docs]);
    renderLibrary({ listSkills });
    await screen.findByRole("button", { name: review.name });
    change("Content", "Unsaved content.");

    const actionLabel = action === "select" ? docs.name : action === "new" ? "New skill" : "Reload";
    fireEvent.click(screen.getByRole("button", { name: actionLabel }));
    let dialog = screen.getByRole("dialog", { name: "Discard changes?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Content") as HTMLTextAreaElement).value).toBe("Unsaved content.");
    expect(listSkills).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: actionLabel }));
    dialog = screen.getByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect((screen.getByLabelText("Content") as HTMLTextAreaElement).value).toBe(
      action === "select" ? docs.content : action === "new" ? "" : refreshed.content,
    ));
    expect(screen.queryByRole("dialog")).toBeNull();
    if (action === "new") {
      expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    }
  },
);

it("keeps a new draft when cancelling selection and dismisses confirmation with Escape", async () => {
  renderLibrary();
  await screen.findByRole("button", { name: review.name });
  fireEvent.click(screen.getByRole("button", { name: "New skill" }));
  change("Name", "new-skill");
  change("Content", "Unfinished.");
  fireEvent.click(screen.getByRole("button", { name: docs.name }));
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));

  expect(screen.queryByRole("dialog")).toBeNull();
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("new-skill");
  expect((screen.getByLabelText("Content") as HTMLTextAreaElement).value).toBe("Unfinished.");
});

it("requires deletion confirmation, preserves failures, and deletes with the fingerprint", async () => {
  const deletion = deferred<unknown>();
  const deleteSkill = vi.fn()
    .mockRejectedValueOnce(new Error("The skill changed. Reload it before deleting."))
    .mockReturnValueOnce(deletion.promise);
  renderLibrary({ deleteSkill });
  await screen.findByRole("button", { name: review.name });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  let dialog = screen.getByRole("dialog", { name: `Delete “${review.name}”?` });
  expect(deleteSkill).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(deleteSkill).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("The skill changed. Reload it before deleting.");
  expect(screen.getByRole("button", { name: review.name })).toBeTruthy();
  expect(deleteSkill).toHaveBeenLastCalledWith(review.name, review.fingerprint);

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  expect((screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => deletion.resolve(undefined));
  expect(screen.queryByRole("button", { name: review.name })).toBeNull();
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(docs.name);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retries a failed load and preserves the draft and fingerprint after a failed save", async () => {
  const listSkills = vi.fn()
    .mockRejectedValueOnce(new Error("Could not connect. Try reloading."))
    .mockResolvedValue([review]);
  const saveSkill = vi.fn()
    .mockRejectedValueOnce(new Error("The skill changed. Reload it before saving."))
    .mockResolvedValue({ ...review, content: "Unsaved.", fingerprint: "e".repeat(64) });
  renderLibrary({ listSkills, saveSkill });
  expect((await screen.findByRole("alert")).textContent).toBe("Could not connect. Try reloading.");
  expect(screen.queryByText("No skills.")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByRole("button", { name: review.name });
  change("Content", "Unsaved.");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The skill changed. Reload it before saving.");
  expect((screen.getByLabelText("Content") as HTMLTextAreaElement).value).toBe("Unsaved.");

  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(saveSkill).toHaveBeenCalledTimes(2);
  expect(saveSkill).toHaveBeenLastCalledWith({
    name: review.name,
    description: review.description,
    content: "Unsaved.",
    enabled: true,
    expectedFingerprint: review.fingerprint,
  });
});

it("ignores a superseded list request", async () => {
  const oldList = deferred<ManagedSkill[]>();
  const { rerender, props } = renderLibrary({ listSkills: () => oldList.promise });
  rerender(<SkillsManagement {...props} listSkills={vi.fn().mockResolvedValue([docs])} />);
  await screen.findByRole("button", { name: docs.name });
  await act(async () => oldList.resolve([review]));

  expect(screen.queryByRole("button", { name: review.name })).toBeNull();
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(docs.name);
});
