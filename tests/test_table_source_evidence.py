from __future__ import annotations

import json
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_PATH = REPO_ROOT / "tests" / "fixtures" / "table_source_limited" / "source_evidence_2026-06-11.json"
CAPABILITIES_PATH = REPO_ROOT / "tasks" / "miro_capabilities.md"
RUNBOOK_PATH = REPO_ROOT / "tasks" / "miro_source_expansion_runbook.md"


class TableSourceEvidenceTests(unittest.TestCase):
    def test_table_cell_text_is_documented_as_source_unavailable(self) -> None:
        evidence = json.loads(EVIDENCE_PATH.read_text(encoding="utf-8"))
        rest = evidence["source_surfaces"]["rest_table_probe"]
        websdk = evidence["source_surfaces"]["web_sdk_deep_diagnostics"]

        self.assertEqual(evidence["verified_at"], "2026-06-11")
        self.assertEqual(evidence["board_id"], "uXjVSourceProbe=")
        self.assertEqual(evidence["table_id"], "<redacted-long-id>")
        self.assertEqual(rest["summary"]["contentful_table_items"], 0)
        self.assertEqual(rest["decision"], "table_geometry_without_content_and_blocked_candidate")
        self.assertIn("experimental_table_detail_<redacted-long-id>", rest["summary"]["auth_blocked_paths"])
        self.assertEqual(websdk["exporter_version"], "20260611-deep-table")
        self.assertEqual(websdk["prototype_names"][:3], ["Unsupported", "Unsupported", "BaseItem"])
        self.assertEqual(websdk["textish_values"], [])
        self.assertIn("cells", websdk["known_field_reads_without_values"])
        self.assertEqual(evidence["decision"], "table_cell_text_source_unavailable")

    def test_capability_docs_reference_the_table_source_evidence(self) -> None:
        capabilities = CAPABILITIES_PATH.read_text(encoding="utf-8")
        runbook = RUNBOOK_PATH.read_text(encoding="utf-8")

        for text in (capabilities, runbook):
            self.assertIn("2026-06-11", text)
            self.assertIn("<redacted-long-id>", text)
            self.assertIn("20260611-deep-table", text)
            self.assertIn("source_evidence_2026-06-11.json", text)

        self.assertIn("Unsupported -> Unsupported -> BaseItem -> Object", capabilities)
        self.assertIn("table cell text is not exposed", runbook)


if __name__ == "__main__":
    unittest.main()
