import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  RalphFlowVariable,
  RalphInputField,
} from "../../../../core/ralph.js";
import {
  RalphInputControl,
  RalphSetupVariableControl,
} from "./ralph-input-controls";

describe("RalphInputControl", () => {
  it("normalizes file field text into trimmed path lists", () => {
    const onChange = vi.fn();
    const field: RalphInputField = {
      id: "assets",
      type: "files",
      label: "Assets",
    };

    render(
      <RalphInputControl field={field} value={[]} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Assets"), {
      target: { value: " src/a.ts \n\nsrc/b.ts " },
    });

    expect(onChange).toHaveBeenCalledWith(["src/a.ts", "src/b.ts"]);
  });

  it("returns numeric values and null for blank number fields", () => {
    const onChange = vi.fn();
    const field: RalphInputField = {
      id: "limit",
      type: "number",
      label: "Limit",
    };

    render(
      <RalphInputControl field={field} value={3} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Limit"), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByLabelText("Limit"), {
      target: { value: "" },
    });

    expect(onChange).toHaveBeenNthCalledWith(1, 8);
    expect(onChange).toHaveBeenNthCalledWith(2, null);
  });
});

describe("RalphSetupVariableControl", () => {
  it("renders boolean variables with normalized selected values", () => {
    const onChange = vi.fn();
    const variable: RalphFlowVariable = {
      name: "confirmed",
      type: "boolean",
      required: true,
      default: "false",
    };

    render(
      <RalphSetupVariableControl
        variable={variable}
        value="true"
        onChange={onChange}
      />,
    );

    expect(screen.getByLabelText<HTMLSelectElement>("Ralph variable confirmed").value).toBe("true");

    fireEvent.change(screen.getByLabelText("Ralph variable confirmed"), {
      target: { value: "false" },
    });

    expect(onChange).toHaveBeenCalledWith("confirmed", "false");
  });

  it("applies error accessibility attributes to setup variables", () => {
    const variable: RalphFlowVariable = {
      name: "workspace",
      type: "path",
      required: true,
    };

    render(
      <RalphSetupVariableControl
        variable={variable}
        value=""
        error="Required"
        errorId="workspace-error"
        onChange={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Ralph variable workspace");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("workspace-error");
  });
});
