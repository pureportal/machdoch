/// <reference types="node" />

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { UpdateArtifact } from "../release.js";

export function createSignedArtifact(
  version = "2.0.0",
  data = Buffer.from("Machdoch update"),
) {
  const keys = generateKeyPairSync("ed25519");
  const id = Buffer.from("0102030405060708", "hex");
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const publicPacket = Buffer.concat([
    Buffer.from("Ed"),
    id,
    publicDer.subarray(-32),
  ]);
  const digest = createHash("blake2b512").update(data).digest();
  const signature = sign(null, digest, keys.privateKey);
  const packet = Buffer.concat([Buffer.from("ED"), id, signature]);
  const comment = `timestamp:1700000000\tfile:machdoch-headless.tar.gz\tversion:${version}`;
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(comment)]),
    keys.privateKey,
  );
  const encodedSignature = Buffer.from(
    `untrusted comment: signature\n${packet.toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`,
  ).toString("base64");
  const publicKey = Buffer.from(
    `untrusted comment: public key\n${publicPacket.toString("base64")}\n`,
  ).toString("base64");
  const artifact: UpdateArtifact = {
    url: `https://github.com/pureportal/machdoch/releases/download/v${version}/machdoch-headless.tar.gz`,
    signature: encodedSignature,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.length,
  };
  return { artifact, publicKey, data, digest };
}
