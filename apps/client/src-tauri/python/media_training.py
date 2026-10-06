import json
import os
import runpy
import re
import sys
from pathlib import Path


def write_status(path: Path, state: str, message: str | None = None) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"state": state, "message": message}), encoding="utf-8"
    )
    os.replace(temporary, path)


def train_krea(specification: dict, job_directory: Path) -> None:
    arguments = [
        str(Path(__file__).with_name("train_dreambooth_lora_krea2.py")),
        "--pretrained_model_name_or_path",
        specification["model"]["path"],
        "--dataset_name",
        str(job_directory / "dataset"),
        "--image_column",
        "image",
        "--caption_column",
        "text",
        "--instance_prompt",
        specification["trigger_phrase"],
        "--output_dir",
        str(job_directory / "output"),
        "--mixed_precision",
        "no" if specification["precision"] == "float32" else specification["precision"],
        "--resolution",
        str(specification["resolution"]),
        "--train_batch_size",
        str(specification["batch_size"]),
        "--gradient_accumulation_steps",
        str(specification["gradient_accumulation"]),
        "--rank",
        str(specification["rank"]),
        "--lora_alpha",
        str(specification["rank"]),
        "--learning_rate",
        str(specification["learning_rate"]),
        "--max_train_steps",
        str(specification["steps"]),
        "--seed",
        str(specification["seed"]),
        "--lr_scheduler",
        "constant_with_warmup" if specification["lr_scheduler"] == "constant" and specification["warmup_steps"] else specification["lr_scheduler"],
        "--lr_warmup_steps",
        str(specification["warmup_steps"]),
        "--adam_weight_decay",
        str(specification["weight_decay"]),
        "--max_grad_norm",
        str(specification["max_grad_norm"]),
        "--report_to",
        "none",
        "--checkpointing_steps",
        str(specification["checkpoint_interval"]),
        "--checkpoints_total_limit",
        str(specification["checkpoint_retention"]),
        "--cache_latents",
        "--offload",
        "--skip_final_inference",
    ]
    if specification["gradient_checkpointing"]:
        arguments.append("--gradient_checkpointing")
    if specification["attention_only"]:
        arguments.extend(["--lora_layers", "to_q,to_k,to_v,to_out.0,to_gate"])
    if specification["four_bit"]:
        arguments.extend(
            ["--bnb_quantization_config_path", str(job_directory / "quantization.json")]
        )
    if specification["resume"]:
        arguments.extend(["--resume_from_checkpoint", "latest"])
    sys.argv = arguments
    runpy.run_path(arguments[0], run_name="__main__")


def main() -> None:
    job_directory = Path(sys.argv[1]).resolve()
    specification = json.loads((job_directory / "job.json").read_text(encoding="utf-8"))
    status_path = job_directory / "status.json"
    diffusion = specification["architecture"] in ("stable-diffusion-1", "stable-diffusion-2", "stable-diffusion-xl", "pony")
    flow = specification["architecture"] in ("stable-diffusion-3", "flux-1", "flux-1-dev", "flux-1-schnell", "flux-2", "flux-2-klein-base-4b", "flux-2-klein-9b", "flux-2-klein-base-9b", "sana", "z-image", "z-image-turbo")
    video = specification["architecture"] in ("cogvideox-2b", "cogvideox-1.5-5b", "cogvideox-1.5-5b-i2v")
    wan = specification["architecture"] in ("wan-2.1-t2v-1.3b",)
    write_status(status_path, "running", "Loading model" if diffusion or flow or video or wan else None)
    try:
        options = specification.pop("options")
        specification.update({re.sub(r"(?<!^)(?=[A-Z])", "_", key).lower(): value for key, value in options.items()})
        specification["checkpoint_interval"] = min(specification["checkpoint_interval"], specification["steps"])
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        if wan:
            from media_wan_training import train

            train(specification, job_directory)
        elif video:
            from media_cogvideo_training import train

            train(specification, job_directory)
        elif flow:
            from media_flow_training import train

            train(specification, job_directory)
        elif diffusion:
            from media_diffusion_training import train

            train(specification, job_directory)
        elif specification["architecture"] == "krea-2":
            if specification["method"] != "lora":
                raise ValueError("KREA 2 RAW currently trains LoRA adapters.")
            if specification["optimizer"] != "adamw" or specification["trainable_precision"] != "float32":
                raise ValueError("Choose AdamW and FP32 trainable weights for KREA 2 RAW.")
            train_krea(specification, job_directory)
        else:
            raise ValueError("This model has no integrated training runtime.")
        artifact = {"lora": "pytorch_lora_weights.safetensors", "embedding": "learned_embeds.safetensors", "finetune": "model/model_index.json"}[specification["method"]]
        if not (job_directory / "output" / artifact).is_file():
            raise RuntimeError("Training finished without its output artifact.")
        write_status(status_path, "completed")
    except SystemExit as error:
        write_status(
            status_path,
            "failed",
            (
                "The local trainer rejected its settings."
                if error.code == 2
                else str(error)
            ),
        )
        raise
    except BaseException as error:
        write_status(status_path, "failed", str(error)[:1000])
        raise


if __name__ == "__main__":
    main()
