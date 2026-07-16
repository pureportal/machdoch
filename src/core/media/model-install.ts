import { hash as sha256 } from "fast-sha256";
import type {
  MediaModelInstallManifestFile,
  MediaModelInstallPlan,
} from "./contracts.js";

export const LOCAL_FLUX_MODEL_ID = "local:flux-2-klein-4b";
export const LOCAL_FLUX_REVISION =
  "e7b7dc27f91deacad38e78976d1f2b499d76a294";
export const LOCAL_FLUX_LICENSE_DIGEST =
  "ca02bc51900ab07789d1b70283329e7137f5af98f5161c23a1c81fc38a4af1fe";

export const LOCAL_FLUX_INSTALL_FILES = [
  { path: "LICENSE.md", byteSize: 9_584, sha256: "ca02bc51900ab07789d1b70283329e7137f5af98f5161c23a1c81fc38a4af1fe" },
  { path: "model_index.json", byteSize: 446, sha256: "51a76cb1cf3ed37423a1128c79c22faee8e6fbe7f5aaeb737f0a258930dbaac0" },
  { path: "scheduler/scheduler_config.json", byteSize: 486, sha256: "067afb012cef64553a763447d1efd93daeffcc0123ca7e25b09f8de20b90762e" },
  { path: "text_encoder/config.json", byteSize: 1_536, sha256: "214b4c29a0d975e9fddf9994a5673f22cb2c4c5750352f9227c2c3251ebeab40" },
  { path: "text_encoder/generation_config.json", byteSize: 214, sha256: "4347b1aeed2b2b78bc059920a0b7f5fec71482e1344952b76d7665d638d71f13" },
  { path: "text_encoder/model-00001-of-00002.safetensors", byteSize: 4_967_215_360, sha256: "8c0506e7f4936fa7e26183a4fd8da4e2bdbc5990ba64ae441f965d51228f36ea" },
  { path: "text_encoder/model-00002-of-00002.safetensors", byteSize: 3_077_766_632, sha256: "82f2bd839378541b0557bfabaf37c7d3d637071fdcb73302dedd7cf61162ce07" },
  { path: "text_encoder/model.safetensors.index.json", byteSize: 32_855, sha256: "06b3d5319b6d76d1a4a2433419180016cfd54ed62d086a5e6567a809f8c82634" },
  { path: "tokenizer/added_tokens.json", byteSize: 707, sha256: "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680" },
  { path: "tokenizer/chat_template.jinja", byteSize: 4_168, sha256: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8" },
  { path: "tokenizer/merges.txt", byteSize: 1_671_853, sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5" },
  { path: "tokenizer/special_tokens_map.json", byteSize: 613, sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd" },
  { path: "tokenizer/tokenizer.json", byteSize: 11_422_654, sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4" },
  { path: "tokenizer/tokenizer_config.json", byteSize: 5_404, sha256: "443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0" },
  { path: "tokenizer/vocab.json", byteSize: 2_776_833, sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910" },
  { path: "transformer/config.json", byteSize: 541, sha256: "09733c74a3da6d17dd0a0472a091a8950c7c6935889c32c16cc800ede05029de" },
  { path: "transformer/diffusion_pytorch_model.safetensors", byteSize: 7_751_109_744, sha256: "9f29f9edcfdae452a653ffb51a534ca4decd389952c225724ff3b94042612a6e" },
  { path: "vae/config.json", byteSize: 821, sha256: "0d6dfb69ae95a5e2ac9836284bbb63d8b38ce67b25ba2dff380752b2a10ab948" },
  { path: "vae/diffusion_pytorch_model.safetensors", byteSize: 168_120_878, sha256: "ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04" },
] as const satisfies readonly MediaModelInstallManifestFile[];

const hexDigest = (value: string): string =>
  Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const LOCAL_FLUX_TOTAL_BYTES = LOCAL_FLUX_INSTALL_FILES.reduce(
  (total, file) => total + file.byteSize,
  0,
);

export const LOCAL_FLUX_REQUIRED_WORKING_BYTES = Math.ceil(
  (LOCAL_FLUX_TOTAL_BYTES * 112) / 100,
);

export const LOCAL_BIREFNET_MODEL_ID = "local:birefnet-matting";
export const LOCAL_BIREFNET_REVISION =
  "a0cf9925880620000aa2d1948d61bf659ddfdfaa";
export const LOCAL_BIREFNET_LICENSE_DIGEST =
  "92a7089e0915fc32bc40067560b398f1e6a7a5958abd7d04eda393629a5acefb";
export const LOCAL_BIREFNET_INSTALL_FILES = [
  {
    path: "LICENSE",
    byteSize: 1_066,
    sha256: LOCAL_BIREFNET_LICENSE_DIGEST,
  },
  {
    path: "BiRefNet-matting-epoch_100.onnx",
    byteSize: 972_667_742,
    sha256:
      "6065d27c615ea27308f5b88598dd8db116eb07436c7a323ca40d13b2866c309e",
  },
] as const satisfies readonly MediaModelInstallManifestFile[];
export const LOCAL_BIREFNET_TOTAL_BYTES = LOCAL_BIREFNET_INSTALL_FILES.reduce(
  (total, file) => total + file.byteSize,
  0,
);
export const LOCAL_BIREFNET_REQUIRED_WORKING_BYTES = Math.ceil(
  (LOCAL_BIREFNET_TOTAL_BYTES * 112) / 100,
);

export const createLocalFluxManifestDigest = (): string => {
  let canonical = `machdoch-media-model-manifest-v1\0${LOCAL_FLUX_MODEL_ID}\0${LOCAL_FLUX_REVISION}`;
  for (const file of LOCAL_FLUX_INSTALL_FILES) {
    canonical += `\0${file.path}\0${file.byteSize}\0${file.sha256}`;
  }
  return hexDigest(canonical);
};

export const createLocalFluxReviewToken = (
  manifestDigest = createLocalFluxManifestDigest(),
): string =>
  hexDigest(
    `machdoch-media-model-install-review-v1\0${LOCAL_FLUX_MODEL_ID}\0${LOCAL_FLUX_REVISION}\0${manifestDigest}\0${LOCAL_FLUX_LICENSE_DIGEST}\0${LOCAL_FLUX_TOTAL_BYTES}\0${LOCAL_FLUX_REQUIRED_WORKING_BYTES}\0`,
  );

export const createLocalFluxInstallPlan = ({
  availableBytes = null,
  alreadyInstalled = false,
}: {
  availableBytes?: number | null;
  alreadyInstalled?: boolean;
} = {}): MediaModelInstallPlan => {
  const manifestDigest = createLocalFluxManifestDigest();
  const hasSufficientSpace =
    availableBytes === null
      ? null
      : availableBytes >= LOCAL_FLUX_REQUIRED_WORKING_BYTES;
  return {
    schemaVersion: 1,
    modelId: LOCAL_FLUX_MODEL_ID,
    displayName: "FLUX.2 klein 4B",
    revision: LOCAL_FLUX_REVISION,
    manifestDigest,
    licenseDigest: LOCAL_FLUX_LICENSE_DIGEST,
    reviewToken: createLocalFluxReviewToken(manifestDigest),
    sourceUrl:
      "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
    targetLabel: `models/packages/flux-2-klein-4b/revisions/${LOCAL_FLUX_REVISION}`,
    files: LOCAL_FLUX_INSTALL_FILES.map((file) => ({ ...file })),
    excludedPaths: [
      "flux-2-klein-4b.safetensors (duplicate single-file checkpoint)",
      ".gitattributes and repository documentation",
      "example images and community metadata",
    ],
    totalBytes: LOCAL_FLUX_TOTAL_BYTES,
    requiredWorkingBytes: LOCAL_FLUX_REQUIRED_WORKING_BYTES,
    availableBytes,
    hasSufficientSpace,
    alreadyInstalled,
    license: {
      name: "Apache License 2.0",
      spdxId: "Apache-2.0",
      sourceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
      commercialUse: "allowed",
      requiresAcceptance: true,
    },
    warnings: [
      "The installer downloads only the pinned Diffusers allowlist; no repository code is executed.",
      "Activation occurs only after every size and SHA-256 check succeeds.",
      ...(availableBytes === null
        ? [
            "Browser preview cannot measure native free space; the desktop app checks the target volume again before download.",
          ]
        : hasSufficientSpace
          ? []
          : [
              "The selected media storage volume does not currently have enough free space.",
            ]),
    ],
  };
};

export const createLocalBiRefNetManifestDigest = (): string => {
  let canonical = `machdoch-media-model-manifest-v1\0${LOCAL_BIREFNET_MODEL_ID}\0${LOCAL_BIREFNET_REVISION}`;
  for (const file of LOCAL_BIREFNET_INSTALL_FILES) {
    canonical += `\0${file.path}\0${file.byteSize}\0${file.sha256}`;
  }
  return hexDigest(canonical);
};

export const createLocalBiRefNetReviewToken = (
  manifestDigest = createLocalBiRefNetManifestDigest(),
): string =>
  hexDigest(
    `machdoch-media-model-install-review-v1\0${LOCAL_BIREFNET_MODEL_ID}\0${LOCAL_BIREFNET_REVISION}\0${manifestDigest}\0${LOCAL_BIREFNET_LICENSE_DIGEST}\0${LOCAL_BIREFNET_TOTAL_BYTES}\0${LOCAL_BIREFNET_REQUIRED_WORKING_BYTES}\0`,
  );

export const createLocalBiRefNetInstallPlan = ({
  availableBytes = null,
  alreadyInstalled = false,
}: {
  availableBytes?: number | null;
  alreadyInstalled?: boolean;
} = {}): MediaModelInstallPlan => {
  const manifestDigest = createLocalBiRefNetManifestDigest();
  const hasSufficientSpace =
    availableBytes === null
      ? null
      : availableBytes >= LOCAL_BIREFNET_REQUIRED_WORKING_BYTES;
  return {
    schemaVersion: 1,
    modelId: LOCAL_BIREFNET_MODEL_ID,
    displayName: "BiRefNet Matting",
    revision: LOCAL_BIREFNET_REVISION,
    manifestDigest,
    licenseDigest: LOCAL_BIREFNET_LICENSE_DIGEST,
    reviewToken: createLocalBiRefNetReviewToken(manifestDigest),
    sourceUrl: "https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1",
    targetLabel: `models/packages/birefnet-matting/revisions/${LOCAL_BIREFNET_REVISION}`,
    files: LOCAL_BIREFNET_INSTALL_FILES.map((file) => ({ ...file })),
    excludedPaths: [
      "training checkpoints, datasets, and repository source code",
      "third-party ONNX conversions and quantized variants",
    ],
    totalBytes: LOCAL_BIREFNET_TOTAL_BYTES,
    requiredWorkingBytes: LOCAL_BIREFNET_REQUIRED_WORKING_BYTES,
    availableBytes,
    hasSufficientSpace,
    alreadyInstalled,
    license: {
      name: "MIT License",
      spdxId: "MIT",
      sourceUrl:
        "https://github.com/ZhengPeng7/BiRefNet/blob/a0cf9925880620000aa2d1948d61bf659ddfdfaa/LICENSE",
      commercialUse: "allowed",
      requiresAcceptance: true,
    },
    warnings: [
      "The installer downloads only the official BiRefNet matting ONNX release and license; no repository code is executed.",
      "Activation occurs only after every size and SHA-256 check succeeds.",
      ...(availableBytes === null
        ? [
            "Browser preview cannot measure native free space; the desktop app checks the target volume again before download.",
          ]
        : hasSufficientSpace
          ? []
          : [
              "The selected media storage volume does not currently have enough free space.",
            ]),
    ],
  };
};
