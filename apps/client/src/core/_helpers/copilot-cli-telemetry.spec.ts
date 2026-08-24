import { describe, expect, it } from "vitest";
import { parseCopilotCliTelemetry } from "./copilot-cli-telemetry.js";

describe("Copilot CLI telemetry", () => {
  it("sums every provider chat span without double-counting invoke-agent totals", () => {
    const telemetry = parseCopilotCliTelemetry(
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    attributes: {
                      "gen_ai.operation.name": "invoke_agent",
                      "gen_ai.usage.input_tokens": 350,
                      "gen_ai.usage.output_tokens": 45,
                      "github.copilot.turn_count": 2,
                    },
                  },
                  {
                    attributes: {
                      "gen_ai.operation.name": "chat",
                      "gen_ai.usage.input_tokens": 150,
                      "gen_ai.usage.output_tokens": 20,
                      "gen_ai.usage.cache_read.input_tokens": 90,
                    },
                  },
                  {
                    attributes: {
                      "gen_ai.operation.name": "chat",
                      "gen_ai.usage.input_tokens": 200,
                      "gen_ai.usage.output_tokens": 25,
                      "gen_ai.usage.cache_creation.input_tokens": 40,
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(telemetry).toEqual({
      modelCallCount: 2,
      usage: {
        inputTokens: 350,
        outputTokens: 45,
        totalTokens: 395,
        cachedInputTokens: 90,
        cacheReadInputTokens: 90,
        cacheWriteInputTokens: 40,
      },
    });
  });

  it("reads OpenTelemetry key-value attributes and selects the top-level aggregate", () => {
    const attribute = (key: string, value: unknown) => ({ key, value });
    const telemetry = parseCopilotCliTelemetry(
      [
        "not-json",
        JSON.stringify({
          spans: [
            {
              attributes: [
                attribute("gen_ai.operation.name", {
                  stringValue: "invoke_agent",
                }),
                attribute("gen_ai.usage.input_tokens", { intValue: "900" }),
                attribute("gen_ai.usage.output_tokens", { intValue: "80" }),
                attribute("github.copilot.turn_count", { intValue: "5" }),
              ],
            },
            {
              attributes: [
                attribute("gen_ai.operation.name", {
                  stringValue: "invoke_agent",
                }),
                attribute("server.address", { stringValue: "api.github.com" }),
                attribute("gen_ai.usage.input_tokens", { intValue: "500" }),
                attribute("gen_ai.usage.output_tokens", { intValue: "60" }),
                attribute("gen_ai.usage.cache_read.input_tokens", {
                  intValue: "300",
                }),
                attribute("github.copilot.turn_count", { intValue: "3" }),
              ],
            },
          ],
        }),
      ].join("\n"),
    );

    expect(telemetry).toEqual({
      modelCallCount: 3,
      usage: {
        inputTokens: 500,
        outputTokens: 60,
        totalTokens: 560,
        cachedInputTokens: 300,
        cacheReadInputTokens: 300,
      },
    });
  });

  it("reports model calls even when a failed span has no token usage", () => {
    expect(
      parseCopilotCliTelemetry(
        JSON.stringify({
          attributes: { "gen_ai.operation.name": "chat" },
        }),
      ),
    ).toEqual({ modelCallCount: 1 });
  });
});
