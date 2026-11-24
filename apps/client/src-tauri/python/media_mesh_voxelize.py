"""Convert a mesh into a solid block model and rebuild it with greedy meshing, so every flat block face becomes one quad."""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import ndimage
import trimesh

from media_mesh_grid import cell_occupancy, drop_islands

MAX_FINE_CELLS = 384
MIN_SUBSAMPLES = 2
MAX_SUBSAMPLES = 4
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
    occupancy, origin = cell_occupancy(mesh, block_size, subsamples)
    blocks = occupancy >= fill
    if remove_islands:
        blocks = drop_islands(blocks)
    blocks = ndimage.binary_fill_holes(blocks)
    if not blocks.any():
        raise ValueError("Voxelizing removed the whole object. Raise the voxel resolution or lower the fill.")
    corners = _greedy_quads(blocks)
    vertices = origin + corners * block_size
    quads = np.arange(len(vertices), dtype=np.int64).reshape(-1, 4)
    faces = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
