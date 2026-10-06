import type { JSX } from "react";
import {
  isFlowTrainingArchitecture,
  isVideoTrainingArchitecture,
} from "../media-training";
import type {
  MediaTrainingArchitecture,
  MediaTrainingOptions,
  MediaTrainingRequest,
} from "../media-training";

export type MediaTrainingSettings = Pick<
  MediaTrainingRequest,
  | "steps"
  | "learningRate"
  | "resolution"
  | "rank"
  | "seed"
  | "attentionOnly"
  | "fourBit"
  | "options"
>;

const fieldClass =
  "block w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2";

const numericOptions: readonly {
  key:
    | "batchSize"
    | "gradientAccumulation"
    | "warmupSteps"
    | "weightDecay"
    | "maxGradNorm"
    | "snrGamma"
    | "noiseOffset"
    | "loraDropout"
    | "guidanceScale"
    | "checkpointInterval"
    | "checkpointRetention";
  label: string;
  min: number;
  max: number;
  step: number;
}[] = [
  { key: "batchSize", label: "Batch size", min: 1, max: 16, step: 1 },
  {
    key: "gradientAccumulation",
    label: "Gradient accumulation",
    min: 1,
    max: 64,
    step: 1,
  },
  { key: "warmupSteps", label: "Warmup steps", min: 0, max: 10000, step: 1 },
  { key: "weightDecay", label: "Weight decay", min: 0, max: 1, step: 0.001 },
  {
    key: "maxGradNorm",
    label: "Gradient clipping",
    min: 0,
    max: 100,
    step: 0.01,
  },
  { key: "snrGamma", label: "Min-SNR gamma", min: 0, max: 100, step: 0.1 },
  { key: "noiseOffset", label: "Noise offset", min: 0, max: 1, step: 0.01 },
  { key: "loraDropout", label: "LoRA dropout", min: 0, max: 0.5, step: 0.01 },
  {
    key: "guidanceScale",
    label: "Training guidance",
    min: 0,
    max: 20,
    step: 0.1,
  },
  {
    key: "checkpointInterval",
    label: "Checkpoint interval",
    min: 1,
    max: 10000,
    step: 1,
  },
  {
    key: "checkpointRetention",
    label: "Saved checkpoints",
    min: 1,
    max: 20,
    step: 1,
  },
];

