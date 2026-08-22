from __future__ import annotations

import json
import hashlib
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np

import build_source_anchored_loop as builder


class SourceAnchoredLoopTests(unittest.TestCase):
    def test_curves_share_the_half_open_cycle_endpoint(self) -> None:
        curves = [
            {"kind": "sine", "amplitude": 4.0},
            {"kind": "raised-cosine", "peak": -3.0},
            {
                "kind": "keyframes",
                "points": [[0.0, 0.0], [0.35, 7.0], [1.0, 0.0]],
            },
        ]
        for index, curve in enumerate(curves):
            self.assertAlmostEqual(
                builder._curve_value(curve, 0.0, f"curve[{index}]"),
                builder._curve_value(curve, 1.0, f"curve[{index}]"),
                places=10,
            )

    def test_builder_preserves_pixels_outside_declared_motion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            height = width = 128
            y, x = np.indices((height, width))
            source = np.empty((height, width, 3), dtype=np.uint8)
            source[..., 0] = (x * 3 + y) % 256
            source[..., 1] = (x + y * 2) % 256
            source[..., 2] = (x * 2 + y * 3) % 256
            cv2.rectangle(source, (21, 56), (62, 88), (25, 180, 240), -1)
            cv2.circle(source, (82, 44), 22, (80, 210, 250), -1)
            cv2.circle(source, (75, 42), 3, (20, 20, 20), -1)
            cv2.circle(source, (89, 42), 3, (20, 20, 20), -1)

            wing_mask = np.zeros((height, width), dtype=np.uint8)
            cv2.rectangle(wing_mask, (21, 56), (62, 88), 255, -1)
            head_mask = np.zeros((height, width), dtype=np.uint8)
            cv2.circle(head_mask, (82, 44), 22, 255, -1)
            underlay = source.copy()
            underlay[wing_mask > 0] = (55, 65, 75)
            underlay[head_mask > 0] = (70, 80, 90)
            half = source.copy()
            closed = source.copy()
            cv2.line(half, (70, 42), (79, 43), (20, 20, 20), 2)
            cv2.line(half, (85, 43), (94, 42), (20, 20, 20), 2)
            cv2.line(closed, (69, 43), (80, 45), (20, 20, 20), 3)
            cv2.line(closed, (84, 45), (95, 43), (20, 20, 20), 3)

            for name, image in (
                ("source.png", source),
                ("underlay.png", underlay),
                ("half.png", half),
                ("closed.png", closed),
                ("wing-mask.png", wing_mask),
                ("head-mask.png", head_mask),
            ):
                self.assertTrue(cv2.imwrite(str(root / name), image))

            manifest = {
                "schemaVersion": 1,
                "source": "source.png",
                "frameCount": 8,
                "fps": 8,
                "cleanPlatePasses": [
                    {
                        "underlay": "underlay.png",
                        "masks": ["wing-mask.png", "head-mask.png"],
                        "dilationSize": 3,
                        "featherSigma": 0.5,
                    }
                ],
                "blink": {
                    "half": "half.png",
                    "closed": "closed.png",
                    "maskEllipses": [
                        {"center": [75, 42], "axes": [7, 6]},
                        {"center": [89, 42], "axes": [7, 6]},
                    ],
                    "featherSigma": 1.0,
                    "amountByFrame": {"2": 0.5, "3": 1.0, "4": 0.4},
                },
                "layers": [
                    {
                        "name": "wing",
                        "mask": "wing-mask.png",
                        "pivot": [58, 72],
                        "maskDilationSize": 3,
                        "maskFeatherSigma": 0.5,
                        "motion": {
                            "rotationDegrees": {
                                "kind": "raised-cosine",
                                "peak": -9.0,
                            },
                            "x": {"kind": "sine", "amplitude": 2.0},
                            "y": 0.0,
                        },
                        "deformation": {
                            "type": "wind-fabric",
                            "anchor": [21, 72],
                            "tip": [62, 72],
                            "attachmentFraction": 0.05,
                            "falloffPower": 1.2,
                            "foldShadeStrength": 0.12,
                            "waves": [
                                {
                                    "normalAmplitude": 5,
                                    "tangentAmplitude": 2,
                                    "spatialCycles": 1.2,
                                    "temporalCycles": 1,
                                },
                                {
                                    "normalAmplitude": 2,
                                    "spatialCycles": 2.4,
                                    "temporalCycles": 2,
                                    "phaseOffset": 0.3,
                                },
                            ],
                        },
                    },
                    {
                        "name": "head",
                        "mask": "head-mask.png",
                        "pivot": [82, 55],
                        "appearance": "blink",
                        "maskDilationSize": 3,
                        "maskFeatherSigma": 0.5,
                        "motion": {
                            "rotationDegrees": {
                                "kind": "sine",
                                "amplitude": 1.0,
                            },
                            "x": 0.0,
                            "y": {"kind": "raised-cosine", "peak": 2.0},
                        },
                    },
                ],
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            output = root / "output"
            result = builder.build(manifest_path, output)

            self.assertEqual(result["frameCount"], 8)
            paths = sorted((output / "frames").glob("frame-*.png"))
            self.assertEqual(len(paths), 8)
            frames = [cv2.imread(str(path)) for path in paths]
            protected = cv2.dilate(
                cv2.max(wing_mask, head_mask),
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)),
            ) == 0
            for frame in frames:
                np.testing.assert_array_equal(frame[protected], source[protected])
            self.assertFalse(np.array_equal(frames[0], frames[-1]))
            motion = json.loads((output / "motion.json").read_text(encoding="utf-8"))
            self.assertTrue(motion["closedIntervalTerminalFrameOmitted"])
            self.assertEqual(motion["playbackDirection"], "forward")
            self.assertIn(
                "deformation", motion["motion"][0]["layers"]["wing"]
            )

    def test_fancy_effects_and_generated_plates_are_bounded_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            height, width = 72, 96
            y, x = np.indices((height, width))
            source = np.empty((height, width, 3), dtype=np.uint8)
            source[..., 0] = (x * 2 + y) % 256
            source[..., 1] = (x + y * 3) % 256
            source[..., 2] = (x * 3 + y * 2) % 256
            cv2.rectangle(source, (22, 28), (43, 50), (35, 180, 245), -1)

            subject_mask = np.zeros((height, width), dtype=np.uint8)
            cv2.rectangle(subject_mask, (22, 28), (43, 50), 255, -1)
            effect_mask = np.zeros((height, width), dtype=np.uint8)
            cv2.ellipse(effect_mask, (70, 27), (12, 9), 0, 0, 360, 255, -1)
            occlusion_mask = np.zeros((height, width), dtype=np.uint8)
            cv2.rectangle(occlusion_mask, (67, 24), (73, 31), 255, -1)

            for name, image in (
                ("source.png", source),
                ("subject-mask.png", subject_mask),
                ("effect-mask.png", effect_mask),
                ("occlusion-mask.png", occlusion_mask),
            ):
                self.assertTrue(cv2.imwrite(str(root / name), image))

            manifest = {
                "schemaVersion": 1,
                "source": "source.png",
                "frameCount": 12,
                "fps": 12,
                "cleanPlatePasses": [
                    {
                        "mode": "inpaint",
                        "masks": ["subject-mask.png"],
                        "dilationSize": 3,
                        "inpaintRadius": 3,
                        "inpaintScale": 0.5,
                        "featherSigma": 0.5,
                    },
                    {
                        "mode": "shadow-blur",
                        "masks": ["subject-mask.png"],
                        "dilationSize": 3,
                        "blurSigma": 3,
                        "brightness": 0.7,
                        "featherSigma": 0.5,
                    },
                ],
                "blink": {
                    "mode": "procedural",
                    "maskEllipses": [
                        {
                            "center": [33, 35],
                            "axes": [5, 3],
                            "lashPoints": [[28, 35], [33, 37], [38, 35]],
                        },
                    ],
                    "featherSigma": 0.5,
                    "amountByFrame": {},
                },
                "layers": [
                    {
                        "name": "subject",
                        "mask": "subject-mask.png",
                        "pivot": [33, 39],
                        "maskDilationSize": 3,
                        "maskFeatherSigma": 0.4,
                        "motion": {
                            "rotationDegrees": {"kind": "sine", "amplitude": 3},
                            "x": {"kind": "sine", "amplitude": 2},
                            "y": 0,
                        },
                    },
                ],
                "effects": [
                    {
                        "name": "masked-light",
                        "type": "masked-glow",
                        "stage": "before-layers",
                        "mask": "effect-mask.png",
                        "maskFeatherSigma": 0.5,
                        "colorRgb": [255, 190, 80],
                        "glowSigma": 2,
                        "opacity": {
                            "kind": "keyframes",
                            "points": [[0, 0.1], [0.5, 0.7], [1, 0.1]],
                        },
                    },
                    {
                        "name": "moving-halo",
                        "type": "radial-glow",
                        "mask": "effect-mask.png",
                        "occlusionMask": "occlusion-mask.png",
                        "colorRgb": [80, 170, 255],
                        "x": {"kind": "sine", "offset": 70, "amplitude": 3},
                        "y": 27,
                        "radiusX": 13,
                        "radiusY": 10,
                        "opacity": 0.35,
                    },
                    {
                        "name": "orbiting-motes",
                        "type": "orbit-particles",
                        "mask": "effect-mask.png",
                        "occlusionMask": "occlusion-mask.png",
                        "colorRgb": [125, 205, 255],
                        "region": [62, 20, 78, 34],
                        "count": 6,
                        "seed": 143,
                        "amplitudeX": 4,
                        "amplitudeY": 3,
                        "radiusMin": 1,
                        "radiusMax": 2,
                        "cycles": 1,
                        "twinkleCycles": 2,
                        "glowSigma": 1,
                        "opacity": 0.8,
                    },
                    {
                        "name": "wind-streaks",
                        "type": "wind-streaks",
                        "mask": "effect-mask.png",
                        "occlusionMask": "occlusion-mask.png",
                        "colorRgb": [150, 215, 255],
                        "region": [55, 12, 88, 42],
                        "direction": [1, 0.2],
                        "count": 8,
                        "seed": 144,
                        "speedCycles": 1,
                        "driftCycles": 2,
                        "driftAmplitude": 2,
                        "lengthMin": 4,
                        "lengthMax": 9,
                        "thicknessMin": 1,
                        "thicknessMax": 2,
                        "edgeFadeFraction": 0.18,
                        "glowSigma": 0.5,
                        "opacity": 0.7,
                    },
                ],
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            first_output = root / "first"
            second_output = root / "second"
            first_result = builder.build(manifest_path, first_output)
            second_result = builder.build(manifest_path, second_output)
            self.assertEqual(first_result["frameCount"], 12)
            first_paths = sorted((first_output / "frames").glob("frame-*.png"))
            second_paths = sorted((second_output / "frames").glob("frame-*.png"))
            self.assertEqual(len(first_paths), 12)
            self.assertEqual(
                [hashlib.sha256(path.read_bytes()).hexdigest() for path in first_paths],
                [hashlib.sha256(path.read_bytes()).hexdigest() for path in second_paths],
            )

            protected = cv2.dilate(
                cv2.max(subject_mask, effect_mask),
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)),
            ) == 0
            frames = [cv2.imread(str(path)) for path in first_paths]
            for frame in frames:
                np.testing.assert_array_equal(frame[protected], source[protected])
            self.assertFalse(np.array_equal(frames[0], frames[6]))

            motion = json.loads(
                (first_output / "motion.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                set(motion["motion"][0]["effects"]),
                {
                    "masked-light",
                    "moving-halo",
                    "orbiting-motes",
                    "wind-streaks",
                },
            )
            self.assertTrue(
                (first_output / "diagnostics" / "clean-plate.png").is_file()
            )
            self.assertTrue(
                (first_output / "diagnostics" / "effect-orbiting-motes-mask.png").is_file()
            )


if __name__ == "__main__":
    unittest.main()
