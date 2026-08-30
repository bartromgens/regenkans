from datetime import datetime, timedelta, timezone
from pathlib import Path

from django.test import TestCase, override_settings
from django.urls import reverse

from radar.models import EnsembleForecast, EnsembleForecastStep, RadarForecast, RadarForecastStep
from radar.tests.fixtures import (
    create_live_ensemble_forecast_nc,
    create_sample_ensemble_forecast_nc,
    create_sample_radar_forecast_h5,
)


@override_settings(KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-api-test"))
class RadarApiTests(TestCase):
    def setUp(self):
        self.data_dir = Path("/tmp/regenkans-api-test")
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def test_timeline_endpoint_returns_composed_frames(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
        )
        issued_at = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
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

        response = self.client.get(reverse("radar-timeline"), {"hours": 6})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["now"], issued_at.isoformat())
        self.assertEqual(len(payload["frames"]), 25)
        self.assertEqual(payload["frames"][0]["kind"], "observed")
        self.assertEqual(payload["frames"][-1]["kind"], "forecast")

    def test_frame_endpoint_renders_png(self):
        path = create_sample_radar_forecast_h5(
            self.data_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=3,
        )
        issued_at = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
        forecast = RadarForecast.objects.create(
            filename=path.name,
            issued_at=issued_at,
            file_path=str(path),
            status=RadarForecast.Status.PARSED,
            rows=700,
            cols=765,
        )
        RadarForecastStep.objects.create(
            forecast=forecast,
            image_name="image1",
            lead_minutes=0,
            valid_at=issued_at,
        )

        response = self.client.get(
            reverse("radar-frame", args=[path.name, 0]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertIn("X-Radar-BBox", response)


@override_settings(
    KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-api-radar"),
    KNMI_ENSEMBLE_FORECAST_DATA_DIR=Path("/tmp/regenkans-api-ensemble"),
)
class EnsembleApiTests(TestCase):
    def setUp(self):
        self.radar_dir = Path("/tmp/regenkans-api-radar")
        self.ensemble_dir = Path("/tmp/regenkans-api-ensemble")
        self.radar_dir.mkdir(parents=True, exist_ok=True)
        self.ensemble_dir.mkdir(parents=True, exist_ok=True)
        self.ensemble_filename = (
            "seamless_precipitation_ensemble_forecast_members_1.0_"
            "KNMI_PYSTEPS_BLEND_ENS_202608232120.nc"
        )

    def _seed_radar_and_ensemble(self):
        radar_path = create_sample_radar_forecast_h5(
            self.radar_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
        )
        ensemble_path = create_sample_ensemble_forecast_nc(
            self.ensemble_dir / self.ensemble_filename,
            step_count=72,
            member_count=20,
            wet_member_count=10,
        )
        radar_issued = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)
        ensemble_issued = datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc)

        radar = RadarForecast.objects.create(
            filename=radar_path.name,
            issued_at=radar_issued,
            file_path=str(radar_path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        RadarForecastStep.objects.create(
            forecast=radar,
            image_name="image1",
            lead_minutes=0,
            valid_at=radar_issued,
        )

        ensemble = EnsembleForecast.objects.create(
            filename=ensemble_path.name,
            issued_at=ensemble_issued,
            file_path=str(ensemble_path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=20,
        )
        for lead in range(5, 365, 5):
            EnsembleForecastStep.objects.create(
                forecast=ensemble,
                lead_minutes=lead,
                valid_at=ensemble_issued + timedelta(minutes=lead),
            )

        return ensemble

    def test_ensemble_timeline_endpoint_returns_mixed_frames(self):
        self._seed_radar_and_ensemble()

        response = self.client.get(reverse("ensemble-timeline"), {"hours": 6})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ensemble_available"])
        self.assertEqual(payload["frames"][0]["overlay"], "intensity")
        self.assertEqual(payload["frames"][1]["overlay"], "probability")
        self.assertTrue(payload["frames"][1]["image_url"].startswith("/api/ensemble/frames/"))

    def test_ensemble_frame_endpoint_renders_png(self):
        ensemble = self._seed_radar_and_ensemble()

        response = self.client.get(
            reverse("ensemble-frame", args=[ensemble.filename, 5]),
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertIn("X-Radar-BBox", response)

    def test_ensemble_frame_endpoint_accepts_live_filename_and_lead(self):
        filename = "KNMI_PYSTEPS_BLEND_ENS_202608301755.nc"
        path = create_live_ensemble_forecast_nc(
            self.ensemble_dir / filename,
            step_count=3,
            member_count=4,
            wet_member_count=2,
        )
        issued_at = datetime(2026, 8, 30, 17, 55, tzinfo=timezone.utc)
        ensemble = EnsembleForecast.objects.create(
            filename=filename,
            issued_at=issued_at,
            file_path=str(path),
            status=EnsembleForecast.Status.PARSED,
            rows=10,
            cols=12,
            member_count=4,
        )
        EnsembleForecastStep.objects.create(
            forecast=ensemble,
            lead_minutes=10,
            valid_at=issued_at + timedelta(minutes=10),
        )

        response = self.client.get(f"/api/ensemble/frames/{filename}/10.png")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        self.assertIn("X-Radar-BBox", response)
