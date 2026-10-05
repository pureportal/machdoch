from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import numpy as np
import torch
from diffusers import AutoencoderKL, UNet2DConditionModel
from transformers import WhisperFeatureExtractor, WhisperModel

from media_face_parsing import FaceParser, blend_face


def audio_embeddings(samples, model_root: Path, device, frame_count: int):
    extractor = WhisperFeatureExtractor.from_pretrained(model_root / "whisper", local_files_only=True)
    whisper = WhisperModel.from_pretrained(model_root / "whisper", local_files_only=True).to(device).eval()
    segments = []
    for offset in range(0, len(samples), 480_000):
        segment = samples[offset:offset + 480_000]
        features = extractor(segment, sampling_rate=16000, return_tensors="pt").input_features.to(device)
        hidden = torch.stack(whisper.encoder(features, output_hidden_states=True).hidden_states, dim=2)
        segments.append(hidden[:, :math.ceil(len(segment) / 320)].cpu())
    hidden = torch.cat(segments, dim=1)
    padding_shape = (1, 4, *hidden.shape[2:])
    hidden = torch.cat((torch.zeros(padding_shape), hidden, torch.zeros((1, 12, *hidden.shape[2:]))), dim=1)
    prompts = torch.cat([hidden[:, index * 2:index * 2 + 10] for index in range(frame_count)], dim=0)
    del whisper
    if device == "cuda":
        torch.cuda.empty_cache()
    return prompts.reshape(frame_count, 50, 384)


def face_box(frame, detector, crop_shift: int, frame_index: int):
    height, width = frame.shape[:2]
    detector.setInputSize((width, height))
    _, faces = detector.detect(frame)
    if faces is None or len(faces) != 1:
        count = 0 if faces is None else len(faces)
        raise ValueError(f"Found {count} faces at {frame_index / 25:.2f}s. Use a video with one visible face per frame.")
    face = faces[0]
    left = max(0, math.floor(face[0]))
    right = min(width, math.ceil(face[0] + face[2]))
    bottom = min(height, math.ceil(face[1] + face[3]) + 10)
    top = max(0, math.floor(2 * face[9] - bottom) + crop_shift)
    if right - left < 48 or bottom - top < 48:
        raise ValueError(f"The face is too small at {frame_index / 25:.2f}s. Use a closer view or reduce Face crop shift.")
    return left, top, right, bottom


class MuseTalk:
    def __init__(self, root: Path, device: str, seed: int):
        self.device = device
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        self.generator = torch.Generator(device=device).manual_seed(seed)
        with (root / "musetalkV15/musetalk.json").open(encoding="utf-8") as source:
            config = json.load(source)
        with torch.device("meta"):
            self.unet = UNet2DConditionModel(**config)
        state = torch.load(root / "musetalkV15/unet.pth", map_location="cpu", weights_only=True, mmap=True)
        self.unet.load_state_dict(state, strict=True, assign=True)
        self.unet.to(device=device, dtype=self.dtype).eval()
        self.vae = AutoencoderKL.from_pretrained(root / "vae", local_files_only=True, use_safetensors=True).to(device).eval()
        self.parser = FaceParser(root / "face-parser/79999_iter.pth", device)
        self.detector = cv2.FaceDetectorYN.create(
            str(root / "face-detector/face_detection_yunet_2023mar.onnx"), "", (640, 640), 0.85, 0.3, 5000,
        )
        positions = torch.arange(50, dtype=torch.float32).unsqueeze(1)
        scales = torch.exp(torch.arange(0, 384, 2).float() * (-math.log(10000.0) / 384))
        encoding = torch.zeros((50, 384))
        encoding[:, 0::2] = torch.sin(positions * scales)
        encoding[:, 1::2] = torch.cos(positions * scales)
        self.positions = encoding.to(device=device, dtype=self.dtype).unsqueeze(0)

    def render_batch(self, frames, audio, crop_shift: int, offset: int):
        boxes = [face_box(frame, self.detector, crop_shift, offset + index) for index, frame in enumerate(frames)]
        crops = [cv2.resize(frame[top:bottom, left:right], (256, 256), interpolation=cv2.INTER_LANCZOS4)
                 for frame, (left, top, right, bottom) in zip(frames, boxes)]
        pixels = np.stack([cv2.cvtColor(crop, cv2.COLOR_BGR2RGB) for crop in crops])
        values = torch.from_numpy(pixels).permute(0, 3, 1, 2).to(self.device, torch.float32) / 255
        masked = values.clone()
        masked[:, :, 128:] = 0
        masked_latents = self.vae.encode(masked * 2 - 1).latent_dist.sample(generator=self.generator)
        reference_latents = self.vae.encode(values * 2 - 1).latent_dist.sample(generator=self.generator)
        latents = torch.cat((masked_latents, reference_latents), dim=1) * self.vae.config.scaling_factor
        audio = audio.to(device=self.device, dtype=self.dtype) + self.positions
        prediction = self.unet(latents.to(self.dtype), torch.tensor([0], device=self.device), encoder_hidden_states=audio).sample
        if not torch.isfinite(prediction).all():
            raise ValueError("Lip sync produced invalid pixels. Retry with a smaller batch size.")
        decoded = self.vae.decode(prediction.float() / self.vae.config.scaling_factor).sample
        pixels = ((decoded / 2 + 0.5).clamp(0, 1) * 255).round().to(torch.uint8).cpu().permute(0, 2, 3, 1).numpy()
        for frame, pixel, box in zip(frames, pixels, boxes):
            left, top, right, bottom = box
            replacement = cv2.resize(cv2.cvtColor(pixel, cv2.COLOR_RGB2BGR), (right - left, bottom - top))
            yield blend_face(frame, replacement, box, self.parser)
