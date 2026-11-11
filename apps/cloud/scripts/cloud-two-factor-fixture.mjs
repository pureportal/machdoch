import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const secrets = new Map();

export const signInPaths = new Set([
  "auth/login",
  "auth/magic/consume",
  "auth/sso/consume",
  "invitations/accept",
]);

function totpCode(secret, step) {
  let bits = 0,
    value = 0;
  const bytes = [];
  for (const character of secret) {
    value = (value << 5) | base32Alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", Buffer.from(bytes))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(
    6,
    "0",
  );
}

async function nextCode(userId) {
  const entry = secrets.get(userId);
  const current = () => Math.floor(Date.now() / 30000);
  const step = Math.max(current(), entry.lastStep + 1);
  while (step > current() + 1)
    await new Promise((done) => setTimeout(done, 500));
  entry.lastStep = step;
  return totpCode(entry.secret, step);
}

async function sessionUser(fixture, context) {
  const session = (await context.cookies()).find(
    (cookie) => cookie.name === "__Host-machdoch_cloud_session",
  );
  assert.ok(session, "The browser context has no Cloud session.");
  const row = (
    await fixture.database.query(
      "SELECT user_id FROM cloud_sessions WHERE token_hash=$1",
      [createHash("sha256").update(session.value).digest("base64url")],
    )
  ).rows[0];
  assert.ok(row, "The Cloud session is unknown.");
  return row.user_id;
}

export async function completeSecondFactor(fixture, context) {
  const userId = await sessionUser(fixture, context);
  const post = async (path, data) => {
    const csrf = (await context.cookies()).find(
      (cookie) => cookie.name === "__Host-machdoch_cloud_csrf",
    );
    const response = await context.request.post(
      `${fixture.origin}/api/v1/auth/two-factor/${path}`,
      {
        headers: {
          Origin: fixture.origin,
          "x-machdoch-cloud-csrf": csrf?.value ?? "",
        },
        ...(data === undefined ? {} : { data }),
      },
    );
    assert.ok(
      response.ok(),
      `POST two-factor/${path}: ${response.status()} ${await response.text()}`,
    );
    return response.json();
  };
  if (!secrets.has(userId)) {
    const setup = await post("setup");
    secrets.set(userId, { secret: setup.secret, lastStep: 0 });
    await post("setup/confirm", { code: await nextCode(userId) });
    return;
  }
  await post("verify", { code: await nextCode(userId) });
}

export async function passSecondFactor(fixture, page) {
  await page.waitForURL("**/cloud/two-factor**");
  const userId = await sessionUser(fixture, page.context());
  const code = page.getByLabel("Authentication code", { exact: true });
  if (secrets.has(userId)) {
    await code.fill(await nextCode(userId));
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    return;
  }
  const key = await page.getByLabel("Setup key", { exact: true }).innerText();
  secrets.set(userId, { secret: key.replace(/\s/g, ""), lastStep: 0 });
  await code.fill(await nextCode(userId));
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Recovery codes" }).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}
