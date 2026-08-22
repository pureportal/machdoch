import { discoverRalphFlowVariables } from "../ralph.js";
import { createFlow } from "./ralph-test-helpers.js";
describe("discoverRalphFlowVariables", () => {
  it("discovers prompt and attachment variables with defaults and types", () => {
    expect(
      discoverRalphFlowVariables(
        createFlow({
          blocks: [
            {
              id: "start",
              type: "START",
              title: "Start",
            },
            {
              id: "inspect",
              type: "PROMPT",
              title: "Inspect",
              prompt: "Inspect {{scope:path=ALL}} for {{enabled:boolean=true}}.",
              settings: {
                attachments: [
                  {
                    source: "variable",
                    value: "{{screenshot:image}}",
                  },
                ],
              },
            },
          ],
          edges: [],
        }),
      ),
    ).toEqual([
      {
        name: "enabled",
        type: "boolean",
        default: "true",
        required: false,
      },
      {
        name: "scope",
        type: "path",
        default: "ALL",
        required: false,
      },
      {
        name: "screenshot",
        type: "image",
        required: true,
      },
    ]);
  });

  it("treats SET_VARIABLE utility output names as run-produced variables", () => {
    expect(
      discoverRalphFlowVariables(
        createFlow({
          blocks: [
            {
              id: "start",
              type: "START",
              title: "Start",
            },
            {
              id: "set-scope",
              type: "UTILITY",
              title: "Set Scope",
              utility: {
                type: "SET_VARIABLE",
                variableName: "scope",
                value: "src/core",
              },
            },
            {
              id: "use-scope",
              type: "PROMPT",
              title: "Use Scope",
              prompt: "Use {{scope:path}}.",
            },
          ],
          edges: [],
        }),
      ),
    ).toEqual([
      {
        name: "scope",
        type: "path",
        required: false,
      },
    ]);
  });
});


