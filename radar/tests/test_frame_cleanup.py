from __future__ import annotations

import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone as django_timezone

from radar.frames import ensemble_frame_files, radar_frame_files
from radar.models import EnsembleForecast, RadarForecast


class FrameFileMatchingTests(TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.data_dir = Path(self.tempdir.name)
        self.frames_dir = self.data_dir / "frames"
        self.frames_dir.mkdir()

    def _touch(self, *names: str) -> None:
        for name in names:
            (self.frames_dir / name).write_text("x")

    def test_matches_every_rendered_artefact_of_one_forecast(self):
        self._touch(
            "KNMI_PYSTEPS_BLEND_ENS_202608232120_5_pop01_3857.png",
            "KNMI_PYSTEPS_BLEND_ENS_202608232120_5_pop01_3857.bbox",
            "KNMI_PYSTEPS_BLEND_ENS_202608232120_5_expected_3857.png",
            "KNMI_PYSTEPS_BLEND_ENS_202608232120_10_pop01_3857.png",
        )

        with override_settings(KNMI_ENSEMBLE_FORECAST_DATA_DIR=self.data_dir):
            matched = ensemble_frame_files("KNMI_PYSTEPS_BLEND_ENS_202608232120.nc")

        self.assertEqual(len(matched), 4)

    def test_does_not_match_a_different_forecast(self):
        self._touch(
            "KNMI_PYSTEPS_BLEND_ENS_202608232120_5_pop01_3857.png",
            "KNMI_PYSTEPS_BLEND_ENS_202608232125_5_pop01_3857.png",
            # The short name is a suffix of this longer one, so a naive match
            # would delete this forecast's frames along with the other's.
            "seamless_1.0_KNMI_PYSTEPS_BLEND_ENS_202608232120_5_pop01_3857.png",
        )

        with override_settings(KNMI_ENSEMBLE_FORECAST_DATA_DIR=self.data_dir):
            matched = ensemble_frame_files("KNMI_PYSTEPS_BLEND_ENS_202608232120.nc")

        self.assertEqual(
            [path.name for path in matched],
            ["KNMI_PYSTEPS_BLEND_ENS_202608232120_5_pop01_3857.png"],
        )

    def test_missing_frames_directory_is_not_an_error(self):
        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir / "nope"):
            self.assertEqual(radar_frame_files("RAD_NL25_RAC_FM_202608301445.h5"), [])


class CleanupDeletesFramesTests(TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.data_dir = Path(self.tempdir.name)
        self.frames_dir = self.data_dir / "frames"
        self.frames_dir.mkdir()

    def _create_radar_forecast(self, *, filename: str, age_days: float) -> RadarForecast:
        issued_at = django_timezone.now() - timedelta(days=age_days)
        source = self.data_dir / filename
        source.write_text("source")
        (self.frames_dir / f"{Path(filename).stem}_0_3857.png").write_text("frame")
        (self.frames_dir / f"{Path(filename).stem}_0_3857.bbox").write_text("bbox")
        return RadarForecast.objects.create(
            filename=filename,
            issued_at=issued_at,
            file_path=str(source),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )

    def test_cleanup_deletes_frames_of_expired_forecasts(self):
        old = self._create_radar_forecast(
            filename="RAD_NL25_RAC_FM_202608300000.h5", age_days=3
        )
        recent = self._create_radar_forecast(
            filename="RAD_NL25_RAC_FM_202608310000.h5", age_days=0
        )

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            call_command("cleanup_radar_forecast", "--days", "1")

            self.assertEqual(radar_frame_files(old.filename), [])
            self.assertEqual(len(radar_frame_files(recent.filename)), 2)

        self.assertFalse((self.data_dir / old.filename).exists())
        self.assertEqual(
            list(RadarForecast.objects.values_list("filename", flat=True)),
            [recent.filename],
        )

    def test_dry_run_deletes_nothing(self):
        old = self._create_radar_forecast(
            filename="RAD_NL25_RAC_FM_202608300000.h5", age_days=3
        )
        self._create_radar_forecast(
            filename="RAD_NL25_RAC_FM_202608310000.h5", age_days=0
        )

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            call_command("cleanup_radar_forecast", "--days", "1", "--dry-run")

            self.assertEqual(len(radar_frame_files(old.filename)), 2)

        self.assertTrue((self.data_dir / old.filename).exists())
        self.assertEqual(RadarForecast.objects.count(), 2)

    def test_the_latest_forecast_is_kept_even_when_expired(self):
        only = self._create_radar_forecast(
            filename="RAD_NL25_RAC_FM_202608300000.h5", age_days=30
        )

        with override_settings(KNMI_RADAR_FORECAST_DATA_DIR=self.data_dir):
            call_command("cleanup_radar_forecast", "--days", "1")

            self.assertEqual(len(radar_frame_files(only.filename)), 2)

        self.assertEqual(RadarForecast.objects.count(), 1)

    def test_ensemble_cleanup_deletes_frames_too(self):
        issued_at = django_timezone.now() - timedelta(days=3)
        filename = "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc"
        source = self.data_dir / filename
        source.write_text("source")
        (self.frames_dir / f"{Path(filename).stem}_5_pop01_3857.png").write_text("f")
        (self.frames_dir / f"{Path(filename).stem}_5_expected_3857.png").write_text("f")
        EnsembleForecast.objects.create(
            filename=filename,
            issued_at=issued_at,
            file_path=str(source),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )
        # A newer forecast, so the expired one is not the one that gets kept.
        EnsembleForecast.objects.create(
            filename="KNMI_PYSTEPS_BLEND_ENS_202609010000.nc",
            issued_at=datetime.now(timezone.utc),
            file_path=str(self.data_dir / "KNMI_PYSTEPS_BLEND_ENS_202609010000.nc"),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )

        with override_settings(KNMI_ENSEMBLE_FORECAST_DATA_DIR=self.data_dir):
            call_command("cleanup_ensemble_forecast", "--days", "1")

            self.assertEqual(ensemble_frame_files(filename), [])

        self.assertFalse(source.exists())
