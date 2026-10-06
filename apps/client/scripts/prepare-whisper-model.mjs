import { resolve } from "node:path";
import { downloadVerifiedAsset } from "./download-verified-asset.mjs";

const revision = "c521a4b02f422512d734391fdf08bb08c0862f68";
for (const model of [
  {
    name: "base",
    size: 59_707_625,
    sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
  },
  {
    name: "tiny",
    size: 32_152_673,
    sha256: "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7",
  },
]) {
  const filename = `ggml-${model.name}-q5_1.bin`;
  await downloadVerifiedAsset(
    {
      ...model,
      url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/${revision}/${filename}`,
    },
    resolve(import.meta.dirname, "../src-tauri/resources/whisper", filename),
  );
}
