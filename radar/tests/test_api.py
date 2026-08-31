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

        response = self.client.get(reverse("radar-timeline"), {"hours": 24})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["now"], issued_at.isoformat())
        self.assertEqual(len(payload["frames"]), 25)
        self.assertEqual(payload["frames"][0]["kind"], "observed")
        self.assertEqual(payload["frames"][-1]["kind"], "forecast")
        self.assertIsNotNone(payload["frames"][0]["intensity"])
        self.assertIsNone(payload["frames"][0]["probability"])
        self.assertTrue(
            payload["frames"][0]["intensity"]["image_url"].startswith("/api/radar/frames/")
        )

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

    def _seed_radar_and_ensemble(self, *, aligned: bool = True):
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
        ensemble_issued = (
            radar_issued
            if aligned
            else datetime(2026, 8, 23, 21, 20, tzinfo=timezone.utc)
        )

        radar = RadarForecast.objects.create(
            filename=radar_path.name,
            issued_at=radar_issued,
            file_path=str(radar_path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        for lead in range(0, 125, 5):
            RadarForecastStep.objects.create(
                forecast=radar,
                image_name=f"image{lead // 5 + 1}",
                lead_minutes=lead,
                valid_at=radar_issued + timedelta(minutes=lead),
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

        return ensemble, radar_issued

    def test_ensemble_timeline_endpoint_returns_mixed_frames(self):
        self._seed_radar_and_ensemble()

        response = self.client.get(reverse("ensemble-timeline"), {"hours": 24})

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["ensemble_available"])
        self.assertIsNotNone(payload["frames"][0]["intensity"])
        self.assertIsNone(payload["frames"][0]["probability"])
        self.assertIsNotNone(payload["frames"][1]["intensity"])
        self.assertIsNotNone(payload["frames"][1]["probability"])
        self.assertTrue(
            payload["frames"][1]["probability"]["image_url"].startswith("/api/ensemble/frames/")
        )

    def test_both_timeline_endpoints_share_valid_at_sequence(self):
        self._seed_radar_and_ensemble()

        radar_response = self.client.get(reverse("radar-timeline"), {"hours": 24})
        ensemble_response = self.client.get(reverse("ensemble-timeline"), {"hours": 24})

        radar_valid_at = [frame["valid_at"] for frame in radar_response.json()["frames"]]
        ensemble_valid_at = [
            frame["valid_at"] for frame in ensemble_response.json()["frames"]
        ]

        self.assertEqual(radar_valid_at, ensemble_valid_at)

    def test_ensemble_frame_endpoint_renders_png(self):
        ensemble, _ = self._seed_radar_and_ensemble(aligned=False)

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


@override_settings(
    KNMI_RADAR_FORECAST_DATA_DIR=Path("/tmp/regenkans-point-radar"),
    KNMI_ENSEMBLE_FORECAST_DATA_DIR=Path("/tmp/regenkans-point-ensemble"),
)
class RadarPointApiTests(TestCase):
    WET_LAT = 52.1115
    WET_LNG = 6.153931818181818

    def setUp(self):
        self.radar_dir = Path("/tmp/regenkans-point-radar")
        self.ensemble_dir = Path("/tmp/regenkans-point-ensemble")
        self.radar_dir.mkdir(parents=True, exist_ok=True)
        self.ensemble_dir.mkdir(parents=True, exist_ok=True)

    def _seed_timeline_data(self):
        radar_path = create_sample_radar_forecast_h5(
            self.radar_dir / "RAD_NL25_RAC_FM_202608301445.h5",
            step_count=25,
        )
        ensemble_path = create_live_ensemble_forecast_nc(
            self.ensemble_dir / "KNMI_PYSTEPS_BLEND_ENS_202608301445.nc",
            step_count=72,
            member_count=20,
            wet_member_count=10,
            issued_at=datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc),
        )
        radar_issued = datetime(2026, 8, 30, 14, 45, tzinfo=timezone.utc)

        radar = RadarForecast.objects.create(
            filename=radar_path.name,
            issued_at=radar_issued,
            file_path=str(radar_path),
            status=RadarForecast.Status.PARSED,
            rows=765,
            cols=700,
        )
        for lead in range(0, 125, 5):
            RadarForecastStep.objects.create(
                forecast=radar,
                image_name=f"image{lead // 5 + 1}",
                lead_minutes=lead,
                valid_at=radar_issued + timedelta(minutes=lead),
            )

        ensemble = EnsembleForecast.objects.create(
            filename=ensemble_path.name,
            issued_at=radar_issued,
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
                valid_at=radar_issued + timedelta(minutes=lead),
            )

        return radar_issued

    def test_point_endpoint_returns_time_series(self):
        radar_issued = self._seed_timeline_data()

        response = self.client.get(
            reverse("radar-point"),
            {"lat": self.WET_LAT, "lng": self.WET_LNG, "hours": 24},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["lat"], self.WET_LAT)
        self.assertEqual(payload["lng"], self.WET_LNG)
        self.assertEqual(payload["now"], radar_issued.isoformat())
        self.assertGreater(len(payload["points"]), 1)

        observed = payload["points"][0]
        self.assertEqual(observed["kind"], "observed")
        self.assertEqual(observed["intensity"], 0.0)
        self.assertIsNone(observed["probability"])
        self.assertIsNone(observed["expected"])

        forecast = next(point for point in payload["points"] if point["kind"] == "forecast")
        self.assertAlmostEqual(forecast["probability"], 0.5)
        self.assertEqual(forecast["expected"], 0.0)

    def test_point_endpoint_validates_coordinates(self):
        response = self.client.get(reverse("radar-point"))
        self.assertEqual(response.status_code, 400)

        response = self.client.get(
            reverse("radar-point"),
            {"lat": 100, "lng": 0},
        )
        self.assertEqual(response.status_code, 400)

        response = self.client.get(
            reverse("radar-point"),
            {"lat": 0, "lng": 200},
        )
        self.assertEqual(response.status_code, 400)

    def test_point_endpoint_returns_nulls_outside_grid(self):
        self._seed_timeline_data()

        response = self.client.get(
            reverse("radar-point"),
            {"lat": -10.0, "lng": -10.0, "hours": 24},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(all(point["intensity"] is None for point in payload["points"]))
        self.assertTrue(all(point["probability"] is None for point in payload["points"]))
