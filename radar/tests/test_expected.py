from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase, override_settings

import radar.render as render_module
from radar.expected import expected_frame_cache_path, render_expected_frame
from radar.models import EnsembleForecast, EnsembleForecastStep
from radar.netcdf import read_expected_precipitation
from radar.tests.fixtures import (
    create_live_ensemble_forecast_nc,
    create_sample_ensemble_forecast_nc,
)


@override_settings(KNMI_ENSEMBLE_FORECAST_DATA_DIR=Path("/tmp/regenkans-expected-test"))
class ExpectedAggregationTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-expected-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.filename = (
            "seamless_precipitation_ensemble_forecast_members_1.0_"
            "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc"
        )

    def test_read_expected_precipitation_matches_member_mean(self):
        path = create_sample_ensemble_forecast_nc(
            self.data_dir / self.filename,
            step_count=3,
            member_count=20,
            wet_member_count=10,
        )

        expected, grid = read_expected_precipitation(path, lead_minutes=5)

        self.assertEqual(grid.rows, 10)
        self.assertEqual(grid.cols, 12)
        self.assertAlmostEqual(float(expected[4, 6]), 0.1)
        self.assertAlmostEqual(float(expected[0, 0]), 0.0)

    def test_read_live_format_expected_precipitation(self):
        path = create_live_ensemble_forecast_nc(
            self.data_dir / "KNMI_PYSTEPS_BLEND_ENS_202608301755.nc",
            step_count=3,
            member_count=20,
            wet_member_count=10,
        )

        expected, grid = read_expected_precipitation(path, lead_minutes=5)

        self.assertTrue(grid.geographic)
        self.assertAlmostEqual(float(expected[4, 6]), 0.1)

    def test_render_expected_frame_creates_cached_png(self):
        path = create_sample_ensemble_forecast_nc(
            self.data_dir / self.filename,
            step_count=3,
            member_count=4,
            wet_member_count=2,
        )
        forecast = EnsembleForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc),
            file_path=str(path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )
        EnsembleForecastStep.objects.create(
            forecast=forecast,
            lead_minutes=5,
            valid_at=datetime(2026, 8, 23, 21, 25, tzinfo=timezone.utc),
        )

        rendered = render_expected_frame(forecast, 5)

        self.assertTrue(rendered.path.exists())
        self.assertEqual(len(rendered.bbox), 4)
        self.assertTrue(rendered.path.with_suffix(".bbox").exists())

    def test_bbox_sidecar_is_never_missing_while_png_is_visible(self):
        """Regression test for the race behind the /api/ensemble/expected/frames/ 500s.

        A concurrent request only checks `cache_path.exists()` before
        reading the `.bbox` sidecar. If the PNG became visible before its
        sidecar was written, that concurrent request would hit a
        `FileNotFoundError`.
        """
        path = create_sample_ensemble_forecast_nc(
            self.data_dir / self.filename,
            step_count=3,
            member_count=4,
            wet_member_count=2,
        )
        forecast = EnsembleForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc),
            file_path=str(path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )
        EnsembleForecastStep.objects.create(
            forecast=forecast,
            lead_minutes=10,
            valid_at=datetime(2026, 8, 23, 21, 30, tzinfo=timezone.utc),
        )

        # Make sure this test always exercises a fresh render, even on a
        # rerun where a previous pass already populated the on-disk cache.
        cache_path = expected_frame_cache_path(forecast.filename, 10)
        cache_path.unlink(missing_ok=True)
        cache_path.with_suffix(".bbox").unlink(missing_ok=True)

        observed_png_replace = False
        real_replace = render_module.os.replace

        def spying_replace(src, dst):
            nonlocal observed_png_replace
            dst_path = Path(dst)
            if dst_path.suffix == ".png":
                observed_png_replace = True
                self.assertTrue(
                    dst_path.with_suffix(".bbox").exists(),
                    "PNG became visible before its .bbox sidecar existed",
                )
            return real_replace(src, dst)

        # Use a lead time not exercised by other tests in this class so we
        # don't hit an already-cached frame left over from a previous run.
        with patch.object(render_module.os, "replace", side_effect=spying_replace):
            render_expected_frame(forecast, 10)

        self.assertTrue(observed_png_replace, "expected the PNG to be rendered")

    def test_render_live_format_geographic_expected_frame(self):
        path = create_live_ensemble_forecast_nc(
            self.data_dir / "KNMI_PYSTEPS_BLEND_ENS_202608301755.nc",
            step_count=3,
            member_count=4,
            wet_member_count=2,
        )
        forecast = EnsembleForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 30, 17, 55, tzinfo=timezone.utc),
            file_path=str(path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )

        rendered = render_expected_frame(forecast, 10)

        self.assertTrue(rendered.path.exists())
        west, south, east, north = rendered.bbox
        self.assertLess(west, east)
        self.assertLess(south, north)
