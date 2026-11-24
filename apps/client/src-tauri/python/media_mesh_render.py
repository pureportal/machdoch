"""Software rendering of triangle meshes for library previews.

The mesh is y-up. The camera orbits the mesh: the unit direction from the mesh to the camera is
(sin yaw cos pitch, sin pitch, cos yaw cos pitch)."""

from __future__ import annotations

import math
from typing import Any

import numpy as np

BASE_COLOR = (0.80, 0.78, 0.74)
AMBIENT = 0.3
LIGHT_DIRECTION = (-0.45, 0.6, -1.0)
SIZE_BUCKETS = (1, 2, 4, 8, 16, 32, 64, 128, 256)
FRAGMENT_BATCH = 12_000_000
SUPERSAMPLING = 2
NEAR_DEPTH = 1e-3


def orbit_camera(yaw: float, pitch: float, fov_degrees: float, center: np.ndarray, radius: float) -> dict[str, Any]:
    pitch = max(-1.45, min(1.45, pitch))
    distance = 1.08 * radius / math.sin(math.radians(fov_degrees) / 2)
    direction = np.array([math.sin(yaw) * math.cos(pitch), math.sin(pitch), math.cos(yaw) * math.cos(pitch)])
    eye = center + direction * distance
    forward = -direction
    right = np.cross(forward, np.array([0.0, 1.0, 0.0]))
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return {"eye": eye, "rotation": np.stack([right, up, forward]), "fov": fov_degrees}


def framing(vertices: np.ndarray) -> tuple[np.ndarray, float]:
    center = (vertices.min(axis=0) + vertices.max(axis=0)) / 2
    radius = float(np.linalg.norm(vertices - center, axis=1).max())
    return center.astype(np.float64), max(radius, 1e-3)


def _fragments(torch: Any, screen: Any, inverse_depth: Any, size: int) -> tuple[Any, Any, Any]:
    device = screen.device
    p0, p1, p2 = screen[:, 0], screen[:, 1], screen[:, 2]
    area = (p1[:, 0] - p0[:, 0]) * (p2[:, 1] - p0[:, 1]) - (p1[:, 1] - p0[:, 1]) * (p2[:, 0] - p0[:, 0])
    low = torch.floor(screen.min(dim=1).values).clamp(0, size - 1)
    high = torch.floor(screen.max(dim=1).values).clamp(0, size - 1)
    extent = (high - low).max(dim=1).values + 1
    candidates = (area.abs() > 1e-9) & (screen.max(dim=1).values >= 0).all(dim=1) \
        & (screen.min(dim=1).values < size).all(dim=1)
    pixels_out, depth_out, faces_out = [], [], []
    lower = 0
    for bucket in SIZE_BUCKETS:
        last = bucket == SIZE_BUCKETS[-1]
        selected_mask = candidates & (extent > lower) & ((extent <= bucket) | last)
        lower = bucket
        if last and selected_mask.any():
            bucket = max(bucket, int(extent[selected_mask].max()))
        offsets = torch.arange(bucket, device=device, dtype=torch.float32)
        grid = torch.stack(torch.meshgrid(offsets, offsets, indexing="xy"), dim=-1).view(-1, 2)
        for selected in torch.nonzero(selected_mask).squeeze(1).split(max(1, FRAGMENT_BATCH // grid.shape[0])):
            pixel = low[selected][:, None, :] + grid[None, :, :]
            sample = pixel + 0.5
            a, b, c = p0[selected][:, None, :], p1[selected][:, None, :], p2[selected][:, None, :]
            signed = area[selected][:, None]
            w0 = ((b[..., 0] - sample[..., 0]) * (c[..., 1] - sample[..., 1])
                  - (b[..., 1] - sample[..., 1]) * (c[..., 0] - sample[..., 0])) / signed
            w1 = ((c[..., 0] - sample[..., 0]) * (a[..., 1] - sample[..., 1])
                  - (c[..., 1] - sample[..., 1]) * (a[..., 0] - sample[..., 0])) / signed
            w2 = 1 - w0 - w1
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0) & (pixel[..., 0] < size) & (pixel[..., 1] < size)
            weights = inverse_depth[selected][:, None, :]
            depth = w0 * weights[..., 0] + w1 * weights[..., 1] + w2 * weights[..., 2]
            flat = pixel[inside].long()
            pixels_out.append(flat[:, 1] * size + flat[:, 0])
            depth_out.append(depth[inside])
            faces_out.append(selected[:, None].expand_as(depth)[inside])
    if not pixels_out:
        empty = torch.empty(0, device=device)
        return empty.long(), empty, empty.long()
    return torch.cat(pixels_out), torch.cat(depth_out), torch.cat(faces_out)


def render(vertices: np.ndarray, faces: np.ndarray, torch: Any, device: str, camera: dict[str, Any], size: int) -> np.ndarray:
    """Z-buffer the mesh with two-sided Lambert shading into a straight-alpha RGBA uint8 image."""
    working = size * SUPERSAMPLING
    rotation = torch.tensor(camera["rotation"], dtype=torch.float32, device=device)
    eye = torch.tensor(camera["eye"], dtype=torch.float32, device=device)
    points = (torch.tensor(vertices, dtype=torch.float32, device=device) - eye) @ rotation.T
    triangles = points[torch.tensor(faces, dtype=torch.long, device=device)]
    in_front = (triangles[..., 2] > NEAR_DEPTH).all(dim=1)
    triangles = triangles[in_front]
    focal = 0.5 * working / math.tan(math.radians(camera["fov"]) / 2)
    depth = triangles[..., 2]
    screen = torch.stack([
        0.5 * working + focal * triangles[..., 0] / depth,
        0.5 * working - focal * triangles[..., 1] / depth,
    ], dim=-1)
    normals = torch.linalg.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals = normals / torch.linalg.norm(normals, dim=1, keepdim=True).clamp_min(1e-12)
    light = torch.tensor(LIGHT_DIRECTION, dtype=torch.float32, device=device)
    light = light / torch.linalg.norm(light)
    shade = AMBIENT + (1 - AMBIENT) * (normals @ light).abs()
    pixel, inverse, face = _fragments(torch, screen, 1 / depth, working)
    image = np.zeros((size, size, 4), dtype=np.uint8)
    if pixel.numel() == 0:
        return image
    nearest = torch.full((working * working,), -1.0, device=device).scatter_reduce(0, pixel, inverse, reduce="amax")
    winners = inverse >= nearest[pixel]
    covered = torch.zeros(working * working, device=device)
    intensity = torch.zeros(working * working, device=device)
    covered[pixel[winners]] = 1.0
    intensity[pixel[winners]] = shade[face[winners]]
    coverage = covered.view(size, SUPERSAMPLING, size, SUPERSAMPLING).mean(dim=(1, 3))
    lit = intensity.view(size, SUPERSAMPLING, size, SUPERSAMPLING).sum(dim=(1, 3)) \
        / covered.view(size, SUPERSAMPLING, size, SUPERSAMPLING).sum(dim=(1, 3)).clamp_min(1)
    base = torch.tensor(BASE_COLOR, dtype=torch.float32, device=device)
    rgba = torch.cat([lit[..., None] * base, coverage[..., None]], dim=-1).clamp(0, 1)
    return (rgba * 255 + 0.5).byte().cpu().numpy()
