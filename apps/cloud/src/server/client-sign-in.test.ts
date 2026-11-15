import { createHash, randomUUID } from "node:crypto";
import { gatewayProtocolVersion } from "@machdoch/fleet-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRemoteTestRuntime,
  verifyRemoteTestLogin,
} from "../test/remote-fixture";
import { handleApiRequest } from "./api";
import { getCloudRuntime } from "./cloud/runtime";
import { createSecret, hashOwnerPasswordAsync } from "./crypto";
import { setRuntimeForTests, type FleetRuntime } from "./runtime";

const origin = "https://fleet.example.test";
const password = "a secure test password";
let runtime: FleetRuntime;

interface Browser {
  cookie: string;
  csrf: string;
  userId: string;
}

beforeEach(async () => {
  runtime = await createRemoteTestRuntime();
  setRuntimeForTests(runtime);
});

afterEach(async () => {
  setRuntimeForTests(undefined);
  runtime.gateways.close();
  await runtime.database.close();
});

async function request(
  path: string,
  method: string,
  options: { body?: unknown; browser?: Browser; bearer?: string } = {},
): Promise<Response> {
  const headers = new Headers({ Origin: origin });
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  if (options.browser) {
    headers.set("Cookie", options.browser.cookie);
    headers.set("X-Machdoch-Cloud-CSRF", options.browser.csrf);
  }
  if (options.bearer) headers.set("Authorization", `Bearer ${options.bearer}`);
  return handleApiRequest(
    new Request(`${origin}${path}`, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    { clientAddress: "198.51.100.20" },
  );
}

async function signInAs(login: string): Promise<Browser> {
  const response = await request("/api/v1/auth/login", "POST", {
    body: { email: login, password },
  });
  const cookies = response.headers.getSetCookie();
  await verifyRemoteTestLogin(cookies);
  const csrf = /^__Host-machdoch_cloud_csrf=([^;]+)/mu.exec(
    cookies.join("\n"),
  )?.[1];
  if (!csrf) throw new Error("Missing test CSRF cookie.");
  const cookie = cookies.map((value) => value.split(";", 1)[0]).join("; ");
  const cloud = await getCloudRuntime();
  const actor = await cloud.identity.authenticate(
    /machdoch_cloud_session=([^;]+)/u.exec(cookie)![1]!,
  );
  return { cookie, csrf, userId: actor!.userId };
}

async function addMember(name: string): Promise<Browser> {
  const cloud = await getCloudRuntime();
  const passwordHash = await hashOwnerPasswordAsync(password);
  await cloud.database.transaction(async (sql) => {
    const userId = randomUUID();
    await sql.query(
      "INSERT INTO cloud_users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
      [userId, `${name}@example.test`, name, passwordHash],
    );
    await sql.query(
      "INSERT INTO cloud_memberships (organization_id,user_id,role) SELECT organization_id,$1,'member' FROM cloud_installation WHERE id=1",
      [userId],
    );
  });
  return signInAs(`${name}@example.test`);
}

async function signInClient(
  browser: Browser,
  shared: boolean,
): Promise<{ status: number; instanceId?: string; redirect?: URL }> {
  const verifier = createSecret("v").slice(2);
  const state = "state_0123456789abcdef";
  const start = await request(
    `/api/v1/oauth/client-sign-in?${new URLSearchParams({
      redirect_uri: "http://127.0.0.1:43125/callback",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      name: "Ada laptop",
    })}`,
    "GET",
  );
  expect(start.status).toBe(303);
  const requestId = new URL(start.headers.get("location")!).searchParams.get(
    "requestId",
  )!;
  const cloud = await getCloudRuntime();
  const actor = (await cloud.identity.authenticate(
    /machdoch_cloud_session=([^;]+)/u.exec(browser.cookie)![1]!,
  ))!;
  expect(await cloud.clientSignIn.consent(actor, requestId)).toMatchObject({
    clientName: "Ada laptop",
  });
  const decision = await request(
    `/api/v1/client-sign-ins/${requestId}`,
    "POST",
    { browser, body: { approve: true, shared } },
  );
  if (decision.status !== 200) return { status: decision.status };
  const redirect = new URL(
    ((await decision.json()) as { redirect: string }).redirect,
  );
  expect(redirect.origin).toBe("http://127.0.0.1:43125");
  expect(redirect.searchParams.get("state")).toBe(state);
  const code = redirect.searchParams.get("code")!;
  const enrollment = (codeVerifier: string) =>
    request("/api/enroll", "POST", {
      bearer: code,
      body: {
        codeVerifier,
        displayName: "Ada laptop",
        instanceSecret: createSecret("mch_instance"),
        productVersion: "45.0.0",
        protocolVersion: gatewayProtocolVersion,
      },
    });
  expect((await enrollment(`${verifier}x`)).status).toBe(401);
  const enrolled = await enrollment(verifier);
  expect(enrolled.status).toBe(200);
  expect((await enrollment(verifier)).status).toBe(401);
  return {
    status: 200,
    redirect,
    instanceId: ((await enrolled.json()) as { instanceId: string }).instanceId,
  };
}

async function listed(browser: Browser) {
  const response = await request("/api/instances", "GET", { browser });
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      instances: {
        instanceId: string;
        mine: boolean;
        usable: boolean;
        ownerName: string | null;
      }[];
    }
  ).instances;
}

