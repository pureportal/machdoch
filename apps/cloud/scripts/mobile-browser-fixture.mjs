import assert from "node:assert/strict";
import { WebSocket } from "ws";
import {
  cloudBrowserFixture,
  assertEventually as eventually,
} from "./cloud-browser-fixture.mjs";
import { createMobileDevice } from "./mobile-device-fixture.mjs";
import { createSecret } from "../src/server/crypto.ts";
import {
  gatewayProtocolVersion,
  productCapability,
} from "@machdoch/fleet-protocol";

export async function startMobileFixture() {
  const cloud = await cloudBrowserFixture();
  const {
    browser,
    ownerContext: context,
    origin,
    directory: fixtureRoot,
  } = cloud;
  let socket;
  try {
    const csrfCookie = (await context.cookies()).find(
      (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
    );
    assert.ok(csrfCookie);
    const mutationHeaders = {
      Origin: origin,
      "X-Machdoch-Cloud-CSRF": csrfCookie.value,
    };
    const api = async (path, method = "GET", data) => {
      const response = await context.request.fetch(`${origin}/api${path}`, {
        method,
        ...(method === "GET" ? {} : { headers: mutationHeaders }),
        ...(data === undefined ? {} : { data }),
      });
      assert.ok(
        response.ok(),
        `${method} ${path}: ${response.status()} ${await response.text()}`,
      );
      return response.status() === 204 ? null : response.json();
    };
    const grant = await api("/enrollment-keys", "POST");
    const instanceSecret = createSecret("mch_instance");
    const enrollment = await context.request.post(`${origin}/api/enroll`, {
      headers: { Authorization: `Bearer ${grant.enrollmentKey}` },
      data: {
        instanceSecret,
        displayName: "Legion Go S",
        productVersion: "30.2.1",
        protocolVersion: gatewayProtocolVersion,
      },
    });
    assert.ok(enrollment.ok(), await enrollment.text());
    const { instanceId } = await enrollment.json();
    socket = new WebSocket(
      `${origin.replace("https:", "wss:")}/api/gateway/connect/${instanceId}`,
      {
        headers: { Authorization: `Bearer ${instanceSecret}` },
        rejectUnauthorized: false,
      },
    );
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const device = createMobileDevice(socket);
    socket.send(
      JSON.stringify({
        type: "hello",
        instanceId,
        protocolVersion: gatewayProtocolVersion,
        productVersion: "30.2.1",
        capabilities: [productCapability, "workspace-tools.v1"],
      }),
    );
    await eventually(
      async () =>
        (await api("/instances")).instances.some(
          (instance) =>
            instance.instanceId === instanceId && instance.status === "online",
        ),
      () => "Fixture device did not connect.",
    );

    return {
      browser,
      context,
      origin,
      api,
      fixtureRoot,
      instanceId,
      ...device,
      close: async () => {
        socket.terminate();
        await cloud.close();
      },
    };
  } catch (error) {
    socket?.terminate();
    await cloud.close();
    throw error;
  }
}
