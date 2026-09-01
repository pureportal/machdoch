import { describe, expect, it } from "vitest";
import { isLoopbackAddress, requestClientAddress } from "./network";

describe("Fleet Manager network boundaries", () => {
  it("recognizes IPv4, IPv6, and mapped loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackAddress("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.0.2.1")).toBe(false);
  });

  it("uses the hop appended by the local reverse proxy", () => {
    expect(
      requestClientAddress({
        headers: { "x-forwarded-for": "198.51.100.20, 203.0.113.4" },
        socket: { remoteAddress: "127.0.0.1" },
      }),
    ).toBe("203.0.113.4");
  });

  it("does not trust forwarded addresses from a non-loopback peer", () => {
    expect(
      requestClientAddress({
        headers: { "x-forwarded-for": "198.51.100.20" },
        socket: { remoteAddress: "203.0.113.4" },
      }),
    ).toBe("203.0.113.4");
  });

  it("falls back to the direct peer when the forwarded value is invalid", () => {
    expect(
      requestClientAddress({
        headers: { "x-forwarded-for": "not-an-address" },
        socket: { remoteAddress: "::1" },
      }),
    ).toBe("::1");
  });
});
