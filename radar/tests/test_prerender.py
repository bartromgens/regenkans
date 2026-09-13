from __future__ import annotations

import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase, override_settings

from radar.expected import expected_frame_cache_path
from radar.knmi import KnmiFileInfo
from radar.models import (
    EnsembleForecast,
    EnsembleForecastStep,
    RadarForecast,
    RadarForecastStep,
)
from radar.prerender import prerender_ensemble_forecast, prerender_radar_forecast
from radar.probability import probability_frame_cache_path
from radar.render import frame_cache_path
from radar.tests.fixtures import (
    create_sample_ensemble_forecast_nc,
    create_sample_radar_forecast_h5,
)

RADAR_ISSUED_AT = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
ENSEMBLE_ISSUED_AT = datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc)


class PrerenderRadarForecastTests(TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.data_dir = Path(self.tempdir.name)

    def _create_forecast(self, *, step_count: int) -> RadarForecast:
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=step_count,
        )
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=RADAR_ISSUED_AT,
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )
        for index in range(step_count):
            lead_minutes = index * 5
            RadarForecastStep.objects.create(
                forecast=forecast,
                image_name=f"image{index + 1}",
                lead_minutes=lead_minutes,
                valid_at=RADAR_ISSUED_AT + timedelta(minutes=lead_minutes),
            )
        return forecast

    def test_renders_a_png_for_every_step(self):
        forecast = self._create_forecast(step_count=3)

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            result = prerender_radar_forecast(forecast)

            self.assertEqual(result.rendered, 3)
            self.assertEqual(result.errors, [])
            for lead_minutes in (0, 5, 10):
                self.assertTrue(
                    frame_cache_path(forecast.filename, lead_minutes).exists()
                )

    def test_skips_steps_beyond_the_prerender_horizon(self):
        forecast = self._create_forecast(step_count=3)
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image-far",
            lead_minutes=300,
            valid_at=RADAR_ISSUED_AT + timedelta(minutes=300),
        )

        with override_settings(
            KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir,
            FRAME_PRERENDER_HOURS=4,
        ):
            result = prerender_radar_forecast(forecast)

            self.assertEqual(result.rendered, 3)
            self.assertFalse(frame_cache_path(forecast.filename, 300).exists())

    def test_a_failing_frame_is_reported_without_stopping_the_rest(self):
        forecast = self._create_forecast(step_count=3)

        def fake_render(_forecast, lead_minutes):
            if lead_minutes == 5:
                raise ValueError("boom")
            return None

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            with patch("radar.prerender.render_forecast_frame", side_effect=fake_render):
                result = prerender_radar_forecast(forecast)

        self.assertEqual(result.rendered, 2)
        self.assertEqual(len(result.errors), 1)
        self.assertIn("intensity +5m", result.errors[0])


@override_settings(KNMI_OPEN_DATA_API_KEY="test-key")
class IngestPrerendersFramesTests(TestCase):
    """The ingest command is what keeps rendering off the request path."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.data_dir = Path(self.tempdir.name)
        self.sample_path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=3,
        )
        self.file_info = KnmiFileInfo(
            filename=self.sample_path.name,
            size=self.sample_path.stat().st_size,
            created=datetime(2026, 8, 30, 14, 46, 45, tzinfo=timezone.utc),
            last_modified=datetime(2026, 8, 30, 14, 46, 45, tzinfo=timezone.utc),
        )

    def _run_ingest(self, client_cls, *args):
        client = client_cls.return_value
        client.iter_files.return_value = [self.file_info]
        client.download_file.side_effect = (
            lambda filename, destination: destination.write_bytes(
                self.sample_path.read_bytes()
            )
            or destination
        )

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            call_command("ingest_radar_forecast", *args)

    @patch("radar.management.commands.ingest_radar_forecast.KnmiOpenDataClient")
    def test_ingest_renders_the_frames(self, client_cls):
        self._run_ingest(client_cls)

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            for lead_minutes in (0, 5, 10):
                self.assertTrue(
                    frame_cache_path(self.file_info.filename, lead_minutes).exists()
                )

    @patch("radar.management.commands.ingest_radar_forecast.KnmiOpenDataClient")
    def test_no_prerender_leaves_the_frames_to_be_rendered_on_demand(self, client_cls):
        self._run_ingest(client_cls, "--no-prerender")

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            self.assertFalse(frame_cache_path(self.file_info.filename, 0).exists())
        self.assertEqual(RadarForecast.objects.count(), 1)


class PrerenderEnsembleForecastTests(TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.data_dir = Path(self.tempdir.name)

    def _create_forecast(self, *, step_count: int) -> EnsembleForecast:
        path = create_sample_ensemble_forecast_nc(
            self.data_dir / "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc",
            step_count=step_count,
            member_count=4,
            wet_member_count=2,
            issued_at=ENSEMBLE_ISSUED_AT,
        )
        forecast = EnsembleForecast.objects.create(
            filename=path.name,
            issued_at=ENSEMBLE_ISSUED_AT,
            file_path=str(path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )
        for index in range(step_count):
            lead_minutes = (index + 1) * 5
            EnsembleForecastStep.objects.create(
                forecast=forecast,
                lead_minutes=lead_minutes,
                valid_at=ENSEMBLE_ISSUED_AT + timedelta(minutes=lead_minutes),
            )
        return forecast

    def test_renders_probability_and_expected_for_every_step(self):
        forecast = self._create_forecast(step_count=2)

        with override_settings(KNMI_ENSEMBLE_FORECAST_DATA_DIR=self.data_dir):
            result = prerender_ensemble_forecast(forecast)

            self.assertEqual(result.rendered, 4)
            self.assertEqual(result.errors, [])
            for lead_minutes in (5, 10):
                self.assertTrue(
                    probability_frame_cache_path(forecast.filename, lead_minutes).exists()
                )
                self.assertTrue(
                    expected_frame_cache_path(forecast.filename, lead_minutes).exists()
                )

    def test_skips_steps_beyond_the_prerender_horizon(self):
        forecast = self._create_forecast(step_count=2)
        EnsembleForecastStep.objects.create(
            forecast=forecast,
            lead_minutes=300,
            valid_at=ENSEMBLE_ISSUED_AT + timedelta(minutes=300),
        )

        with override_settings(
            KNMI_ENSEMBLE_FORECAST_DATA_DIR=self.data_dir,
            FRAME_PRERENDER_HOURS=4,
        ):
            result = prerender_ensemble_forecast(forecast)

            self.assertEqual(result.rendered, 4)
            self.assertFalse(
                probability_frame_cache_path(forecast.filename, 300).exists()
            )