export function MediaTrainingSettingsFields({
  architecture,
  settings,
  onChange,
}: {
  architecture: MediaTrainingArchitecture;
  settings: MediaTrainingSettings;
  onChange: (patch: Partial<MediaTrainingSettings>) => void;
}): JSX.Element {
  const options = settings.options;
  const changeOptions = (patch: Partial<MediaTrainingOptions>): void =>
    onChange({ options: { ...options, ...patch } });
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="space-y-2 text-sm">
        Steps
        <input
          type="number"
          min={1}
          max={10000}
          step={1}
          value={settings.steps}
          onChange={(event) => onChange({ steps: Number(event.target.value) })}
          className={fieldClass}
        />
      </label>
      <label className="space-y-2 text-sm">
        Learning rate
        <input
          type="number"
          min={0.000001}
          max={0.01}
          step={0.000001}
          value={settings.learningRate}
          onChange={(event) =>
            onChange({ learningRate: Number(event.target.value) })
          }
          className={fieldClass}
        />
      </label>
      {!isVideoTrainingArchitecture(architecture) ? (
        <label className="space-y-2 text-sm">
          Resolution
          <select
            value={settings.resolution}
            onChange={(event) =>
              onChange({
                resolution: Number(
                  event.target.value,
                ) as MediaTrainingSettings["resolution"],
              })
            }
            className={fieldClass}
          >
            {[512, 768, 1024].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {options.method === "lora" ? (
        <label className="space-y-2 text-sm">
          Rank
          <select
            value={settings.rank}
            onChange={(event) =>
              onChange({
                rank: Number(
                  event.target.value,
                ) as MediaTrainingSettings["rank"],
              })
            }
            className={fieldClass}
          >
            {[4, 8, 16, 32, 64].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="space-y-2 text-sm">
        Seed
        <input
          type="number"
          min={0}
          max={4294967295}
          step={1}
          value={settings.seed}
          onChange={(event) => onChange({ seed: Number(event.target.value) })}
          className={fieldClass}
        />
      </label>
      <label className="space-y-2 text-sm">
        Precision
        <select
          value={options.precision}
          onChange={(event) =>
            changeOptions({
              precision: event.target
                .value as MediaTrainingOptions["precision"],
              trainablePrecision:
                event.target.value === "bf16"
                  ? options.trainablePrecision
                  : "float32",
            })
          }
          className={fieldClass}
        >
          <option value="bf16">BF16</option>
          {architecture !== "wan-2.1-t2v-1.3b" ? <option value="fp16">FP16</option> : null}
          <option value="float32">FP32</option>
        </select>
      </label>
      {architecture !== "krea-2" ? (
        <label className="space-y-2 text-sm">
          Optimizer
          <select
            value={options.optimizer}
            onChange={(event) => {
              const optimizer = event.target
                .value as MediaTrainingOptions["optimizer"];
              changeOptions({
                optimizer,
                maxGradNorm: optimizer === "adafactor" ? 0 : 1,
                trainablePrecision:
                  optimizer === "adamw"
                    ? "float32"
                    : options.trainablePrecision,
              });
            }}
            className={fieldClass}
          >
            <option value="adamw">AdamW</option>
            <option value="adafactor">Adafactor</option>
          </select>
        </label>
      ) : null}
      {options.method === "finetune" &&
      options.optimizer === "adafactor" &&
      options.precision === "bf16" ? (
        <label className="space-y-2 text-sm">
          Trainable weights
          <select
            value={options.trainablePrecision}
            onChange={(event) =>
              changeOptions({
                trainablePrecision: event.target
                  .value as MediaTrainingOptions["trainablePrecision"],
              })
            }
            className={fieldClass}
          >
            <option value="float32">FP32</option>
            <option value="bf16">BF16</option>
          </select>
        </label>
      ) : null}
      <label className="space-y-2 text-sm">
        Learning rate schedule
        <select
          value={options.lrScheduler}
          onChange={(event) =>
            changeOptions({
              lrScheduler: event.target
                .value as MediaTrainingOptions["lrScheduler"],
            })
          }
          className={fieldClass}
        >
          <option value="constant">Constant</option>
          <option value="linear">Linear</option>
          <option value="cosine">Cosine</option>
        </select>
      </label>
      {numericOptions
        .filter(
          (field) =>
            !(
              architecture === "krea-2" &&
              ["snrGamma", "noiseOffset", "loraDropout"].includes(field.key)
            ) &&
            !(
              (isFlowTrainingArchitecture(architecture) ||
                isVideoTrainingArchitecture(architecture)) &&
              field.key === "snrGamma"
            ) &&
            !(
              field.key === "guidanceScale" &&
              architecture !== "flux-1" &&
              architecture !== "flux-1-dev"
            ) &&
            !(options.method !== "lora" && field.key === "loraDropout") &&
            !(options.optimizer === "adafactor" && field.key === "maxGradNorm"),
        )
        .map((field) => (
          <label key={field.key} className="space-y-2 text-sm">
            {field.label}
            <input
              type="number"
              min={field.min}
              max={field.key === "warmupSteps" ? settings.steps : field.max}
              step={field.step}
              value={options[field.key]}
              onChange={(event) =>
                changeOptions({ [field.key]: Number(event.target.value) })
              }
              className={fieldClass}
            />
          </label>
        ))}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={options.gradientCheckpointing}
          onChange={(event) =>
            changeOptions({ gradientCheckpointing: event.target.checked })
          }
        />
        Gradient checkpointing
      </label>
      {architecture !== "krea-2" &&
      !isVideoTrainingArchitecture(architecture) ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={options.preserveAspectRatio}
            onChange={(event) =>
              changeOptions({ preserveAspectRatio: event.target.checked })
            }
          />
          Aspect buckets
        </label>
      ) : (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.fourBit}
            onChange={(event) => onChange({ fourBit: event.target.checked })}
          />
          4-bit model weights
        </label>
      )}
      {options.method === "lora" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.attentionOnly}
            onChange={(event) =>
              onChange({ attentionOnly: event.target.checked })
            }
          />
          Attention layers only
        </label>
      ) : null}
    </div>
  );
}
