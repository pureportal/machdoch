from __future__ import annotations

import math
import unittest

import numpy as np
import trimesh

from media_mesh_voxelize import voxelize


class MeshVoxelizeTests(unittest.TestCase):
    def test_box_becomes_one_quad_per_side_with_outward_faces(self) -> None:
        box = trimesh.creation.box(extents=(2.0, 1.0, 1.0)).subdivide().subdivide()

        blocks = voxelize(box, 16, 0.5, True)

        self.assertEqual(len(blocks.faces), 12)
        self.assertTrue(np.allclose(blocks.extents, (2.0, 1.0, 1.0)))
        merged = blocks.copy()
        merged.merge_vertices()
        self.assertTrue(merged.is_watertight)
        self.assertAlmostEqual(merged.volume, 2.0, places=6)

    def test_tilted_box_is_straightened_onto_the_grid(self) -> None:
        box = trimesh.creation.box(extents=(1.0, 2.0, 1.0)).subdivide().subdivide()
        box.apply_transform(trimesh.transformations.rotation_matrix(math.radians(3), (1, 0, 0)))

        blocks = voxelize(box, 32, 0.5, True)

        self.assertEqual(len(blocks.faces), 12)

    def test_sphere_keeps_its_volume_and_drops_floaters(self) -> None:
        sphere = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        floater = trimesh.creation.icosphere(subdivisions=2, radius=0.05)
        floater.apply_translation((2.5, 0, 0))
        source = trimesh.util.concatenate([sphere, floater])

        blocks = voxelize(source, 48, 0.5, True)
        merged = blocks.copy()
        merged.merge_vertices()

        self.assertLess(blocks.bounds[1][0], 1.2)
        self.assertAlmostEqual(merged.volume / sphere.volume, 1.0, delta=0.03)

    def test_rejects_a_fill_that_removes_everything(self) -> None:
        sheet = trimesh.creation.box(extents=(1.0, 1.0, 0.001))

        with self.assertRaisesRegex(ValueError, "removed the whole object"):
            voxelize(sheet, 8, 0.9, True)


if __name__ == "__main__":
    unittest.main()
