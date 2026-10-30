import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ComposerSurface } from "./composer-surface";

afterEach(cleanup);

const renderSurface = () =>
  render(
    <>
      <ComposerSurface
        modelPicker={<button type="button">Model</button>}
        workspacePicker={<button type="button">Workspace</button>}
        controls={<button type="button">Control</button>}
      >
        <textarea aria-label="Message" />
      </ComposerSurface>
      <button type="button">Outside</button>
    </>,
  );

const optionsToggle = () =>
  screen.getByRole("button", { name: "Composer options" });

it("keeps the options open while using them and closes on an outside press", () => {
  renderSurface();
  fireEvent.click(optionsToggle());
  expect(optionsToggle().getAttribute("aria-expanded")).toBe("true");

  fireEvent.pointerDown(screen.getByRole("button", { name: "Control" }));
  expect(optionsToggle().getAttribute("aria-expanded")).toBe("true");

  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(optionsToggle().getAttribute("aria-expanded")).toBe("false");
});

it("closes the options on Escape", () => {
  renderSurface();
  fireEvent.click(optionsToggle());
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(optionsToggle().getAttribute("aria-expanded")).toBe("false");
});
