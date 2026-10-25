// @vitest-environment jsdom
import { createElement, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import {
  CloudConnectionForm,
  type CloudConnectionDraft,
} from "./connection-form";
const picker = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: picker }));
vi.mock("../runtime", () => ({ openExternalUrl: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderForm() {
  function Harness() {
    const [visible, setVisible] = useState(true);
    const [draft, setDraft] = useState<CloudConnectionDraft>({
      origin: "https://cloud.example.test",
      workspaceRoot: "C:\\current",
      name: "",
      token: "",
    });
    return createElement(CommandProvider, {
      activeView: "chat",
      platform: "windows",
      runtime: "browser",
      children: createElement(
        TooltipProvider,
        null,
        createElement(
          "button",
          {
            onClick: () => {
              setDraft({
                origin: "https://new.example.test",
                workspaceRoot: "C:\\new",
                name: "New name",
                token: "new-secret",
              });
              setVisible(true);
            },
          },
          "New connection",
        ),
        visible
          ? createElement(CloudConnectionForm, {
              value: draft,
              existing: false,
              needsToken: true,
              busy: false,
              onChange: setDraft,
              onSubmit: () => {},
              onError: () => {},
              onCancel: () => setVisible(false),
            })
          : null,
      ),
    });
  }
  render(createElement(Harness));
}

it("a late directory choice preserves fields edited while the picker was open", async () => {
  let choose!: (path: string) => void;
  picker.mockReturnValue(
    new Promise<string>((resolve) => {
      choose = resolve;
    }),
  );
  renderForm();
  fireEvent.click(screen.getByRole("button", { name: "Choose workspace" }));
  fireEvent.change(screen.getByLabelText("Name", { exact: true }), {
    target: { value: "Kept name" },
  });
  fireEvent.change(screen.getByLabelText("Runner token"), {
    target: { value: "kept-secret" },
  });
  choose("C:\\selected");
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Workspace", { exact: true }) as HTMLInputElement)
        .value,
    ).toBe("C:\\selected"),
  );
  expect(
    (screen.getByLabelText("Name", { exact: true }) as HTMLInputElement).value,
  ).toBe("Kept name");
  expect(
    (screen.getByLabelText("Runner token") as HTMLInputElement).value,
  ).toBe("kept-secret");
});

it("a canceled form cannot restore its old folder or credential into a new connection draft", async () => {
  let choose!: (path: string) => void;
  picker.mockReturnValue(
    new Promise<string>((resolve) => {
      choose = resolve;
    }),
  );
  renderForm();
  fireEvent.change(screen.getByLabelText("Runner token"), {
    target: { value: "old-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Choose workspace" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "New connection" }));
  choose("C:\\old-selection");
  await Promise.resolve();
  expect(
    (screen.getByLabelText("Workspace", { exact: true }) as HTMLInputElement)
      .value,
  ).toBe("C:\\new");
  expect(
    (screen.getByLabelText("Runner token") as HTMLInputElement).value,
  ).toBe("new-secret");
});
