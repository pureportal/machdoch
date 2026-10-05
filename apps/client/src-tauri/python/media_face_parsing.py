from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from PIL import Image
import torch
from torch import nn
from torch.nn import functional as functional
from torchvision.models import resnet18


class ConvBNReLU(nn.Module):
    def __init__(self, input_channels, output_channels, kernel_size=3, padding=1):
        super().__init__()
        self.conv = nn.Conv2d(input_channels, output_channels, kernel_size, padding=padding, bias=False)
        self.bn = nn.BatchNorm2d(output_channels)

    def forward(self, value):
        return functional.relu(self.bn(self.conv(value)))


class FaceBackbone(nn.Module):
    def __init__(self):
        super().__init__()
        backbone = resnet18(weights=None)
        for name in ("conv1", "bn1", "maxpool", "layer1", "layer2", "layer3", "layer4"):
            setattr(self, name, getattr(backbone, name))

    def forward(self, value):
        value = self.layer1(self.maxpool(functional.relu(self.bn1(self.conv1(value)))))
        eighth = self.layer2(value)
        sixteenth = self.layer3(eighth)
        return eighth, sixteenth, self.layer4(sixteenth)


class AttentionRefinement(nn.Module):
    def __init__(self, input_channels):
        super().__init__()
        self.conv = ConvBNReLU(input_channels, 128)
        self.conv_atten = nn.Conv2d(128, 128, 1, bias=False)
        self.bn_atten = nn.BatchNorm2d(128)

    def forward(self, value):
        features = self.conv(value)
        attention = functional.adaptive_avg_pool2d(features, 1)
        return features * torch.sigmoid(self.bn_atten(self.conv_atten(attention)))


class ContextPath(nn.Module):
    def __init__(self):
        super().__init__()
        self.resnet = FaceBackbone()
        self.arm16 = AttentionRefinement(256)
        self.arm32 = AttentionRefinement(512)
        self.conv_head32 = ConvBNReLU(128, 128)
        self.conv_head16 = ConvBNReLU(128, 128)
        self.conv_avg = ConvBNReLU(512, 128, 1, 0)

    def forward(self, value):
        eighth, sixteenth, thirty_second = self.resnet(value)
        average = self.conv_avg(functional.adaptive_avg_pool2d(thirty_second, 1))
        coarse = self.arm32(thirty_second) + functional.interpolate(average, thirty_second.shape[2:], mode="nearest")
        coarse = self.conv_head32(functional.interpolate(coarse, sixteenth.shape[2:], mode="nearest"))
        fine = self.arm16(sixteenth) + coarse
        fine = self.conv_head16(functional.interpolate(fine, eighth.shape[2:], mode="nearest"))
        return eighth, fine, coarse


class FeatureFusion(nn.Module):
    def __init__(self):
        super().__init__()
        self.convblk = ConvBNReLU(256, 256, 1, 0)
        self.conv1 = nn.Conv2d(256, 64, 1, bias=False)
        self.conv2 = nn.Conv2d(64, 256, 1, bias=False)

    def forward(self, spatial, context):
        features = self.convblk(torch.cat((spatial, context), dim=1))
        attention = functional.adaptive_avg_pool2d(features, 1)
        attention = torch.sigmoid(self.conv2(functional.relu(self.conv1(attention))))
        return features + features * attention


class SegmentationOutput(nn.Module):
    def __init__(self, input_channels, middle_channels):
        super().__init__()
        self.conv = ConvBNReLU(input_channels, middle_channels)
        self.conv_out = nn.Conv2d(middle_channels, 19, 1, bias=False)

    def forward(self, value):
        return self.conv_out(self.conv(value))


class FaceSegmentation(nn.Module):
    def __init__(self):
        super().__init__()
        self.cp = ContextPath()
        self.ffm = FeatureFusion()
        self.conv_out = SegmentationOutput(256, 256)
        self.conv_out16 = SegmentationOutput(128, 64)
        self.conv_out32 = SegmentationOutput(128, 64)

    def forward(self, value):
        spatial, context, _ = self.cp(value)
        logits = self.conv_out(self.ffm(spatial, context))
        return functional.interpolate(logits, value.shape[2:], mode="bilinear", align_corners=True)


class FaceParser:
    def __init__(self, checkpoint: Path, device):
        self.device = device
        self.network = FaceSegmentation()
        self.network.load_state_dict(torch.load(checkpoint, map_location="cpu", weights_only=True), strict=True)
        self.network.to(device).eval()
        self.mean = torch.tensor((0.485, 0.456, 0.406), device=device).view(1, 3, 1, 1)
        self.deviation = torch.tensor((0.229, 0.224, 0.225), device=device).view(1, 3, 1, 1)
        self.jaw_kernel = np.zeros((33, 33), dtype=np.uint8)
        for row in range(10, 33):
            radius = min(row, 20) - 10
            self.jaw_kernel[row, 16 - radius:17 + radius] = 1
        self.cheek_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (35, 3))
        self.cheeks = np.zeros((512, 512), dtype=np.uint8)
        self.cheeks[:, :177] = 255
        self.cheeks[:, 336:] = 255

    def mask(self, image: Image.Image) -> Image.Image:
        pixels = np.asarray(image.resize((512, 512), Image.Resampling.BILINEAR)).copy()
        value = torch.from_numpy(pixels).permute(2, 0, 1).unsqueeze(0).to(self.device, torch.float32) / 255
        labels = self.network((value - self.mean) / self.deviation)[0].argmax(0).cpu().numpy()
        skin = (labels == 1).astype(np.uint8) * 255
        jaw = cv2.dilate(skin, self.jaw_kernel)
        cheeks = cv2.erode(jaw, self.cheek_kernel, iterations=2)
        jaw = np.where(self.cheeks != 0, cheeks, jaw)
        mask = ((jaw == 255) & (labels != 10)) | np.isin(labels, (11, 12, 13))
        return Image.fromarray(mask.astype(np.uint8) * 255).resize(image.size, Image.Resampling.BILINEAR)


def blend_face(frame, replacement, box, parser: FaceParser):
    left, top, right, bottom = box
    center_x, center_y = (left + right) // 2, (top + bottom) // 2
    radius = int(max(right - left, bottom - top) // 2 * 1.5)
    crop = (center_x - radius, center_y - radius, center_x + radius, center_y + radius)
    body = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    region = body.crop(crop)
    local = (left - crop[0], top - crop[1], right - crop[0], bottom - crop[1])
    parsed = parser.mask(region).crop(local)
    mask = Image.new("L", region.size, 0)
    mask.paste(parsed, local)
    mask_pixels = np.array(mask)
    mask_pixels[:region.height // 2] = 0
    kernel_size = int(0.05 * region.width // 2 * 2) + 1
    mask_pixels = cv2.GaussianBlur(mask_pixels, (kernel_size, kernel_size), 0)
    region.paste(Image.fromarray(cv2.cvtColor(replacement, cv2.COLOR_BGR2RGB)), local)
    body.paste(region, crop[:2], Image.fromarray(mask_pixels))
    return np.asarray(body)
