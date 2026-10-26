import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FleetDatabase } from "./database";

const keyCheckMetadata = "settings_key_check_v1";
const keyCheckPlaintext = Buffer.from("machdoch-settings-manager-key-v1");
const keyCheckAad = Buffer.from("machdoch/settings/key-check/v1");

export class SettingsCipher {
  private readonly fingerprintKey: Buffer;
  constructor(private readonly key: Buffer) {
    if (key.length !== 32)
      throw new Error("Settings encryption key must contain 32 bytes.");
    this.fingerprintKey = Buffer.from(
      hkdfSync(
        "sha256",
        key,
        Buffer.alloc(0),
        Buffer.from("machdoch/settings/command-fingerprint"),
        32,
      ),
    );
  }

  fingerprint(plaintext: Buffer, associatedData: Buffer): string {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(associatedData.length);
    return createHmac("sha256", this.fingerprintKey)
      .update(size)
      .update(associatedData)
      .update(plaintext)
      .digest("base64url");
  }

  encrypt(plaintext: Buffer, associatedData: Buffer): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    return Buffer.concat([
      Buffer.from([1]),
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  decrypt(payload: Buffer, associatedData: Buffer): Buffer {
    if (payload.length < 29 || payload[0] !== 1)
      throw new Error("Encrypted setting is invalid.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      payload.subarray(1, 13),
    );
    decipher.setAAD(associatedData);
    decipher.setAuthTag(payload.subarray(13, 29));
    return Buffer.concat([
      decipher.update(payload.subarray(29)),
      decipher.final(),
    ]);
  }
}

export async function verifySettingsCipher(
  database: FleetDatabase,
  cipher: SettingsCipher,
): Promise<void> {
  return await database.transaction(async () => {
    const row = await database.get(
      "SELECT value FROM metadata WHERE key = $1",
      keyCheckMetadata,
    );
    const stored = row?.value;
    if (typeof stored === "string") {
      let plaintext: Buffer;
      try {
        plaintext = cipher.decrypt(
          Buffer.from(stored, "base64url"),
          keyCheckAad,
        );
      } catch {
        throw new Error(
          "Settings encryption key does not match this machdoch.cloud database.",
        );
      }
      if (
        plaintext.length !== keyCheckPlaintext.length ||
        !timingSafeEqual(plaintext, keyCheckPlaintext)
      ) {
        throw new Error(
          "Settings encryption key does not match this machdoch.cloud database.",
        );
      }
      return;
    }
    const encrypted = cipher.encrypt(keyCheckPlaintext, keyCheckAad);
    await database.run(
      "INSERT INTO metadata (key, value) VALUES ($1, $2)",
      keyCheckMetadata,
      encrypted.toString("base64url"),
    );
  });
}
