"""The outer edges of the hips (pose.edges_in_mask / with_hip_edges, the lead hip line): found where
the person outline ends beside each hip, not fooled by a gap in the band, saved per frame.

  cd server && python -m unittest tests.test_hipedges
"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import pose  # noqa: E402


def body(w=200, h=400, left=60, right=140):
    """A person mask: a block from x = left to right - 1 (the hips), over the whole height."""
    m = np.zeros((h, w), np.float32)
    m[:, left:right] = 1.0
    return m


class HipEdges(unittest.TestCase):
    def test_edges_where_the_outline_ends(self):
        left, right = pose.edges_in_mask(body(), (0.4, 0.5), (0.6, 0.5))
        self.assertAlmostEqual(left, 59 / 200, places=3)     # the first column outside, each way
        self.assertAlmostEqual(right, 140 / 200, places=3)

    def test_a_hand_across_part_of_the_band_is_dropped(self):
        m = body()
        m[200:203, 140:190] = 1.0     # hands beside the lead hip on a few rows: the median holds
        _, right = pose.edges_in_mask(m, (0.4, 0.5), (0.6, 0.5))
        self.assertAlmostEqual(right, 140 / 200, places=3)
        m[196:214:2, 140:190] = 1.0   # every other row across the band: the rows disagree, no edge
        _, right = pose.edges_in_mask(m, (0.4, 0.5), (0.6, 0.5))
        self.assertIsNone(right)

    def test_joint_outside_the_outline(self):
        self.assertEqual(pose.edges_in_mask(body(), (0.1, 0.5), (0.9, 0.5)), (None, None))

    def test_saved_per_frame_and_stamped_near_the_start(self):
        doc = {"version": 6, "pass": "deep", "model": "rtmpose-m-256x192", "ballVersion": 4, "clubOnset": 0.8,
               "rotation": 90, "frames": [{"t": 0.0}, {"t": 0.1, "hip": [0.1, 0.2]}, {"t": 0.2}]}
        got = pose.with_hip_edges(doc, {0: [0.3, 0.6], 2: [None, 0.7]})
        self.assertEqual(list(got)[:5], ["version", "pass", "model", "ballVersion", "hipEdge"])
        self.assertEqual(got["hipEdge"], pose.HIP_EDGE_VERSION)
        self.assertEqual([f.get("hip") for f in got["frames"]], [[0.3, 0.6], None, [None, 0.7]])
        self.assertNotIn("hip", doc["frames"][0])      # the input is left as it was
        self.assertEqual(list(pose.with_hip_edges(got, {})), list(got))


if __name__ == "__main__":
    unittest.main()
