// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsNumberInput } from "./settings-number-input";

afterEach(cleanup);

describe("Settings number editing", () => {
  it("rejects excess decimal precision instead of saving a different value", () => {
    const onValueChange = vi.fn();
    render(
      createElement(SettingsNumberInput, {
        value: 1.5,
        min: 0.1,
        max: 10,
        step: 0.1,
        onValueChange,
      }),
    );
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "2.55" } });
    fireEvent.blur(input);
    expect(screen.getByRole("alert").textContent).toContain("in steps of 0.1");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("allows clearing and replacing a value without saving intermediate numbers", () => {
    const onValueChange = vi.fn();
    render(
      createElement(SettingsNumberInput, {
        value: 6000,
        min: 100,
        max: 3600000,
        "aria-label": "Interval",
        onValueChange,
      }),
    );
    const input = screen.getByRole("spinbutton", {
      name: "Interval",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "7" } });
    expect(input.value).toBe("7");
    fireEvent.change(input, { target: { value: "7000" } });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(7000);
  });

  it.each(["", "0", "61", "1.5"])(
    "keeps invalid input %s visible with a recovery message",
    (value) => {
      const onValueChange = vi.fn();
      render(
        createElement(SettingsNumberInput, {
          value: 3,
          min: 1,
          max: 60,
          "aria-label": "Threshold",
          onValueChange,
        }),
      );
      const input = screen.getByRole("spinbutton") as HTMLInputElement;
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(input.value).toBe(value);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(screen.getByRole("alert").textContent).toBe(
        "Enter a whole number from 1 to 60.",
      );
      expect(onValueChange).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: "4" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(onValueChange).toHaveBeenCalledExactlyOnceWith(4);
    },
  );

  it("accepts decimal settings and preserves unfinished edits during external updates", () => {
    const onValueChange = vi.fn();
    const props = { value: 1.5, min: 0.1, max: 10, step: 0.1, onValueChange };
    const { rerender } = render(createElement(SettingsNumberInput, props));
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    rerender(createElement(SettingsNumberInput, { ...props, value: 2 }));
    expect(input.value).toBe("2");
    fireEvent.change(input, { target: { value: "2.5" } });
    rerender(createElement(SettingsNumberInput, { ...props, value: 3 }));
    expect(input.value).toBe("2.5");
    fireEvent.blur(input);
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(2.5);
  });
});
