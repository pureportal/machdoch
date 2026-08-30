import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FleetManagerConfig } from "./config";
import type { FleetDatabase } from "./database";

const keyCheckMetadata = "settings_key_check_v1";
const keyCheckPlaintext = Buffer.from("machdoch-settings-manager-key-v1");
const keyCheckAad = Buffer.from("machdoch/settings/key-check/v1");

export class SettingsCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32)
      throw new Error("Settings encryption key must contain 32 bytes.");
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

export function loadSettingsCipher(
  config: FleetManagerConfig,
): SettingsCipher | null {
  if (!config.settingsManager.enabled) return null;
  const encoded = config.settingsManager.encryptionKeyFile
    ? readFileSync(config.settingsManager.encryptionKeyFile, "utf8").trim()
    : process.env[
        config.settingsManager.encryptionKeyEnvironmentVariable ?? ""
      ]?.trim();
  if (!encoded) throw new Error("Settings encryption key is unavailable.");
  return new SettingsCipher(decodeKey(encoded));
}

export function initializeSettingsKeyFile(config: FleetManagerConfig): void {
  const keyPath = config.settingsManager.encryptionKeyFile;
  if (!keyPath)
    throw new Error("settingsManager.encryptionKeyFile is not configured.");
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  writeFileSync(keyPath, `${randomBytes(32).toString("base64url")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export function verifySettingsCipher(
  database: FleetDatabase,
  cipher: SettingsCipher,
): void {
  const row = database.get(
    "SELECT value FROM metadata WHERE key = ?",
    keyCheckMetadata,
  );
  const stored = row?.value;
  if (typeof stored === "string") {
    let plaintext: Buffer;
    try {
      plaintext = cipher.decrypt(Buffer.from(stored, "base64url"), keyCheckAad);
    } catch {
      throw new Error(
        "Settings encryption key does not match this Fleet Manager database.",
      );
    }
    if (
      plaintext.length !== keyCheckPlaintext.length ||
      !timingSafeEqual(plaintext, keyCheckPlaintext)
    ) {
      throw new Error(
        "Settings encryption key does not match this Fleet Manager database.",
      );
    }
    return;
  }
  const encrypted = cipher.encrypt(keyCheckPlaintext, keyCheckAad);
  database.run(
    "INSERT INTO metadata (key, value) VALUES (?, ?)",
    keyCheckMetadata,
    encrypted.toString("base64url"),
  );
}

function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(
      "Settings encryption key must be URL-safe Base64 without padding.",
    );
  }
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32)
    throw new Error("Settings encryption key must contain 32 bytes.");
  return key;
}
