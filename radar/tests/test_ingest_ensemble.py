from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings

from radar.knmi import KnmiFileInfo, parse_ensemble_filename_issued_at
from radar.models import EnsembleForecast, EnsembleForecastStep
from radar.netcdf import parse_ensemble_forecast_netcdf
from radar.tests.fixtures import create_live_ensemble_forecast_nc, create_sample_ensemble_forecast_nc


class EnsembleFilenameTests(SimpleTestCase):
    def test_parse_ensemble_filename_issued_at(self):
        issued_at = parse_ensemble_filename_issued_at(
            "seamless_precipitation_ensemble_forecast_members_1.0_"
            "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc"
        )
        self.assertEqual(
            issued_at,
            datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc),
        )


class EnsembleNetcdfParserTests(SimpleTestCase):
    def setUp(self):
        import tempfile

        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)

    def test_parse_ensemble_forecast_netcdf(self):
        issued_at = datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc)
        path = create_sample_ensemble_forecast_nc(
            Path(self.tempdir.name)
            / "seamless_precipitation_ensemble_forecast_members_1.0_"
            "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc",
            step_count=72,
            member_count=20,
            issued_at=issued_at,
        )
        metadata = parse_ensemble_forecast_netcdf(path)

        self.assertEqual(metadata.rows, 10)
        self.assertEqual(metadata.cols, 12)
        self.assertIn("+proj=stere", metadata.proj4)
        self.assertEqual(metadata.member_count, 20)
        self.assertEqual(len(metadata.steps), 72)
        self.assertEqual(metadata.steps[0].lead_minutes, 5)
        self.assertEqual(metadata.steps[-1].lead_minutes, 360)
        self.assertEqual(
            metadata.steps[0].valid_at,
            datetime(2026, 8, 23, 21, 25, tzinfo=timezone.utc),
        )

    def test_parse_live_knmi_ensemble_forecast_netcdf(self):
        issued_at = datetime(2026, 8, 30, 17, 55, tzinfo=timezone.utc)
        path = create_live_ensemble_forecast_nc(
            Path(self.tempdir.name) / "KNMI_PYSTEPS_BLEND_ENS_202608301755.nc",
            step_count=72,
            member_count=20,
            issued_at=issued_at,
        )
        metadata = parse_ensemble_forecast_netcdf(path)

        self.assertEqual(metadata.rows, 10)
        self.assertEqual(metadata.cols, 12)
        self.assertEqual(metadata.member_count, 20)
        self.assertEqual(len(metadata.steps), 72)
        self.assertEqual(metadata.steps[0].lead_minutes, 5)
        self.assertEqual(metadata.steps[-1].lead_minutes, 360)


@override_settings(
    KNMI_OPEN_DATA_API_KEY="test-key",
    KNMI_ENSEMBLE_FORECAST_DATA_DIR=Path("/tmp/regenkans-ensemble-test-data"),
)
class IngestEnsembleCommandTests(TestCase):
    def setUp(self):
        from django.conf import settings

        self.data_dir = Path(settings.KNMI_ENSEMBLE_FORECAST_DATA_DIR)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.filename = (
            "seamless_precipitation_ensemble_forecast_members_1.0_"
            "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc"
        )

    @patch("radar.management.commands.ingest_ensemble_forecast.KnmiOpenDataClient")
    def test_ingest_latest_creates_forecast_and_steps(self, client_cls):
        sample_path = create_sample_ensemble_forecast_nc(
            self.data_dir / self.filename,
            step_count=72,
            member_count=20,
        )

        file_info = KnmiFileInfo(
            filename=self.filename,
            size=sample_path.stat().st_size,
            created=datetime(2026, 8, 23, 21, 21, 45, tzinfo=timezone.utc),
            last_modified=datetime(2026, 8, 23, 21, 21, 45, tzinfo=timezone.utc),
        )

        client = client_cls.return_value
        client.iter_files.return_value = [file_info]
        client.download_file.side_effect = lambda filename, destination: destination.write_bytes(
            sample_path.read_bytes()
        ) or destination

        call_command("ingest_ensemble_forecast")

        forecast = EnsembleForecast.objects.get(filename=file_info.filename)
        self.assertEqual(forecast.status, EnsembleForecast.Status.PARSED)
        self.assertEqual(forecast.rows, 10)
        self.assertEqual(forecast.cols, 12)
        self.assertEqual(forecast.member_count, 20)
        self.assertEqual(forecast.steps.count(), 72)
        self.assertEqual(
            forecast.issued_at,
            datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc),
        )

    @patch("radar.management.commands.ingest_ensemble_forecast.KnmiOpenDataClient")
    def test_ingest_skips_already_parsed_file(self, client_cls):
        sample_path = create_sample_ensemble_forecast_nc(
            self.data_dir / self.filename,
            step_count=3,
            member_count=2,
        )
        forecast = EnsembleForecast.objects.create(
            filename=self.filename,
            issued_at=datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc),
            file_path=str(sample_path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=2,
        )
        EnsembleForecastStep.objects.create(
            forecast=forecast,
            lead_minutes=5,
            valid_at=datetime(2026, 8, 23, 21, 25, tzinfo=timezone.utc),
        )

        file_info = KnmiFileInfo(
            filename=forecast.filename,
            size=123,
            created=datetime(2026, 8, 23, 21, 21, 45, tzinfo=timezone.utc),
            last_modified=datetime(2026, 8, 23, 21, 21, 45, tzinfo=timezone.utc),
        )
        client = client_cls.return_value
        client.iter_files.return_value = [file_info]

        call_command("ingest_ensemble_forecast")

        client.download_file.assert_not_called()
        self.assertEqual(EnsembleForecast.objects.count(), 1)
        self.assertEqual(EnsembleForecastStep.objects.count(), 1)
