"""Software rendering of 3D Gaussian splats for library previews.

The object is z-up inside [-0.5, 0.5]^3. The camera orbits the object: the unit direction from the object to the
camera is (sin yaw cos pitch, cos yaw cos pitch, sin pitch)."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

SH_C0 = 0.28209479177387814
RADIUS_BUCKETS = (1, 2, 3, 4, 6, 8, 12, 16, 24, 32)
FRAGMENT_BATCH = 8_000_000
MIN_ALPHA = 1 / 255


def framing(gaussian: Any, torch: Any) -> tuple[np.ndarray, float]:
    """The centre and radius of the sphere holding 99.5% of the Gaussians."""
    points = gaussian.xyz.float()
    sample = points[torch.randperm(points.shape[0], device=points.device)[:65536]]
    low = torch.quantile(sample, 0.0025, dim=0)
    high = torch.quantile(sample, 0.9975, dim=0)
    center = (low + high) / 2
    radius = torch.quantile(torch.linalg.norm(sample - center, dim=1), 0.995)
    return center.cpu().numpy().astype(np.float64), max(float(radius), 0.05)


def orbit_camera(yaw: float, pitch: float, fov_degrees: float, center: np.ndarray, radius: float) -> dict[str, Any]:
    """A camera looking at center that keeps a sphere of the given radius in view."""
    pitch = max(-1.45, min(1.45, pitch))
    distance = 1.08 * radius / math.sin(math.radians(fov_degrees) / 2)
    direction = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)])
    eye = center + direction * distance
    forward = -direction
    right = np.cross(forward, np.array([0.0, 0.0, 1.0]))
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return {"eye": eye, "rotation": np.stack([right, up, forward]), "fov": fov_degrees}


def _rotation_matrices(torch: Any, quaternions: Any) -> Any:
    w, x, y, z = quaternions.unbind(-1)
    return torch.stack([
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ], dim=-1).view(-1, 3, 3)


def render(gaussian: Any, torch: Any, camera: dict[str, Any], size: int) -> np.ndarray:
    """Alpha-composite the splats front to back into a straight-alpha RGBA uint8 image."""
    device = gaussian.xyz.device
    rotation = torch.tensor(camera["rotation"], dtype=torch.float32, device=device)
    eye = torch.tensor(camera["eye"], dtype=torch.float32, device=device)
    focal = 0.5 * size / math.tan(math.radians(camera["fov"]) / 2)
    center = 0.5 * size

    points = (gaussian.xyz.float() - eye) @ rotation.T
    visible = points[:, 2] > 0.05
    points = points[visible]
    depth = points[:, 2]
    scales = gaussian.scaling.float()[visible]
    rotations = _rotation_matrices(torch, gaussian.rotation.float()[visible])
    opacity = gaussian.opacity.float()[visible, 0]
    colors = (0.5 + SH_C0 * gaussian.features_dc.float()[visible, 0]).clamp(0, 1)

    world_covariance = rotations @ torch.diag_embed(scales * scales) @ rotations.transpose(1, 2)
    camera_covariance = rotation @ world_covariance @ rotation.T
    jacobian = torch.zeros(points.shape[0], 2, 3, device=device)
    jacobian[:, 0, 0] = focal / depth
    jacobian[:, 0, 2] = -focal * points[:, 0] / depth ** 2
    jacobian[:, 1, 1] = -focal / depth
    jacobian[:, 1, 2] = focal * points[:, 1] / depth ** 2
    covariance = jacobian @ camera_covariance @ jacobian.transpose(1, 2)
    a = covariance[:, 0, 0] + 0.3
    b = covariance[:, 0, 1]
    c = covariance[:, 1, 1] + 0.3
    determinant = (a * c - b * b).clamp_min(1e-12)
    conic = torch.stack([c / determinant, -b / determinant, a / determinant], dim=1)
    largest = 0.5 * (a + c) + torch.sqrt((0.25 * (a - c) ** 2 + b * b).clamp_min(0))
    radius = torch.ceil(3 * torch.sqrt(largest))
    screen = torch.stack([center + focal * points[:, 0] / depth, center - focal * points[:, 1] / depth], dim=1)
    rank = torch.empty_like(depth, dtype=torch.long)
    rank[torch.argsort(depth)] = torch.arange(depth.shape[0], device=device)

    fragments: list[tuple[Any, Any, Any, Any]] = []
    lower = 0
    for bucket in RADIUS_BUCKETS:
        in_bucket = radius > lower if bucket == RADIUS_BUCKETS[-1] else (radius > lower) & (radius <= bucket)
        lower = bucket
        offsets = torch.arange(-bucket, bucket + 1, device=device, dtype=torch.float32)
        grid = torch.stack(torch.meshgrid(offsets, offsets, indexing="xy"), dim=-1).view(-1, 2)
        for selected in torch.nonzero(in_bucket).squeeze(1).split(max(1, FRAGMENT_BATCH // grid.shape[0])):
            pixels = torch.floor(screen[selected])[:, None, :] + grid[None, :, :]
            delta = pixels + 0.5 - screen[selected][:, None, :]
            q = conic[selected]
            power = -0.5 * (q[:, None, 0] * delta[..., 0] ** 2 + q[:, None, 2] * delta[..., 1] ** 2) \
                - q[:, None, 1] * delta[..., 0] * delta[..., 1]
            alpha = (opacity[selected][:, None] * torch.exp(power)).clamp(max=0.99)
            inside = (alpha >= MIN_ALPHA) & (pixels[..., 0] >= 0) & (pixels[..., 0] < size) \
                & (pixels[..., 1] >= 0) & (pixels[..., 1] < size)
            source = selected[:, None].expand_as(alpha)[inside]
            flat = pixels[inside].long()
            fragments.append((flat[:, 1] * size + flat[:, 0], rank[source], alpha[inside], source))

    if not fragments:
        return np.zeros((size, size, 4), dtype=np.uint8)
    pixel, fragment_rank, alpha, source = (torch.cat(column) for column in zip(*fragments))
    order = torch.argsort(pixel * depth.shape[0] + fragment_rank)
    pixel, alpha, source = pixel[order], alpha[order].double(), source[order]
    log_transmittance = torch.log1p(-alpha)
    before = torch.cumsum(log_transmittance, 0) - log_transmittance
    starts = torch.ones_like(pixel, dtype=torch.bool)
    starts[1:] = pixel[1:] != pixel[:-1]
    segment = torch.cumsum(starts.long(), 0) - 1
    weight = (alpha * torch.exp(before - before[starts][segment])).float()

    coverage = torch.zeros(size * size, device=device).index_add_(0, pixel, weight)
    color = torch.zeros(size * size, 3, device=device).index_add_(0, pixel, weight[:, None] * colors[source])
    straight = color / coverage.clamp_min(1e-6)[:, None]
    rgba = torch.cat([straight, coverage[:, None]], dim=1).clamp(0, 1).view(size, size, 4)
    return (rgba * 255 + 0.5).byte().cpu().numpy()
