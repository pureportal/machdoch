import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createWebRequest, IncomingRequestError } from "./http-request";

describe("Fleet Manager HTTP request conversion", () => {
  it("uses the configured external origin instead of the inbound Host header", async () => {
    const request = incomingRequest("POST", ["{}"], {
      host: "attacker.example",
      "content-type": "application/json",
    });

    const converted = await createWebRequest(
      request,
      "https://fleet.example.test",
      1024,
    );

    expect(converted.url).toBe("https://fleet.example.test/api/test?value=1");
  });

  it("rejects bodies on GET and HEAD requests", async () => {
    for (const method of ["GET", "HEAD"]) {
      await expect(
        createWebRequest(
          incomingRequest(method, ["unexpected"]),
          "https://fleet.example.test",
          1024,
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it("rejects methods that Fetch requests cannot represent", async () => {
    await expect(
      createWebRequest(
        incomingRequest("TRACE", []),
        "https://fleet.example.test",
        1024,
      ),
    ).rejects.toMatchObject({ status: 405 });
  });

  it("bounds fragmented bodies without trusting Content-Length", async () => {
    await expect(
      createWebRequest(
        incomingRequest("POST", ["1234", "5678", "9"]),
        "https://fleet.example.test",
        8,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("rejects invalid and oversized declared lengths before reading", async () => {
    for (const contentLength of ["invalid", "9"]) {
      await expect(
        createWebRequest(
          incomingRequest("POST", [], { "content-length": contentLength }),
          "https://fleet.example.test",
          8,
        ),
      ).rejects.toBeInstanceOf(IncomingRequestError);
    }
  });
});

function incomingRequest(
  method: string,
  chunks: string[],
  headers: Record<string, string> = {},
): IncomingMessage {
  const request = Readable.from(chunks) as IncomingMessage;
  request.method = method;
  request.url = "/api/test?value=1";
  request.headers = headers;
  request.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [
    name,
    value,
  ]);
  return request;
}
