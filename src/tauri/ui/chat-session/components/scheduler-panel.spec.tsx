import {
  getSchedulerRalphParamEditorValue,
  setSchedulerRalphParam,
} from "./scheduler-panel";

describe("scheduler Ralph typed parameters", () => {
  it("removes an empty typed value so the flow default remains authoritative", () => {
    expect(
      setSchedulerRalphParam(
        "enableInterview=true\nfeatureRequest=Build it",
        "enableInterview",
        "",
      ),
    ).toBe("featureRequest=Build it");
  });

  it("canonicalizes a typed value into the advanced parameter representation", () => {
    expect(setSchedulerRalphParam("featureRequest=Build it", "maxPasses", "4"))
      .toBe("featureRequest=Build it\nmaxPasses=4");
  });

  it("keeps absent fields visually empty so defaults are not mistaken for overrides", () => {
    expect(getSchedulerRalphParamEditorValue("featureRequest=Build it", "maxPasses"))
      .toBe("");
  });
});
