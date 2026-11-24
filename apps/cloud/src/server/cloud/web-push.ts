import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export type PushResult = "delivered" | "gone";

const recordSize = 4096;
const tokenLifetimeSeconds = 12 * 60 * 60;

function derive(key: Buffer, salt: Buffer, info: Buffer, length: number) {
  return Buffer.from(hkdfSync("sha256", key, salt, info, length));
}

export function createVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, "base64url"),
      Buffer.from(jwk.y!, "base64url"),
    ]).toString("base64url"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  };
}

export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  now = Date.now(),
): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + tokenLifetimeSeconds,
    sub: subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey({
      key: Buffer.from(keys.privateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    }),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

export function encryptPushPayload(
  payload: Buffer,
  target: Pick<PushTarget, "p256dh" | "auth">,
): Buffer {
  if (payload.length > recordSize - 17)
    throw new Error("Push payload is too large.");
  const subscriberKey = Buffer.from(target.p256dh, "base64url");
  const sender = createECDH("prime256v1");
  sender.generateKeys();
  const senderKey = sender.getPublicKey();
  const inputKey = derive(
    sender.computeSecret(subscriberKey),
    Buffer.from(target.auth, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), subscriberKey, senderKey]),
    32,
  );
  const salt = randomBytes(16);
  const cipher = createCipheriv(
    "aes-128-gcm",
    derive(inputKey, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
    derive(inputKey, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(senderKey.length, 20);
  return Buffer.concat([
    header,
    senderKey,
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

export async function sendWebPush(
  target: PushTarget,
  keys: VapidKeys,
  subject: string,
  payload: object,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<PushResult> {
  const response = await fetcher(target.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidAuthorization(target.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body: new Uint8Array(
      encryptPushPayload(Buffer.from(JSON.stringify(payload)), target),
    ),
    redirect: "error",
    signal,
  });
  await response.body?.cancel();
  if (response.status === 404 || response.status === 410) return "gone";
  if (!response.ok)
    throw new Error(`Push service responded with ${response.status}.`);
  return "delivered";
}
