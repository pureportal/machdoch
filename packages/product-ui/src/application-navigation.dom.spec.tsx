import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageSquareText, Settings2 } from "lucide-react";
import { afterEach, expect, it, vi } from "vitest";
import { ApplicationNavigation } from "./application-navigation";
import { AppearanceOptions } from "./appearance-options";
import { useBrowserAppearance } from "./use-browser-appearance";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.density;
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

it("keeps the selected view, activity and keyboard shortcut on the shared navigation control", () => {
  const select = vi.fn();
  render(
    <ApplicationNavigation
      items={[
        {
          id: "chat",
          label: "Chat",
          icon: MessageSquareText,
          active: true,
          activity: "running",
          shortcut: { label: "Ctrl+1", ariaKeyShortcuts: "Control+1" },
          onSelect: select,
        },
      ]}
      actions={[
        {
          id: "settings",
          label: "Settings",
          icon: Settings2,
          href: "/settings",
        },
      ]}
    />,
  );
  const chat = screen.getByRole("button", { name: "Chat, running" });
  expect(chat.getAttribute("aria-current")).toBe("page");
  expect(chat.getAttribute("aria-keyshortcuts")).toBe("Control+1");
  expect(chat.querySelector('[data-activity="running"]')).toBeTruthy();
  fireEvent.click(chat);
  expect(select).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("link", { name: "Settings" }).getAttribute("href"),
  ).toBe("/settings");
});

function BrowserPreferences(): React.ReactElement {
  const appearance = useBrowserAppearance();
  return (
    <AppearanceOptions
      settings={appearance.settings}
      onChange={appearance.save}
    />
  );
}

it("persists appearance changes and reapplies them after navigation", () => {
  const first = render(<BrowserPreferences />);
  fireEvent.click(screen.getByRole("button", { name: "Light" }));
  fireEvent.click(screen.getByRole("button", { name: "Violet" }));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.dataset.accent).toBe("violet");
  first.unmount();
  render(<BrowserPreferences />);
  expect(
    screen.getByRole("button", { name: "Light" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen.getByRole("button", { name: "Violet" }).getAttribute("aria-pressed"),
  ).toBe("true");
  localStorage.setItem(
    "machdoch.desktop.appearance-state",
    JSON.stringify({
      version: 1,
      theme: "dark",
      accent: "emerald",
      density: "compact",
    }),
  );
  fireEvent(
    window,
    new StorageEvent("storage", { key: "machdoch.desktop.appearance-state" }),
  );
  expect(
    screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(document.documentElement.dataset.density).toBe("compact");
  expect(document.documentElement.dataset.accent).toBe("emerald");
});
