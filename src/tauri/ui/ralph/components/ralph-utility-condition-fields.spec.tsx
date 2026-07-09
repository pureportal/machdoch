import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RalphUtilityCondition } from "../../../../core/ralph.js";
import { RalphUtilityConditionFields } from "./ralph-utility-condition-fields";

afterEach(() => {
  cleanup();
});

describe("RalphUtilityConditionFields", () => {
  it("renders the default simple condition when no condition is configured", () => {
    render(
      <RalphUtilityConditionFields
        condition={undefined}
        inspectorTwoColumnClass="grid-cols-2"
        onChange={vi.fn()}
      />,
    );

    expect(
      (screen.getByLabelText("Utility condition style") as HTMLSelectElement)
        .value,
    ).toBe("simple");
    expect(
      (
        screen.getByLabelText(
          "Utility condition expression",
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("status == 200");
  });

  it("updates expression conditions with the existing condition state", () => {
    const onChange = vi.fn();
    const condition: RalphUtilityCondition = {
      style: "javascript",
      expression: "result.ok",
    };

    render(
      <RalphUtilityConditionFields
        condition={condition}
        inspectorTwoColumnClass="grid-cols-2"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Utility condition expression"), {
      target: { value: "result.status === 201" },
    });

    expect(onChange).toHaveBeenCalledWith({
      style: "javascript",
      expression: "result.status === 201",
    });
  });

  it("renders JSON path controls and preserves fields when updating the operator", () => {
    const onChange = vi.fn();
    const condition: RalphUtilityCondition = {
      style: "json-path",
      path: "body.state",
      operator: "equals",
      value: "done",
    };

    render(
      <RalphUtilityConditionFields
        condition={condition}
        inspectorTwoColumnClass="grid-cols-2"
        onChange={onChange}
      />,
    );

    expect(
      (screen.getByLabelText("Utility condition path") as HTMLInputElement)
        .value,
    ).toBe("body.state");

    fireEvent.change(screen.getByLabelText("Utility condition operator"), {
      target: { value: "not-equals" },
    });

    expect(onChange).toHaveBeenCalledWith({
      style: "json-path",
      path: "body.state",
      operator: "not-equals",
      value: "done",
    });
  });
});
