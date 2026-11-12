import { describe, expect, it } from "vitest";
import { RunnerConnection } from "@machdoch/cloud-client";

const token = "mch_cloud_worker_fixture";
const loopback = { allowLoopbackHttp: true };

describe("RunnerConnection", () => {
  it("requires HTTPS unless loopback HTTP is explicitly allowed", () => {
    expect(
      new RunnerConnection("https://cloud.example.test", token).origin,
    ).toBe("https://cloud.example.test");
    expect(() => new RunnerConnection("http://localhost:43188", token)).toThrow(
      "Runner connections require an HTTPS origin",
    );
    for (const origin of [
      "http://localhost:43188",
      "http://127.0.0.1:43188",
      "http://[::1]:43188",
    ])
      expect(new RunnerConnection(origin, token, fetch, loopback).origin).toBe(
        origin,
      );
  });

  it("rejects remote HTTP origins and origins with paths or credentials", () => {
    for (const origin of [
      "http://cloud.example.test",
      "https://cloud.example.test/path",
      "https://user:secret@cloud.example.test",
    ])
      expect(
        () => new RunnerConnection(origin, token, fetch, loopback),
      ).toThrow(
        "Runner connections require an HTTPS origin or a loopback HTTP origin",
      );
  });
});