async function openSession(browser: Browser, instanceId: string) {
  return (
    await request("/api/fleet/sessions", "POST", {
      browser,
      body: {
        commandId: randomUUID(),
        targets: [{ instanceId, workspace: "/projects/example" }],
      },
    })
  ).status;
}

describe("client sign-in", () => {
  it("binds a personal client to the person who signed in", async () => {
    const owner = await signInAs("owner");
    const ada = await addMember("ada");
    const { instanceId } = await signInClient(ada, false);

    expect(await listed(ada)).toEqual([
      expect.objectContaining({
        instanceId,
        mine: true,
        usable: true,
        ownerName: "ada",
      }),
    ]);
    expect(await listed(owner)).toEqual([
      expect.objectContaining({ instanceId, mine: false, usable: false }),
    ]);
    expect(await openSession(owner, instanceId!)).toBe(403);
    expect(await openSession(ada, instanceId!)).toBe(503);
    expect(
      (
        await request(`/api/instances/${instanceId}/agent-access`, "PUT", {
          browser: owner,
          body: { agentAccess: "everyone", agentUsers: [] },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/api/instances/${instanceId}`, "DELETE", {
          browser: ada,
        })
      ).status,
    ).toBe(200);
  });

  it("lets admins always use organization clients and others once allowed", async () => {
    const owner = await signInAs("owner");
    const ada = await addMember("ada");
    expect((await signInClient(ada, true)).status).toBe(403);
    const { instanceId } = await signInClient(owner, true);

    expect(await listed(ada)).toEqual([]);
    expect(await listed(owner)).toEqual([
      expect.objectContaining({ instanceId, usable: true, ownerName: null }),
    ]);
    expect(await openSession(owner, instanceId!)).toBe(503);
    expect(
      (
        await request(`/api/instances/${instanceId}/agent-access`, "PUT", {
          browser: ada,
          body: { agentAccess: "everyone", agentUsers: [] },
        })
      ).status,
    ).toBe(403);

    const allow = (agentAccess: string, agentUsers: string[] = []) =>
      request(`/api/instances/${instanceId}/agent-access`, "PUT", {
        browser: owner,
        body: { agentAccess, agentUsers },
      });
    expect((await allow("people", [ada.userId])).status).toBe(200);
    expect(await listed(ada)).toEqual([
      expect.objectContaining({ instanceId, usable: true, mine: false }),
    ]);
    expect(await openSession(ada, instanceId!)).toBe(503);
    expect(await openSession(owner, instanceId!)).toBe(503);
    expect((await allow("admins")).status).toBe(200);
    expect(await listed(ada)).toEqual([]);
    expect(await openSession(ada, instanceId!)).toBe(403);
    expect(await openSession(owner, instanceId!)).toBe(503);
    expect(
      (
        await request(`/api/instances/${instanceId}`, "DELETE", {
          browser: ada,
        })
      ).status,
    ).toBe(403);
  });

  it("returns a canceled sign-in to the app without a code", async () => {
    const owner = await signInAs("owner");
    const start = await request(
      `/api/v1/oauth/client-sign-in?${new URLSearchParams({
        redirect_uri: "http://127.0.0.1:43125/callback",
        state: "state_0123456789abcdef",
        code_challenge: "a".repeat(43),
        name: "Ada laptop",
      })}`,
      "GET",
    );
    const requestId = new URL(start.headers.get("location")!).searchParams.get(
      "requestId",
    )!;
    const cloud = await getCloudRuntime();
    await cloud.clientSignIn.consent(
      (await cloud.identity.authenticate(
        /machdoch_cloud_session=([^;]+)/u.exec(owner.cookie)![1]!,
      ))!,
      requestId,
    );
    const decision = await request(
      `/api/v1/client-sign-ins/${requestId}`,
      "POST",
      { browser: owner, body: { approve: false, shared: false } },
    );
    const redirect = new URL(
      ((await decision.json()) as { redirect: string }).redirect,
    );
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(
      (
        await request(
          `/api/v1/oauth/client-sign-in?redirect_uri=${encodeURIComponent("https://evil.example/callback")}&state=state_0123456789abcdef&code_challenge=${"a".repeat(43)}&name=x`,
          "GET",
        )
      ).status,
    ).toBe(400);
  });
});
