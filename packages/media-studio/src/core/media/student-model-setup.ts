import { openMediaModelProfile } from "./open-model-profiles.js";

export const studentModelSetup = (architecture: string | null | undefined) => {
  const profile = openMediaModelProfile(architecture);
  const student = profile?.distillation;
  if (!profile || !student) return null;
  const components =
    student.sampler === "lcm"
      ? [
          "unet/config.json",
          "text_encoder/",
          "text_encoder_2/",
          "tokenizer/",
          "tokenizer_2/",
          "vae/",
          "scheduler/",
        ]
      : [
          "transformer/",
          "text_encoder/",
          "tokenizer/",
          "processor/",
          "vae/",
          "audio_vae/",
          "scheduler/",
          "audio_scheduler/",
        ];
  return {
    profile,
    baseUrl: `https://huggingface.co/${student.baseRepository}`,
    checkpointUrl: `https://huggingface.co/${profile.repository}/resolve/${profile.revision}/${student.checkpointSourceFile}`,
    requiredPaths: [
      "model_index.json",
      student.sampler === "lcm" ? "LICENSE.md" : "LICENSE",
      ...components,
      student.checkpointFile,
    ],
    isH3: student.sampler !== "lcm",
  };
};
