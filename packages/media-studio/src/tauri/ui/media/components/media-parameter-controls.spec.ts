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

  it("swaps the face limit for voxel settings when voxelizing", () => {
    const { rerender } = renderMeshFields(DEFAULT_MESH_RECIPE_SETTINGS);
    expect(screen.queryByText("Face limit")).not.toBeNull();
    expect(screen.queryByText("Voxel resolution")).toBeNull();

    rerender(
      createElement(MediaParameterFields<MediaMeshRecipeSettings>, {
        idPrefix: "mesh",
        fields: MESH_GENERATION_FIELDS.filter((field) => field.id !== "modelId"),
        values: { ...DEFAULT_MESH_RECIPE_SETTINGS, voxelize: true },
        onChange: () => {},
      }),
    );
    expect(screen.queryByText("Face limit")).toBeNull();
    expect(screen.queryByText("Voxel resolution")).not.toBeNull();
    expect(screen.queryByText("Voxel fill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /more options/i }));
    expect(screen.queryByText("Voxel fill")).not.toBeNull();
  });
});
