import { describe, expect, it } from "vitest";
import {
  slaDuration,
  slaPolicyInputSchema,
  slaState,
  slaTimeLeft,
} from "./issue-sla";

const now = new Date("2030-01-01T12:00:00.000Z");
const after = (minutes: number) =>
  new Date(now.getTime() + minutes * 60_000).toISOString();

describe("issue SLA", () => {
  it("classifies the SLA state", () => {
    expect(slaState(null, now)).toBe("none");
    expect(slaState(after(-1), now)).toBe("breached");
    expect(slaState(after(0), now)).toBe("breached");
    expect(slaState(after(24 * 60), now)).toBe("at_risk");
    expect(slaState(after(24 * 60 + 1), now)).toBe("ok");
  });

  it("formats the time left", () => {
    expect(slaTimeLeft(after(-5), now)).toBe("Breached");
    expect(slaTimeLeft(after(45), now)).toBe("45m");
    expect(slaTimeLeft(after(47 * 60 + 30), now)).toBe("47h");
    expect(slaTimeLeft(after(72 * 60), now)).toBe("3d");
  });

  it("formats policy durations", () => {
    expect(slaDuration(48)).toBe("2d");
    expect(slaDuration(36)).toBe("36h");
  });

  it("requires a priority or a label", () => {
    const teamId = "00000000-0000-4000-8000-000000000001";
    expect(
      slaPolicyInputSchema.safeParse({
        teamId,
        priority: null,
        labelId: null,
        hours: 4,
      }).success,
    ).toBe(false);
    expect(
      slaPolicyInputSchema.safeParse({
        teamId,
        priority: "urgent",
        labelId: null,
        hours: 4,
      }).success,
    ).toBe(true);
    expect(
      slaPolicyInputSchema.safeParse({
        teamId,
        priority: "urgent",
        labelId: null,
        hours: 0,
      }).success,
    ).toBe(false);
  });
});
