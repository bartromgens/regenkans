from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np
from django.test import TestCase, override_settings
from PIL import Image
from pyproj import Transformer

import radar.render as render_module
from radar.hdf5 import KNMI_PROJ4_METERS
from radar.models import RadarForecast, RadarForecastStep
from radar.render import frame_cache_path, render_forecast_frame
from radar.tests.fixtures import create_sample_radar_forecast_h5
from radar.timeline import build_timeline, build_unified_timeline

KNMI_GRID_ROW_OFFSET_M = 3650 * 1000
KNMI_GRID_PIXEL_M = 1000


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-timeline-test"))
class TimelineTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-timeline-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_build_timeline_composes_past_and_future(self):
        older_path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301435.h5",
            step_count=25,
            issued_at=datetime(2026, 8, 30, 14, 35, tzinfo=timezone.utc),
        )
        latest_path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
            issued_at=datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
        )

        for path, issued_at in (
            (older_path, datetime(2026, 8, 30, 14, 35, tzinfo=timezone.utc)),
            (latest_path, datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)),
        ):
            forecast = RadarForecast.objects.create(
                filename=path.name,
                issued_at=issued_at,
                file_path=str(path),
                status=RadarForecast.Status.PARSED,
                rows=700,
                cols=765,
            )
            for lead in range(0, 125, 5):
                RadarForecastStep.objects.create(
                    forecast=forecast,
                    image_name=f"image{lead // 5 + 1}",
                    lead_minutes=lead,
                    valid_at=issued_at + timedelta(minutes=lead),
                )

        now, slots = build_timeline(hours=24)

        self.assertEqual(now, datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc))
        self.assertEqual(len(slots), 26)
        self.assertEqual(sum(1 for slot in slots if slot.kind == "observed"), 2)
        self.assertEqual(sum(1 for slot in slots if slot.kind == "forecast"), 24)
        self.assertTrue(
            all(slot.intensity and slot.intensity.lead_minutes == 0 for slot in slots[:2])
        )
        self.assertTrue(
            all(
                slot.intensity and slot.intensity.lead_minutes > 0
                for slot in slots[2:]
            )
        )
        self.assertTrue(all(slot.probability is None for slot in slots))


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-render-test"))
class RenderTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-render-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_render_forecast_frame_creates_cached_png(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=3,
        )
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=forecast.issued_at,
        )

        rendered = render_forecast_frame(forecast, 0)

        self.assertTrue(rendered.path.exists())
        self.assertEqual(len(rendered.bbox), 4)
        self.assertTrue(rendered.path.with_suffix(".bbox").exists())

    def test_bbox_sidecar_is_never_missing_while_png_is_visible(self):
        """Regression test for a request-time race.

        A concurrent request only checks `cache_path.exists()` before
        reading the `.bbox` sidecar. If the PNG became visible before its
        sidecar was written, that concurrent request would hit a
        `FileNotFoundError` (see the traceback that motivated this test).
        The renderer must make the sidecar file exist *before* the PNG is
        atomically renamed into its final, externally visible location.
        """
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301510.h5",
            step_count=3,
        )
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 30, 15, 10, tzinfo=timezone.utc),
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=forecast.issued_at,
        )

        # Make sure this test always exercises a fresh render, even on a
        # rerun where a previous pass already populated the on-disk cache.
        cache_path = frame_cache_path(forecast.filename, 0)
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

        with patch.object(render_module.os, "replace", side_effect=spying_replace):
            render_forecast_frame(forecast, 0)

        self.assertTrue(observed_png_replace, "expected the PNG to be rendered")

    def test_rendered_frame_is_georeferenced_for_a_mercator_quad(self):
        """A single rain pixel must land on its true position once drawn.

        The client hands the frame to MapLibre as an `image` source, which
        stretches the PNG linearly over the four corners *in Web Mercator
        space*. This replicates that mapping and checks the round trip, which
        is what a frame rendered in EPSG:4326 got wrong: latitude is not linear
        in Mercator y, so Dutch rain was drawn ~15 km too far north.
        """
        spike_row, spike_col = 427, 369
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301500.h5",
            step_count=1,
            pixel_value_at=(spike_row, spike_col, 1000),
        )
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=datetime(2026, 8, 30, 15, 0, tzinfo=timezone.utc),
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=forecast.issued_at,
        )

        rendered = render_forecast_frame(forecast, 0)

        # True position of that source pixel's centre.
        to_lnglat = Transformer.from_crs(KNMI_PROJ4_METERS, "EPSG:4326", always_xy=True)
        expected_lng, expected_lat = to_lnglat.transform(
            spike_col * KNMI_GRID_PIXEL_M + KNMI_GRID_PIXEL_M / 2,
            -KNMI_GRID_ROW_OFFSET_M - (spike_row * KNMI_GRID_PIXEL_M + KNMI_GRID_PIXEL_M / 2),
        )

        # Where the spike ended up in the PNG, as a fraction of the image.
        alpha = np.asarray(Image.open(rendered.path).convert("RGBA"))[:, :, 3]
        rows, cols = np.nonzero(alpha)
        self.assertGreater(rows.size, 0, "expected the rain spike to be rendered")
        fraction_x = (cols.mean() + 0.5) / alpha.shape[1]
        fraction_y = (rows.mean() + 0.5) / alpha.shape[0]

        # Replicate MapLibre: linear interpolation across the quad in Mercator.
        west, south, east, north = rendered.bbox
        to_mercator = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
        left, top = to_mercator.transform(west, north)
        right, bottom = to_mercator.transform(east, south)
        drawn_lng, drawn_lat = Transformer.from_crs(
            "EPSG:3857", "EPSG:4326", always_xy=True
        ).transform(
            left + fraction_x * (right - left),
            top + fraction_y * (bottom - top),
        )

        # One source pixel is 1 km, so sub-kilometre agreement is exact enough;
        # the EPSG:4326 bug missed by ~15 km.
        self.assertAlmostEqual(drawn_lat, expected_lat, delta=0.009)  # ~1 km
        self.assertAlmostEqual(drawn_lng, expected_lng, delta=0.015)  # ~1 km
