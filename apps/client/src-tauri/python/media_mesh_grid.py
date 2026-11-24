"""Solid occupancy grids sampled from a triangle mesh, shared by the voxel and low-poly stylizers."""

from __future__ import annotations

from typing import Any

import numpy as np
from scipy import ndimage

SAMPLE_BATCH = 2_000_000
MIN_ISLAND_SHARE = 0.01


def _barycentric_lattice(divisions: int) -> np.ndarray:
    first, second = np.meshgrid(np.arange(divisions + 1), np.arange(divisions + 1), indexing="ij")
    inside = first + second <= divisions
    first, second = first[inside], second[inside]
    return np.stack([divisions - first - second, first, second], axis=1) / divisions


def _mark_surface(surface: np.ndarray, triangles: np.ndarray, origin: np.ndarray, pitch: float) -> None:
    edges = np.linalg.norm(triangles - np.roll(triangles, 1, axis=1), axis=2).max(axis=1)
    divisions = np.maximum(1, np.ceil(edges / (pitch / 2))).astype(np.int64)
    upper = np.array(surface.shape) - 1
    for count in np.unique(divisions):
        weights = _barycentric_lattice(int(count))
        group = triangles[divisions == count]
        batch = max(1, SAMPLE_BATCH // len(weights))
        for start in range(0, len(group), batch):
            points = np.einsum("wk,tkd->twd", weights, group[start:start + batch]).reshape(-1, 3)
            cells = np.clip(np.floor((points - origin) / pitch).astype(np.int64), 0, upper)
            surface[cells[:, 0], cells[:, 1], cells[:, 2]] = True


def cell_occupancy(mesh: Any, cell_size: float, subsamples: int) -> tuple[np.ndarray, np.ndarray]:
    """Return the share of each cell inside the mesh, counting subcells the surface passes through as half inside, and the grid origin."""
    pitch = cell_size / subsamples
    origin = mesh.bounds[0] - pitch / 2
    shape = np.ceil((mesh.bounds[1] - origin) / pitch).astype(np.int64) + 1
    shape += (-shape) % subsamples
    surface = np.zeros(tuple(shape), dtype=bool)
    _mark_surface(surface, mesh.triangles, origin, pitch)
    half_weights = ndimage.binary_fill_holes(surface).astype(np.uint8) * 2 - surface
    x, y, z = (size // subsamples for size in half_weights.shape)
    cells = half_weights.reshape(x, subsamples, y, subsamples, z, subsamples)
    return cells.sum(axis=(1, 3, 5), dtype=np.uint16) / np.float32(2 * subsamples**3), origin


def drop_islands(solid: np.ndarray) -> np.ndarray:
    labels, count = ndimage.label(solid, structure=np.ones((3, 3, 3), dtype=bool))
    if count <= 1:
        return solid
    sizes = np.bincount(labels.ravel())[1:]
    keep = np.flatnonzero(sizes >= sizes.sum() * MIN_ISLAND_SHARE) + 1
    return np.isin(labels, keep)
