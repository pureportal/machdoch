// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MESH_RECIPE_SETTINGS } from "../../../../core/media/mesh-flow.js";
import { MESH_GENERATION_FIELDS } from "../../../../core/media/mesh-nodes.js";
import type { MediaMeshRecipeSettings } from "../../../../core/media/contracts.js";
import { MediaParameterFields } from "./media-parameter-controls";

const renderMeshFields = (settings: MediaMeshRecipeSettings) =>
  render(
    createElement(MediaParameterFields<MediaMeshRecipeSettings>, {
      idPrefix: "mesh",
      fields: MESH_GENERATION_FIELDS.filter((field) => field.id !== "modelId"),
      values: settings,
      onChange: () => {},
    }),
  );

describe("media parameter fields", () => {
  afterEach(cleanup);

  const rerenderMeshFields = (
    rerender: (element: ReturnType<typeof createElement>) => void,
    settings: MediaMeshRecipeSettings,
  ) =>
    rerender(
      createElement(MediaParameterFields<MediaMeshRecipeSettings>, {
        idPrefix: "mesh",
        fields: MESH_GENERATION_FIELDS.filter((field) => field.id !== "modelId"),
        values: settings,
        onChange: () => {},
      }),
    );

  it("shows the settings that belong to the chosen style", () => {
    const { rerender } = renderMeshFields(DEFAULT_MESH_RECIPE_SETTINGS);
    expect(screen.getByRole("radio", { name: "Smooth" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Face limit")).not.toBeNull();
    expect(screen.queryByText("Voxel resolution")).toBeNull();
    expect(screen.queryByText("Polygon count")).toBeNull();

    rerenderMeshFields(rerender, { ...DEFAULT_MESH_RECIPE_SETTINGS, style: "voxel" });
    expect(screen.queryByText("Face limit")).toBeNull();
    expect(screen.queryByText("Voxel resolution")).not.toBeNull();
    expect(screen.queryByText("Voxel fill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    expect(screen.queryByText("Voxel fill")).not.toBeNull();

    rerenderMeshFields(rerender, { ...DEFAULT_MESH_RECIPE_SETTINGS, style: "low-poly" });
    expect(screen.queryByText("Voxel resolution")).toBeNull();
    expect(screen.queryByText("Polygon count")).not.toBeNull();
  });

  it("reports the chosen style", () => {
    const changes: MediaMeshRecipeSettings[] = [];
    render(
      createElement(MediaParameterFields<MediaMeshRecipeSettings>, {
        idPrefix: "mesh",
        fields: MESH_GENERATION_FIELDS.filter((field) => field.id !== "modelId"),
        values: DEFAULT_MESH_RECIPE_SETTINGS,
        onChange: (settings) => changes.push(settings),
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Low poly" }));
    expect(changes.at(-1)?.style).toBe("low-poly");
  });
});
