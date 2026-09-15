from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

import cv2
import numpy as np

SPEC = importlib.util.spec_from_file_location(
    "media_video_loop", Path(__file__).with_name("media_video_loop.py")
)
LOOP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOOP)


class VideoLoopTests(unittest.TestCase):
    def setUp(self) -> None:
        noise = np.random.default_rng(723).integers(
            0, 256, (96, 128, 3), dtype=np.uint8
        )
        self.texture = cv2.GaussianBlur(noise, (5, 5), 0)

    def sequence(self, positions: list[int]) -> list[np.ndarray]:
        return [np.roll(self.texture, position, axis=1) for position in positions]

    def test_accepts_continuing_motion_with_different_endpoint_pixels(self) -> None:
        frames = self.sequence([4, 6, 0, 2])
        evidence = LOOP.boundary_evidence(frames)
        self.assertEqual(evidence["frameIndices"], [2, 3, 0, 1])
        self.assertGreater(evidence["transitionMae"][1], 0)
        self.assertTrue(evidence["motionMeasurable"])
        LOOP.require_boundary_continuity(evidence, "Test")

    def test_rejects_reversal_with_consistent_pixel_change(self) -> None:
        evidence = LOOP.boundary_evidence(self.sequence([4, 2, 0, 2]))
        self.assertLess(evidence["appearanceRatio"], LOOP.MAX_APPEARANCE_RATIO)
        with self.assertRaisesRegex(ValueError, "motion discontinuity"):
            LOOP.require_boundary_continuity(evidence, "Test")

    def test_rejects_boundary_hold(self) -> None:
        evidence = LOOP.boundary_evidence(self.sequence([2, 4, 0, 2]))
        with self.assertRaisesRegex(ValueError, "motion discontinuity"):
            LOOP.require_boundary_continuity(evidence, "Test")

    def test_accepts_slowing_into_a_smooth_turn(self) -> None:
        evidence = LOOP.boundary_evidence(self.sequence([5, 3, 0, 4]))
        self.assertLess(evidence["speedRatio"], LOOP.MIN_SPEED_RATIO)
        self.assertLess(evidence["neighborMotionAlignment"], LOOP.MAX_TURN_ALIGNMENT)
        LOOP.require_boundary_continuity(evidence, "Test")

    def test_rejects_a_slowdown_without_a_turn(self) -> None:
        evidence = LOOP.boundary_evidence(self.sequence([5, 9, 0, 4]))
        self.assertLess(evidence["speedRatio"], LOOP.MIN_SPEED_RATIO)
        self.assertGreater(evidence["neighborMotionAlignment"], 0.5)
        with self.assertRaisesRegex(ValueError, "motion discontinuity"):
            LOOP.require_boundary_continuity(evidence, "Test")

    def test_tolerates_single_tone_variation_but_not_a_flash(self) -> None:
        for middle, accepted in ((3, True), (5, False)):
            frames = [
                np.full((32, 32, 3), value, dtype=np.uint8)
                for value in (22 + middle, 24 + middle, 20, 22)
            ]
            evidence = LOOP.boundary_evidence(frames)
            if accepted:
                LOOP.require_boundary_continuity(evidence, "Test")
            else:
                with self.assertRaisesRegex(ValueError, "visual change"):
                    LOOP.require_boundary_continuity(evidence, "Test")

    def test_rejects_a_brightness_jump(self) -> None:
        frames = self.sequence([4, 6, 0, 2])
        frames[:2] = [
            np.clip(frame.astype(np.int16) + 60, 0, 255).astype(np.uint8)
            for frame in frames[:2]
        ]
        with self.assertRaisesRegex(ValueError, "visual change"):
            LOOP.require_boundary_continuity(LOOP.boundary_evidence(frames), "Test")

    def test_rejects_incomplete_boundary(self) -> None:
        with self.assertRaisesRegex(ValueError, "four frames"):
            LOOP.boundary_evidence(self.sequence([0, 1, 2]))

    def test_crossfade_preserves_forward_order_without_retiming_or_endpoint_holds(
        self,
    ) -> None:
        texture = np.tile(self.texture[:, :18], (1, 4, 1))
        frames = [np.roll(texture, index * 2, axis=1) for index in range(17)]
        output = LOOP.crossfade_frames(frames)
        self.assertEqual(len(output), 9)
        for index, frame in enumerate(output):
            np.testing.assert_array_equal(frame, frames[index + 8])
        inspections = LOOP.inspect_loop(output, 17, "crossfade", "Test")
        self.assertEqual(
            [entry["frameIndices"][2] for entry in inspections], list(range(9))
        )
        self.assertTrue(all(entry["motionMeasurable"] for entry in inspections))

    def test_crossfade_checks_the_interior_join_even_when_the_file_boundary_passes(
        self,
    ) -> None:
        texture = np.tile(self.texture[:, :18], (1, 4, 1))
        frames = [np.roll(texture, index * 2, axis=1) for index in range(17)]
        output = LOOP.crossfade_frames(frames)
        output[4] = np.full_like(output[4], 255)
        LOOP.require_boundary_continuity(LOOP.boundary_evidence(output), "Test")
        with self.assertRaisesRegex(ValueError, "visual change"):
            LOOP.inspect_loop(output, 17, "crossfade", "Test")

    def test_crossfade_ignores_hidden_rgb_when_blending_alpha(self) -> None:
        frames = [
            np.full((32, 32, 4), (80, 60, 40, 255), dtype=np.uint8) for _ in range(17)
        ]
        frames[1][...] = (255, 0, 255, 0)
        output = LOOP.crossfade_frames(frames)
        np.testing.assert_array_equal(output[2][..., :3], frames[14][..., :3])
        self.assertTrue(np.all((output[2][..., 3] > 0) & (output[2][..., 3] < 255)))

    def test_rejects_alpha_reset_even_with_identical_rgb(self) -> None:
        frames = [
            np.full((32, 32, 4), (127, 127, 127, alpha), dtype=np.uint8)
            for alpha in (255, 255, 0, 0)
        ]
        with self.assertRaisesRegex(ValueError, "visual change"):
            LOOP.require_boundary_continuity(LOOP.boundary_evidence(frames), "Test")

    def test_rejects_malformed_and_nonfinite_frames(self) -> None:
        for frames in (
            [np.zeros((32, 32, 3), dtype=np.uint8)] * 3,
            [np.full((32, 32, 3), np.nan)] * 17,
            [np.zeros((32, 32), dtype=np.uint8)] * 17,
            [np.zeros((32, 32, 3), dtype=np.uint8)] * 16
            + [np.zeros((16, 16, 3), dtype=np.uint8)],
        ):
            with self.subTest(count=len(frames)), self.assertRaises(ValueError):
                LOOP.crossfade_frames(frames)

    def test_overlap_size_is_bounded_for_every_supported_frame_contract(self) -> None:
        for count, expected in (
            (9, 4),
            (17, 8),
            (33, 16),
            (49, 24),
            (121, 24),
            (129, 24),
            (257, 24),
        ):
            self.assertEqual(LOOP.overlap_frame_count(count), expected)

    def test_ping_pong_allows_only_its_intended_turnarounds(self) -> None:
        frames = self.sequence([0, 2, 4, 6, 8, 10, 12, 14, 16])
        cycle = frames + frames[-2:0:-1]
        self.assertEqual(len(LOOP.inspect_loop(cycle, 9, "ping-pong", "Test")), 2)
        with self.assertRaisesRegex(ValueError, "motion discontinuity"):
            LOOP.inspect_loop(cycle, 17, "seamless", "Test")


if __name__ == "__main__":
    unittest.main()
