from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings

from radar.hdf5 import parse_radar_forecast_hdf5, pixel_to_mm_hr
from radar.knmi import (
    KnmiApiError,
    KnmiFileInfo,
    KnmiOpenDataClient,
    parse_filename_issued_at,
)
from radar.models import RadarForecast, RadarForecastStep
from radar.tests.fixtures import create_sample_radar_forecast_h5


class KnmiClientTests(SimpleTestCase):
    def setUp(self):
        import tempfile

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)

    def test_parse_filename_issued_at(self):
        issued_at = parse_filename_issued_at("RAD_NL25_RAC_FM_202608301445.h5")
        self.assertEqual(
            issued_at,
            datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
        )

    @patch("radar.knmi.time.sleep")
    @patch("radar.knmi.requests.Session")
    def test_list_files_raises_on_api_error(self, session_cls, sleep):
        session = session_cls.return_value
        response = MagicMock()
        response.status_code = 200
        response.raise_for_status.return_value = None
        response.json.return_value = {"error": "Rate Limit Exceeded"}
        response.headers = {}
        session.get.return_value = response

        client = KnmiOpenDataClient("token", "radar_forecast", "2.0", max_retries=2)
        with self.assertRaises(KnmiApiError):
            client.list_files()

        self.assertEqual(session.get.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    @patch("radar.knmi.time.sleep")
    @patch("radar.knmi.requests.Session")
    def test_list_files_retries_on_rate_limit_then_succeeds(self, session_cls, sleep):
        session = session_cls.return_value

        rate_limited = MagicMock()
        rate_limited.status_code = 200
        rate_limited.raise_for_status.return_value = None
        rate_limited.json.return_value = {"error": "Rate Limit Exceeded"}
        rate_limited.headers = {}

        success = MagicMock()
        success.status_code = 200
        success.raise_for_status.return_value = None
        success.json.return_value = {"files": [], "isTruncated": False}
        success.headers = {}

        session.get.side_effect = [rate_limited, success]

        client = KnmiOpenDataClient("token", "radar_forecast", "2.0", max_retries=3)
        payload = client.list_files()

        self.assertEqual(payload["files"], [])
        self.assertEqual(session.get.call_count, 2)
        sleep.assert_called_once_with(1.0)

    @patch("radar.knmi.requests.get")
    @patch("radar.knmi.requests.Session")
    def test_download_file_streams_to_disk(self, session_cls, plain_get):
        session = session_cls.return_value

        list_response = MagicMock()
        list_response.status_code = 200
        list_response.raise_for_status.return_value = None
        list_response.json.return_value = {
            "temporaryDownloadUrl": "https://example.com/file.h5"
        }
        list_response.headers = {}
        session.get.return_value = list_response

        download_response = MagicMock()
        download_response.raise_for_status.return_value = None
        download_response.iter_content.return_value = [b"abc", b"def"]
        download_response.__enter__.return_value = download_response
        download_response.__exit__.return_value = None
        plain_get.return_value = download_response

        client = KnmiOpenDataClient("token", "radar_forecast", "2.0")
        destination = Path(self.tempdir.name) / "RAD_NL25_RAC_FM_202608301445.h5"
        client.download_file("RAD_NL25_RAC_FM_202608301445.h5", destination)

        self.assertEqual(destination.read_bytes(), b"abcdef")
        plain_get.assert_called_once()
        self.assertNotIn(
            "Authorization",
            plain_get.call_args.kwargs.get("headers", {}),
        )


class Hdf5ParserTests(SimpleTestCase):
    def setUp(self):
        import tempfile

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)

    def test_parse_radar_forecast_hdf5(self):
        path = create_sample_radar_forecast_h5(
            Path(self.tempdir.name) / "sample.h5",
            step_count=25,
        )
        metadata = parse_radar_forecast_hdf5(path)

        self.assertEqual(metadata.rows, 765)
        self.assertEqual(metadata.cols, 700)
        self.assertIn("+proj=stere", metadata.proj4)
        self.assertEqual(len(metadata.steps), 25)
        self.assertEqual(metadata.steps[0].image_name, "image1")
        self.assertEqual(metadata.steps[0].lead_minutes, 0)
        self.assertEqual(metadata.steps[-1].lead_minutes, 120)

    def test_pixel_to_mm_hr(self):
        self.assertAlmostEqual(pixel_to_mm_hr(10), 1.2)


@override_settings(
    KNMI_OPEN_DATA_API_KEY="test-key",
    KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-test-data"),
)
class IngestCommandTests(TestCase):
    def setUp(self):
        from django.conf import settings

        self.data_dir = Path(settings.KNMI_RADAR_FORECAST_DATA_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    @patch("radar.management.commands.ingest_radar_forecast.KnmiOpenDataClient")
    def test_ingest_latest_creates_forecast_and_steps(self, client_cls):
        sample_path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
        )

        file_info = KnmiFileInfo(
            filename="RAD_NL25_RAC_FM_202608301445.h5",
            size=sample_path.stat().st_size,
            created=datetime(2026, 8, 30, 14, 46, 45, tzinfo=timezone.utc),
            last_modified=datetime(2026, 8, 30, 14, 46, 45, tzinfo=timezone.utc),
        )

        client = client_cls.return_value
        client.iter_files.return_value = [file_info]
        client.download_file.side_effect = lambda filename, destination: destination.write_bytes(
            sample_path.read_bytes()
        ) or destination

        call_command("ingest_radar_forecast")

        forecast = RadarForecast.objects.get(filename=file_info.filename)
        self.assertEqual(forecast.status, RadarForecast.Status.PARSED)
        self.assertEqual(forecast.rows, 765)
        self.assertEqual(forecast.steps.count(), 25)
        self.assertEqual(
            forecast.issued_at,
            datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
        )

    @patch("radar.management.commands.ingest_radar_forecast.KnmiOpenDataClient")
    def test_ingest_skips_already_parsed_file(self, client_cls):
        sample_path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=2,
        )
        forecast = RadarForecast.objects.create(
            filename="RAD_NL25_RAC_FM_202608301445.h5",
            issued_at=datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
            file_path=str(sample_path),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
        )

        file_info = KnmiFileInfo(
            filename=forecast.filename,
            size=123,
            created=datetime(2026, 8, 30, 14, 46, 45, tzinfo=timezone.utc),
            last_modified=datetime(2026, 8, 30, 14, 46, 45, tzinfo=timezone.utc),
        )
        client = client_cls.return_value
        client.iter_files.return_value = [file_info]

        call_command("ingest_radar_forecast")

        client.download_file.assert_not_called()
        self.assertEqual(RadarForecast.objects.count(), 1)
        self.assertEqual(RadarForecastStep.objects.count(), 1)
