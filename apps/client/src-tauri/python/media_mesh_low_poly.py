"""Turn a mesh into a faceted low-poly model.

The surface is rebuilt as one closed manifold, collapsed in stages with quadric error simplification, and every face gets its
own vertices so facets render flat in any viewer or engine.
"""

from __future__ import annotations

from typing import Any

import fast_simplification
import numpy as np
from scipy import ndimage
from skimage import measure
import trimesh

from media_mesh_grid import cell_occupancy, drop_islands

REMESH_RESOLUTION = 256
REMESH_SUBSAMPLES = 2
REMESH_SMOOTHING = 1.0
GRID_PADDING = 2
INTERMEDIATE_FACE_FACTOR = 4


def _closed_surface(mesh: Any, remove_islands: bool) -> Any:
    cell_size = float(mesh.extents.max()) / REMESH_RESOLUTION
    occupancy, origin = cell_occupancy(mesh, cell_size, REMESH_SUBSAMPLES)
    solid = occupancy >= 0.5
    filled = ndimage.binary_fill_holes(solid)
    field = np.where(filled & ~solid, np.float32(1), occupancy)
    if remove_islands:
        field = field * drop_islands(filled)
    if not (field >= 0.5).any():
        raise ValueError("Low poly needs a closed, solid object. Use clearer views and generate again.")
    field = ndimage.gaussian_filter(np.pad(field, GRID_PADDING), REMESH_SMOOTHING)
    vertices, faces, _, _ = measure.marching_cubes(field, 0.5)
    vertices = origin + (vertices - GRID_PADDING + 0.5) * cell_size
    return trimesh.Trimesh(vertices=vertices, faces=faces[:, ::-1], process=False)


def low_poly(mesh: Any, face_count: int, remove_islands: bool) -> Any:
    """Return a flat-shaded mesh with at most face_count triangles."""
    surface = _closed_surface(mesh, remove_islands)
    vertices, faces = surface.vertices, surface.faces
    for target in (face_count * INTERMEDIATE_FACE_FACTOR, face_count, face_count):
        if len(faces) > target:
            vertices, faces = fast_simplification.simplify(vertices, faces, target_count=target)
    result = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    result.update_faces(result.nondegenerate_faces())
    result.unmerge_vertices()
    return result
