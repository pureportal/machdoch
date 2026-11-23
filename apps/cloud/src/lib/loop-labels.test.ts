import { describe, expect, it } from "vitest";
import { centsToDollars, dollarsToCents } from "./loop-labels";

describe("loop labels", () => {
  it("shows a budget in dollars", () => {
    expect(centsToDollars(null)).toBe("");
    expect(centsToDollars(250)).toBe("2.50");
  });

  it("parses a dollar budget to cents", () => {
    expect(dollarsToCents("  ")).toBeNull();
    expect(dollarsToCents("2.5")).toBe(250);
    expect(dollarsToCents("0.019")).toBe(2);
  });

  it("rejects budgets below one cent", () => {
    expect(() => dollarsToCents("0")).toThrow("at least $0.01");
    expect(() => dollarsToCents("abc")).toThrow("at least $0.01");
  });
});
