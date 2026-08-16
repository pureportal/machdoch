import { describe, expect, it } from "vitest";
import type { TaskExecutionControl, TaskResultProtocol } from "../types.ts";
import {
  createExternalAgentResultProtocolInstructions,
  parseExternalAgentProtocolResult,
} from "./external-agent-result-protocol.ts";

const getControlRecord = (
  protocol: TaskResultProtocol,
  label: string,
): string => {
  const prefix = `${label}: `;
  const line = createExternalAgentResultProtocolInstructions(protocol).find(
    (entry) => entry.startsWith(prefix),
  );
  if (!line) {
    throw new Error(`Missing control record for ${label}.`);
  }
  return line.slice(prefix.length);
};

describe("external agent result protocol", () => {
  it.each<{
    protocol: TaskResultProtocol;
    label: string;
    control: TaskExecutionControl;
  }>([
    {
      protocol: { kind: "ralph-iteration" },
      label: "CONTINUE",
      control: { kind: "ralph-iteration", decision: "CONTINUE" },
    },
    {
      protocol: { kind: "ralph-validator" },
      label: "RETRY",
      control: { kind: "ralph-validator", decision: "RETRY" },
    },
    {
      protocol: { kind: "ralph-route", labels: ["SHIP", "DEFER -->"] },
      label: "DEFER -->",
      control: { kind: "ralph-route", label: "DEFER -->" },
    },
  ])(
    "round-trips $label without exposing the control record",
    ({ protocol, label, control }) => {
      const record = getControlRecord(protocol, label);

      expect(
        parseExternalAgentProtocolResult(
          `Completed work.\r\n${record}\r\n`,
          protocol,
        ),
      ).toEqual({ answer: "Completed work.", control });
    },
  );

  it("rejects missing, repeated, misplaced, or wrong-protocol controls", () => {
    const iteration = { kind: "ralph-iteration" } as const;
    const done = getControlRecord(iteration, "DONE");
    const validatorDone = getControlRecord({ kind: "ralph-validator" }, "DONE");

    expect(
      parseExternalAgentProtocolResult("Completed work.", iteration),
    ).toBeUndefined();
    expect(
      parseExternalAgentProtocolResult(`${done}\n${done}`, iteration),
    ).toBeUndefined();
    expect(
      parseExternalAgentProtocolResult(`${done}\nMore prose.`, iteration),
    ).toBeUndefined();
    expect(
      parseExternalAgentProtocolResult(validatorDone, iteration),
    ).toBeUndefined();
  });
});
