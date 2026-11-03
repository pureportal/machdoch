from typing import Callable, Optional

import numpy as np
import torch

Sample = dict[str, torch.Tensor]


@torch.no_grad()
def sample_flow(model, noise: Sample, cond: Sample, neg_cond: Sample, steps: int = 50, rescale_t: float = 3.0,
                cfg_strength: float = 3.0, on_step: Optional[Callable[[int, int], None]] = None) -> Sample:
    """Integrate from noise (t = 1) to data (t = 0) in ``steps`` Euler steps.

    rescale_t shifts the time grid towards t = 1 (more steps at high noise).
    cfg_strength: guided velocity = (1 + w) * v(cond) - w * v(neg_cond).
    on_step(completed, steps) is called after every step."""

    def velocity(sample, t, condition):
        batch = sample['latent'].shape[0]
        return model(sample, torch.tensor([1000 * t] * batch, device=sample['latent'].device, dtype=torch.float32),
                     condition)

    sample = noise
    t_seq = np.linspace(1, 0, steps + 1)
    t_seq = rescale_t * t_seq / (1 + (rescale_t - 1) * t_seq)
    for i in range(steps):
        t, t_prev = t_seq[i], t_seq[i + 1]
        v = velocity(sample, t, cond)
        if cfg_strength > 0:
            unconditional = velocity(sample, t, neg_cond)
            v = {key: (1 + cfg_strength) * v[key] - cfg_strength * unconditional[key] for key in v}
        sample = {key: sample[key] - v[key] * (t - t_prev) for key in sample}
        if on_step is not None:
            on_step(i + 1, steps)
    return sample
