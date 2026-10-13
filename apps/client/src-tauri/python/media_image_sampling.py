from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from media_open_models import PROFILES


SAMPLING_PROFILES = {
    profile["architecture"]: profile
    for profile in json.loads(Path(__file__).with_name("image_sampling_profiles.json").read_text(encoding="utf-8"))
}

SAMPLERS = {
    "euler": ("EulerDiscreteScheduler", {}),
    "euler-ancestral": ("EulerAncestralDiscreteScheduler", {}),
    "heun": ("HeunDiscreteScheduler", {}),
    "dpmpp-2m": ("DPMSolverMultistepScheduler", {"algorithm_type": "dpmsolver++", "solver_order": 2, "use_karras_sigmas": False}),
    "dpmpp-2m-karras": ("DPMSolverMultistepScheduler", {"algorithm_type": "dpmsolver++", "solver_order": 2, "use_karras_sigmas": True}),
    "dpmpp-2m-sde-karras": ("DPMSolverMultistepScheduler", {"algorithm_type": "sde-dpmsolver++", "solver_order": 2, "use_karras_sigmas": True}),
    "ddim": ("DDIMScheduler", {}),
    "deis": ("DEISMultistepScheduler", {"algorithm_type": "deis", "solver_order": 2, "use_karras_sigmas": False}),
    "unipc": ("UniPCMultistepScheduler", {"solver_order": 2}),
    "flow-euler": ("FlowMatchEulerDiscreteScheduler", {}),
    "lcm": ("LCMScheduler", {}),
    "scm": ("SCMScheduler", {}),
    "hunyuan-euler": ("FlowMatchDiscreteScheduler", {"solver": "euler"}),
}


def validate_sampler(architecture: str, sampler: Any) -> None:
    if sampler is None:
        return
    profile = SAMPLING_PROFILES.get(architecture)
    if not isinstance(sampler, str) or profile is None or sampler not in profile["samplers"]:
        raise ValueError(f"Choose a compatible sampler for {architecture}")


def configure_sampler(pipeline: Any, diffusers: Any, architecture: str, sampler: str | None) -> None:
    validate_sampler(architecture, sampler)
    if not hasattr(pipeline, "_machdoch_default_scheduler"):
        pipeline._machdoch_default_scheduler = pipeline.scheduler
    original = pipeline._machdoch_default_scheduler
    profile = PROFILES.get(architecture, {})
    recommended = SAMPLING_PROFILES[architecture]["recommendedSamplers"]
    scheduler_options = profile.get("schedulerOptions", {})
    if sampler is None and not scheduler_options and not profile.get("baseArchitecture"):
        scheduler = original
    else:
        class_name, options = SAMPLERS[sampler if sampler is not None else recommended[0]]
        if architecture == "hidream-i1-full" and sampler == "flow-euler":
            options = {**options, "shift": original.config["flow_shift"]}
        if architecture == "hunyuan-image-3":
            from hunyuan_image_3.hunyuan_image_3_pipeline import FlowMatchDiscreteScheduler

            scheduler_class = FlowMatchDiscreteScheduler
        else:
            scheduler_class = getattr(diffusers, class_name)
        scheduler = scheduler_class.from_config(original.config, **options, **scheduler_options)
    if architecture == "anima":
        pipeline.update_components(scheduler=scheduler)
    else:
        pipeline.scheduler = scheduler
