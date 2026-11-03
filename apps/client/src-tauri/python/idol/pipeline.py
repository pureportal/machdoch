import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import torch
from PIL import Image
from safetensors.torch import load_file

from .camera import decode_camera
from .conditioning import ImageEncoder
from .gaussian import Gaussian
from .models import BiRefNet, GaussianFixedlenDecoder, LatentSeqMMFlowModel, OctreeProbabilityFixedlenDecoder
from .preprocess import CROP_MARGIN, preprocess_image
from .sampler import sample_flow

ProgressCallback = Callable[[str, float], None]


@dataclass
class IdolOutput:
    gaussian: Gaussian               # the object; .save_ply(path) writes a standard 3DGS PLY
    preprocessed_image: Image.Image  # the 1024 x 1024 image the model saw (background removed, cropped)
    camera: dict                     # predicted input camera: yaw, pitch (radians), radius, fov (degrees)


class IdolPipeline:
    """Loads a local package with the Idol weights in idol/, the DINOv3 ViT-H+/16 encoder in dinov3/ and the
    FLUX.2 autoencoder in vae/. Sampling runs eagerly."""

    def __init__(self, package_root: Path, device: torch.device):
        self.device = device
        weights = package_root / 'idol'
        self.config = json.loads((weights / 'config.json').read_text(encoding='utf-8'))

        def load(model_class, name, **arguments):
            with torch.device(self.device):
                model = model_class(**arguments)
            state = {key: value.pin_memory() if self.device.type == 'cuda' else value
                     for key, value in load_file(str(weights / f'{name}.safetensors')).items()}
            model.load_state_dict(state, strict=True)
            return model.eval().requires_grad_(False).to(self.device)

        self.denoiser = load(LatentSeqMMFlowModel, 'denoiser', **self.config['denoiser']['args'])
        self.decoder = load(OctreeProbabilityFixedlenDecoder, 'decoder', **self.config['decoder']['args'])
        self.decoder_gs = load(GaussianFixedlenDecoder, 'decoder_gs', **self.config['decoder_gs']['args'])
        self.background_remover = load(BiRefNet, 'birefnet')
        if self.device.type == 'cuda':
            self.background_remover.half()
        self.image_encoder = ImageEncoder(package_root / 'dinov3', package_root / 'vae', self.device)

    def preprocess(self, image: Image.Image, mode: str, crop_margin: Optional[float] = None) -> Image.Image:
        """mode 'synthetic' (renders, generated images of one object: crop 1.2) or 'real' (photos: crop 1.7);
        crop_margin overrides the mode's value."""
        margin = crop_margin if crop_margin is not None else CROP_MARGIN[mode]
        return preprocess_image(image, background_remover=self.background_remover,
                                image_size=self.config['image_size'], crop_margin=margin)

    @torch.no_grad()
    def __call__(
        self,
        image: Image.Image,
        mode: str = 'synthetic',
        seed: int = 42,
        steps: int = 50,
        cfg_strength: float = 3.0,
        rescale_t: float = 3.0,
        num_gaussians: int = 262144,
        crop_margin: Optional[float] = None,
        on_progress: Optional[ProgressCallback] = None,
    ) -> IdolOutput:
        """Generate the 3D Gaussians of the object in ``image``.

        num_gaussians: 32,768 to 1,048,576, rounded down to a multiple of 32.
        on_progress(stage, fraction) reports 'background', 'encode', 'sample' and 'decode'."""
        report = on_progress or (lambda stage, fraction: None)
        report('background', 0.0)
        prepared = self.preprocess(image, mode=mode, crop_margin=crop_margin)
        pixels = torch.from_numpy(np.array(prepared)).permute(2, 0, 1).float().div(255.0)[None].to(self.device)

        report('encode', 0.0)
        torch.manual_seed(seed)
        cond = self.image_encoder(pixels)
        noise = {
            'latent': torch.randn(1, self.denoiser.q_token_length, self.denoiser.in_channels, device=self.device),
            'camera': torch.randn(1, 1, self.denoiser.cam_channels, device=self.device),
        }
        report('sample', 0.0)
        sample = sample_flow(self.denoiser, noise, cond=cond,
                             neg_cond={key: torch.zeros_like(value) for key, value in cond.items()},
                             steps=steps, rescale_t=rescale_t, cfg_strength=cfg_strength,
                             on_step=lambda completed, total: report('sample', completed / total))
        report('decode', 0.0)
        gaussian = self.decode(sample['latent'], num_gaussians)
        return IdolOutput(gaussian=gaussian, preprocessed_image=prepared, camera=decode_camera(sample['camera'][0, 0]))

    @torch.no_grad()
    def decode(self, latent: torch.Tensor, num_gaussians: int = 262144) -> Gaussian:
        """Latent [1, 8192, 16] -> Gaussians: the octree decoder places num_gaussians / 32 anchor points, the
        Gaussian decoder turns each anchor into 32 Gaussians."""
        per_anchor = self.decoder_gs.rep_config['num_gaussians']
        anchors = OctreeProbabilityFixedlenDecoder.sample(self.decoder, latent,
                                                          num_points=max(1, int(num_gaussians) // per_anchor),
                                                          level=self.config['max_voxel_level'])
        return self.decoder_gs.to_representation(anchors, self.decoder_gs(anchors, latent))[0]
