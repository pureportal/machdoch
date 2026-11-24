"""Convert a mesh into a solid block model and rebuild it with greedy meshing, so every flat block face becomes one quad."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import ndimage
import trimesh

MAX_FINE_CELLS = 384
MIN_SUBSAMPLES = 2
MAX_SUBSAMPLES = 4
MIN_ISLAND_SHARE = 0.01
SAMPLE_BATCH = 2_000_000
STRAIGHTEN_CONE = math.cos(math.radians(20))
STRAIGHTEN_ITERATIONS = 4


def _straightening_rotation(mesh: Any) -> np.ndarray:
    """Rotate faces that nearly face an axis onto it, so slightly tilted flat sides land in one block layer."""
    rotation = np.eye(3)
    normals, areas = mesh.face_normals, mesh.area_faces
    rows = np.arange(len(normals))
    for _ in range(STRAIGHTEN_ITERATIONS):
        rotated = normals @ rotation.T
        dominant = np.abs(rotated).argmax(axis=1)
        targets = np.zeros_like(rotated)
        targets[rows, dominant] = np.sign(rotated[rows, dominant])
        near = (rotated * targets).sum(axis=1) > STRAIGHTEN_CONE
        if not near.any():
            break
        left, _, right = np.linalg.svd((targets[near] * areas[near, None]).T @ rotated[near])
        rotation = left @ np.diag([1.0, 1.0, np.linalg.det(left @ right)]) @ right @ rotation
    return rotation


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


def _half_weighted_grid(mesh: Any, block_size: float, subsamples: int) -> tuple[np.ndarray, np.ndarray]:
    pitch = block_size / subsamples
    origin = mesh.bounds[0] - pitch / 2
    shape = np.ceil((mesh.bounds[1] - origin) / pitch).astype(np.int64) + 1
    shape += (-shape) % subsamples
    surface = np.zeros(tuple(shape), dtype=bool)
    _mark_surface(surface, mesh.triangles, origin, pitch)
    half_weights = ndimage.binary_fill_holes(surface).astype(np.uint8) * 2 - surface
    return half_weights, origin


def _blocks(half_weights: np.ndarray, subsamples: int, fill: float) -> np.ndarray:
    x, y, z = (size // subsamples for size in half_weights.shape)
    cells = half_weights.reshape(x, subsamples, y, subsamples, z, subsamples)
    occupancy = cells.sum(axis=(1, 3, 5), dtype=np.uint16) / (2 * subsamples**3)
    return occupancy >= fill


def _drop_islands(blocks: np.ndarray) -> np.ndarray:
    labels, count = ndimage.label(blocks, structure=np.ones((3, 3, 3), dtype=bool))
    if count <= 1:
        return blocks
    sizes = np.bincount(labels.ravel())[1:]
    keep = np.flatnonzero(sizes >= sizes.sum() * MIN_ISLAND_SHARE) + 1
    return np.isin(labels, keep)


def _rectangles(mask: np.ndarray) -> list[tuple[int, int, int, int]]:
    rectangles = []
    rows, columns = mask.shape
    for row in np.flatnonzero(mask.any(axis=1)):
        column = 0
        while True:
            remaining = np.flatnonzero(mask[row, column:])
            if remaining.size == 0:
                break
            column += int(remaining[0])
            width = int(np.argmin(np.append(mask[row, column:], False)))
            height = 1
            while row + height < rows and mask[row + height, column:column + width].all():
                height += 1
            mask[row:row + height, column:column + width] = False
            rectangles.append((int(row), column, height, width))
            column += width
    return rectangles


def _greedy_quads(blocks: np.ndarray) -> np.ndarray:
    padded = np.pad(blocks, 1)
    corners = []
    for axis in range(3):
        u_axis, v_axis = (other for other in range(3) if other != axis)
        right_handed = axis != 1
        for direction in (-1, 1):
            exposed = (padded & ~np.roll(padded, -direction, axis=axis))[1:-1, 1:-1, 1:-1]
            exposed = np.moveaxis(exposed, (axis, u_axis, v_axis), (0, 1, 2))
            outward = right_handed == (direction > 0)
            for layer in np.flatnonzero(exposed.any(axis=(1, 2))):
                depth = layer + (1 if direction > 0 else 0)
                for u, v, height, width in _rectangles(exposed[layer].copy()):
                    quad = [(u, v), (u + height, v), (u + height, v + width), (u, v + width)]
                    if not outward:
                        quad.reverse()
                    for corner_u, corner_v in quad:
                        point = [0, 0, 0]
                        point[axis], point[u_axis], point[v_axis] = depth, corner_u, corner_v
                        corners.append(point)
    return np.asarray(corners, dtype=np.float64).reshape(-1, 3)


def voxelize(mesh: Any, resolution: int, fill: float, remove_islands: bool) -> Any:
    """Return the block mesh; resolution is the number of blocks along the longest side."""
    mesh = mesh.copy()
    mesh.vertices = mesh.vertices @ _straightening_rotation(mesh).T
    block_size = float(mesh.extents.max()) / resolution
    subsamples = max(MIN_SUBSAMPLES, min(MAX_SUBSAMPLES, MAX_FINE_CELLS // resolution))
    half_weights, origin = _half_weighted_grid(mesh, block_size, subsamples)
    blocks = _blocks(half_weights, subsamples, fill)
    if remove_islands:
        blocks = _drop_islands(blocks)
    blocks = ndimage.binary_fill_holes(blocks)
    if not blocks.any():
        raise ValueError("Voxelizing removed the whole object. Raise the voxel resolution or lower the fill.")
    corners = _greedy_quads(blocks)
    vertices = origin + corners * block_size
    quads = np.arange(len(vertices), dtype=np.int64).reshape(-1, 4)
    faces = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
