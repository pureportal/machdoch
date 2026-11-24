from __future__ import annotations

import unittest

import numpy as np
import trimesh

from media_mesh_low_poly import low_poly


class MeshLowPolyTests(unittest.TestCase):
    def test_sphere_becomes_a_closed_faceted_shape_within_the_budget(self) -> None:
        sphere = trimesh.creation.icosphere(subdivisions=5, radius=1.0)

        result = low_poly(sphere, 300, True)

        self.assertLessEqual(len(result.faces), 300)
        self.assertEqual(len(result.vertices), 3 * len(result.faces))
        self.assertTrue(np.allclose(result.vertex_normals, np.repeat(result.face_normals, 3, axis=0), atol=1e-6))
        merged = result.copy()
        merged.merge_vertices()
        self.assertTrue(merged.is_watertight)
        self.assertGreater(merged.volume, 0)
        self.assertAlmostEqual(merged.volume / sphere.volume, 1.0, delta=0.05)

    def test_drops_floaters(self) -> None:
        sphere = trimesh.creation.icosphere(subdivisions=4, radius=1.0)
        floater = trimesh.creation.icosphere(subdivisions=2, radius=0.05)
        floater.apply_translation((2.5, 0, 0))

        result = low_poly(trimesh.util.concatenate([sphere, floater]), 400, True)

        self.assertLess(result.bounds[1][0], 1.2)

    def test_rejects_shapes_without_volume(self) -> None:
        sheet = trimesh.creation.box(extents=(1.0, 1.0, 0.0001))

        with self.assertRaisesRegex(ValueError, "closed, solid object"):
            low_poly(sheet, 200, True)


if __name__ == "__main__":
    unittest.main()
