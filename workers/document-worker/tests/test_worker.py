import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook, load_workbook
from pypdf import PdfWriter

import sys
sys.path.insert(0, str(Path(__file__).parents[1]))
import worker


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="helm-worker-test-")
        self.old_root = os.environ.get("HELM_WORKSPACE_ROOT")
        os.environ["HELM_WORKSPACE_ROOT"] = self.temp.name

    def tearDown(self):
        if self.old_root is None:
            os.environ.pop("HELM_WORKSPACE_ROOT", None)
        else:
            os.environ["HELM_WORKSPACE_ROOT"] = self.old_root
        self.temp.cleanup()

    def test_health_reports_optional_render_and_ocr_dependencies(self):
        with patch.object(worker.shutil, "which", side_effect=lambda command: "/usr/bin/fake" if command == "soffice" else None):
            health = worker.handle({"id": "h", "operation": "health"})
        self.assertTrue(health["ok"])
        self.assertEqual(health["result"]["tools"]["officeRenderer"]["status"], "available")
        self.assertEqual(health["result"]["tools"]["pdftoppm"]["status"], "unavailable")
        self.assertEqual(health["result"]["checks"]["docxRendering"], "passed")
        self.assertEqual(health["result"]["checks"]["pdfOcr"], "unknown")

    def test_docx_artifact_and_inspect_are_bounded(self):
        created = worker.handle({"id": "d", "operation": "docx_create", "path": "report.docx", "paragraphs": ["Hello"], "runId": "run-1"})
        self.assertTrue(created["ok"])
        self.assertEqual(created["receipt"]["artifact"]["sourceRunId"], "run-1")
        self.assertEqual(created["receipt"]["checks"]["structure"], "passed")
        self.assertEqual(created["receipt"]["checks"]["content"], "passed")
        self.assertIn(created["receipt"]["checks"]["rendering"], {"passed", "unknown"})
        if created["receipt"]["checks"]["rendering"] == "passed":
            self.assertEqual(created["receipt"]["rendering"]["status"], "passed")
            self.assertGreaterEqual(created["receipt"]["rendering"]["pdfPages"], 1)
        else:
            self.assertIn(created["receipt"]["rendering"]["status"], {"unavailable", "failed"})
        self.assertTrue(zipfile.is_zipfile(Path(self.temp.name) / "report.docx"))
        inspected = worker.handle({"id": "i", "operation": "inspect", "path": "report.docx"})
        self.assertEqual(inspected["result"]["path"], "report.docx")

    def test_docx_rendering_is_unknown_when_renderer_is_unavailable(self):
        with patch.object(worker.shutil, "which", return_value=None):
            created = worker.handle({"id": "d", "operation": "docx_create", "path": "report.docx", "paragraphs": ["Hello"]})
        self.assertTrue(created["ok"])
        self.assertEqual(created["receipt"]["checks"]["rendering"], "unknown")
        self.assertEqual(created["receipt"]["rendering"]["status"], "unavailable")
        self.assertIn("renderer", created["receipt"]["artifact"]["limitations"][0])

    def test_xlsx_range_write_and_read(self):
        path = Path(self.temp.name) / "book.xlsx"
        workbook = Workbook()
        workbook.active.title = "Data"
        workbook.save(path)
        written = worker.handle({"id": "w", "operation": "xlsx_write_range", "path": "book.xlsx", "sheet": "Data", "cell": "B2", "value": "ok"})
        self.assertTrue(written["ok"])
        self.assertEqual(written["result"]["checks"], {"target": "passed", "scope": "passed"})
        self.assertEqual(written["receipt"]["target"]["cells"], ["B2"])
        read = worker.handle({"id": "r", "operation": "xlsx_read_range", "path": "book.xlsx", "sheet": "Data", "cell": "B2"})
        self.assertEqual(read["result"]["value"], "ok")
        self.assertEqual(read["receipt"]["checks"]["target"], "passed")
        self.assertEqual(load_workbook(path, data_only=True)["Data"]["B2"].value, "ok")

    def test_path_escape_and_unknown_pdf_text_are_explicit(self):
        escaped = worker.handle({"id": "x", "operation": "inspect", "path": "../secret.txt"})
        self.assertFalse(escaped["ok"])
        self.assertEqual(escaped["error"], "path_outside_workspace")
        pdf = Path(self.temp.name) / "blank.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        with pdf.open("wb") as stream:
            writer.write(stream)
        result = worker.handle({"id": "p", "operation": "pdf_extract", "path": "blank.pdf"})
        self.assertFalse(result["ok"])
        self.assertIn(result["error"], {"unknown_text_layer", "ocr_unavailable"})
        self.assertEqual(result["receipt"]["checks"]["coverage"], "unknown")
        self.assertIn(result["receipt"]["ocr"]["status"], {"unavailable", "unknown"})
        self.assertIn("limitations", result["receipt"]["ocr"])
        self.assertEqual(result["result"]["pages"][0]["source"]["page"], 1)
        self.assertEqual(result["receipt"]["artifact"]["path"], "blank.pdf")

    def test_pdf_ocr_failure_keeps_page_unknown_with_limitation(self):
        pdf = Path(self.temp.name) / "scanned.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        with pdf.open("wb") as stream:
            writer.write(stream)
        with patch.object(worker.shutil, "which", side_effect=lambda command: "/usr/bin/fake" if command in {"pdftoppm", "tesseract"} else None), patch.object(worker.subprocess, "run", side_effect=OSError("unavailable")):
            result = worker.handle({"id": "p", "operation": "pdf_extract", "path": "scanned.pdf"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "ocr_unavailable")
        self.assertEqual(result["receipt"]["ocr"]["status"], "unknown")
        self.assertEqual(result["receipt"]["checks"]["coverage"], "unknown")
        self.assertEqual(result["result"]["pages"][0]["extraction"], "unknown")
        self.assertTrue(result["receipt"]["artifact"]["limitations"])

    def test_pdf_ocr_records_page_source_and_confidence_when_tools_pass(self):
        pdf = Path(self.temp.name) / "scanned.pdf"
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        with pdf.open("wb") as stream:
            writer.write(stream)

        def fake_run(command, **kwargs):
            if command[0] == "/usr/bin/pdftoppm":
                Path(f"{command[-1]}.png").write_bytes(b"fake-png")
                return subprocess.CompletedProcess(command, 0, "", "")
            return subprocess.CompletedProcess(command, 0, "level\tpage\tblock\tpar\tline\tword\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t96.0\tScanned", "")

        def fake_which(command):
            return {"pdftoppm": "/usr/bin/pdftoppm", "tesseract": "/usr/bin/tesseract"}.get(command)

        with patch.object(worker.shutil, "which", side_effect=fake_which), patch.object(worker.subprocess, "run", side_effect=fake_run):
            result = worker.handle({"id": "p", "operation": "pdf_extract", "path": "scanned.pdf"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["receipt"]["ocr"]["status"], "passed")
        self.assertEqual(result["receipt"]["ocr"]["engine"], "tesseract")
        self.assertEqual(result["receipt"]["ocr"]["limitations"], [])
        self.assertEqual(result["result"]["pages"][0]["extraction"], "ocr")
        self.assertEqual(result["result"]["pages"][0]["source"]["extraction"], "ocr")
        self.assertAlmostEqual(result["result"]["pages"][0]["confidence"], 0.96)

    def test_pdf_page_bound_cannot_be_reported_as_complete_coverage(self):
        pdf = Path(self.temp.name) / "large.pdf"
        writer = PdfWriter()
        for _ in range(worker.MAX_PDF_PAGES + 1):
            writer.add_blank_page(width=100, height=100)
        with pdf.open("wb") as stream:
            writer.write(stream)
        result = worker.handle({"id": "p", "operation": "pdf_extract", "path": "large.pdf"})
        self.assertFalse(result["ok"])
        self.assertEqual(result["receipt"]["checks"]["coverage"], "unknown")
        self.assertEqual(result["receipt"]["target"]["totalPages"], worker.MAX_PDF_PAGES + 1)
        self.assertFalse(result["receipt"]["target"]["bounded"])
        self.assertTrue(any("bounded" in item for item in result["receipt"]["artifact"]["limitations"]))


if __name__ == "__main__":
    unittest.main()
