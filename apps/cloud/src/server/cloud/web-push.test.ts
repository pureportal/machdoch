import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVapidKeys,
  encryptPushPayload,
  sendWebPush,
  vapidAuthorization,
} from "./web-push";

function derive(key: Buffer, salt: Buffer, info: string, length: number) {
  return Buffer.from(hkdfSync("sha256", key, salt, Buffer.from(info), length));
}

function subscriber() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
}

function decrypt(body: Buffer, user: ReturnType<typeof subscriber>): string {
  const salt = body.subarray(0, 16);
  expect(body.readUInt32BE(16)).toBe(4096);
  const keyLength = body.readUInt8(20);
  const senderKey = body.subarray(21, 21 + keyLength);
  const inputKey = Buffer.from(
    hkdfSync(
      "sha256",
      user.ecdh.computeSecret(senderKey),
      user.auth,
      Buffer.concat([
        Buffer.from("WebPush: info\0"),
        user.ecdh.getPublicKey(),
        senderKey,
      ]),
      32,
    ),
  );
  const record = body.subarray(21 + keyLength);
  const decipher = createDecipheriv(
    "aes-128-gcm",
    derive(inputKey, salt, "Content-Encoding: aes128gcm\0", 16),
    derive(inputKey, salt, "Content-Encoding: nonce\0", 12),
  );
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString("utf8");
}

describe("web push", () => {
  it("encrypts payloads that the subscriber can decrypt (RFC 8291)", () => {
    const user = subscriber();
    const body = encryptPushPayload(
      Buffer.from('{"title":"ENG-1"}'),
      user.keys,
    );
    expect(decrypt(body, user)).toBe('{"title":"ENG-1"}');
  });

  it("signs VAPID tokens for the push service origin", () => {
    const keys = createVapidKeys();
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      keys,
      "https://cloud.example.test",
      Date.UTC(2026, 0, 1),
    );
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(keys.publicKey);
    const [encodedHeader, encodedClaims, signature] = token!.split(".");
    expect(
      JSON.parse(Buffer.from(encodedClaims!, "base64url").toString()),
    ).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Date.UTC(2026, 0, 1) / 1000 + 12 * 3600,
      sub: "https://cloud.example.test",
    });
    const raw = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("reports expired subscriptions and rejects failed deliveries", async () => {
    const user = subscriber();
    const keys = createVapidKeys();
    const target = { endpoint: "https://fcm.googleapis.com/x", ...user.keys };
    const requests: RequestInit[] = [];
    const reply = (status: number) =>
      (async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init!);
        return new Response(null, { status });
      }) as typeof fetch;
    const signal = new AbortController().signal;
    await expect(
      sendWebPush(target, keys, "https://c.test", { a: 1 }, signal, reply(201)),
    ).resolves.toBe("delivered");
    await expect(
      sendWebPush(target, keys, "https://c.test", { a: 1 }, signal, reply(410)),
    ).resolves.toBe("gone");
    await expect(
      sendWebPush(target, keys, "https://c.test", { a: 1 }, signal, reply(500)),
    ).rejects.toThrow("500");
    const headers = requests[0]!.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(decrypt(Buffer.from(requests[0]!.body as Uint8Array), user)).toBe(
      '{"a":1}',
    );
  });
});
