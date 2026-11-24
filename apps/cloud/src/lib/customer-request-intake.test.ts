import { describe, expect, it } from "vitest";
import {
  parseCustomerRequest,
  requestFingerprint,
  requesterDomain,
} from "./customer-request-intake";

describe("parseCustomerRequest", () => {
  it("reads email, Slack, Teams and webhook payloads", () => {
    expect(
      parseCustomerRequest("email", {
        subject: "Export",
        text: "Need CSV",
        from: { address: "jane@acme.test" },
        messageId: "<1@acme.test>",
      }),
    ).toEqual({
      title: "Export",
      body: "Need CSV",
      requester: "jane@acme.test",
      externalId: "<1@acme.test>",
      customer: null,
    });
    expect(
      parseCustomerRequest("slack", {
        event: { text: "Dark mode\nplease", user: "U1", client_msg_id: "c1" },
      }),
    ).toMatchObject({
      title: "Dark mode",
      body: "Dark mode\nplease",
      requester: "U1",
      externalId: "c1",
    });
    expect(
      parseCustomerRequest("teams", {
        id: "t1",
        body: { content: "<p>SSO&nbsp;login</p>" },
        from: { name: "Ann" },
      }),
    ).toMatchObject({ title: "SSO login", requester: "Ann", externalId: "t1" });
    expect(
      parseCustomerRequest("webhook", {
        title: "Audit log",
        description: "Details",
        email: "a@globex.test",
        id: 42,
        customer: { name: "Globex", domain: "Globex.TEST" },
      }),
    ).toEqual({
      title: "Audit log",
      body: "Details",
      requester: "a@globex.test",
      externalId: null,
      customer: { name: "Globex", domain: "globex.test" },
    });
    expect(
      parseCustomerRequest("webhook", {
        title: "A",
        customer: "Initech",
      }),
    ).toMatchObject({ customer: { name: "Initech", domain: null } });
  });

  it("returns null for empty payloads", () => {
    expect(parseCustomerRequest("email", {})).toBeNull();
    expect(parseCustomerRequest("slack", { event: { text: "  " } })).toBeNull();
  });
});

describe("requestFingerprint", () => {
  it("ignores reply prefixes, case and punctuation", () => {
    expect(requestFingerprint("Re: Fwd: Export to CSV!")).toBe("export to csv");
    expect(requestFingerprint("AW:  export   to csv")).toBe("export to csv");
    expect(requestFingerprint("Exportar a CSV")).not.toBe("export to csv");
    expect(requestFingerprint("!!!")).toBe("");
  });
});

describe("requesterDomain", () => {
  it("extracts the email domain", () => {
    expect(requesterDomain("Jane <jane@Acme.test>")).toBe("acme.test");
    expect(requesterDomain("jane@acme.test")).toBe("acme.test");
    expect(requesterDomain("U123")).toBeNull();
    expect(requesterDomain("a@localhost")).toBeNull();
  });
});
