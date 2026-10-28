import json
import unittest
from pathlib import Path
from scripts.fit_edge import run_edge_evaluation

class TestFitEdge(unittest.TestCase):
    def test_fit_edge_generates_report(self):
        rep = run_edge_evaluation()
        self.assertIn("trigger_eval", rep)
        self.assertIn("ci_95", rep["trigger_eval"])
        self.assertTrue(rep["trigger_eval"]["ci_includes_zero"])
        self.assertTrue(rep["action_required"]["state_no_edge_on_performance"])
        self.assertTrue(rep["action_required"]["freeze_paid_features"])
        self.assertTrue(rep["action_required"]["suspend_beat_close_guarantee"])

if __name__ == "__main__":
    unittest.main()
