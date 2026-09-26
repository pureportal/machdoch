import json
import os
import runpy
import sys
import traceback
from pathlib import Path


def write_status(path: Path, state: str, message: str | None = None) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"state": state, "message": message}), encoding="utf-8")
    os.replace(temporary, path)


def main() -> None:
    job_directory = Path(sys.argv[1]).resolve()
    specification = json.loads((job_directory / "job.json").read_text(encoding="utf-8"))
    status_path = job_directory / "status.json"
    output_directory = job_directory / "output"
    dataset_directory = job_directory / "dataset"
    arguments = [
        str(Path(__file__).with_name("train_dreambooth_lora_krea2.py")),
        "--pretrained_model_name_or_path", specification["raw_model_path"],
        "--dataset_name", str(dataset_directory),
        "--image_column", "image",
        "--caption_column", "text",
        "--instance_prompt", specification["trigger_phrase"],
        "--output_dir", str(output_directory),
        "--mixed_precision", specification["precision"],
        "--resolution", str(specification["resolution"]),
        "--train_batch_size", "1",
        "--rank", str(specification["rank"]),
        "--lora_alpha", str(specification["rank"]),
        "--learning_rate", str(specification["learning_rate"]),
        "--max_train_steps", str(specification["steps"]),
        "--lr_scheduler", "constant",
        "--lr_warmup_steps", "0",
        "--report_to", "none",
        "--checkpointing_steps", str(specification["checkpoint_interval"]),
        "--checkpoints_total_limit", "2",
        "--gradient_checkpointing",
        "--cache_latents",
        "--offload",
        "--skip_final_inference",
    ]
    if specification["attention_only"]:
        arguments.extend(["--lora_layers", "to_q,to_k,to_v,to_out.0,to_gate"])
    if specification["four_bit"]:
        arguments.extend(["--bnb_quantization_config_path", str(job_directory / "quantization.json")])
    if specification["resume"]:
        arguments.extend(["--resume_from_checkpoint", "latest"])
    sys.argv = arguments
    write_status(status_path, "running")
    try:
        runpy.run_path(arguments[0], run_name="__main__")
        if not (output_directory / "pytorch_lora_weights.safetensors").is_file():
            raise RuntimeError("Training finished without LoRA weights.")
        write_status(status_path, "completed")
    except SystemExit as error:
        traceback.print_exc()
        write_status(status_path, "failed", "The local trainer rejected its settings." if error.code == 2 else str(error))
        raise
    except BaseException as error:
        traceback.print_exc()
        write_status(status_path, "failed", str(error)[:1000])
        raise


if __name__ == "__main__":
    main()
