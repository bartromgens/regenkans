from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from django.utils import timezone

from radar.expected import expected_frame_cache_path
from radar.models import EnsembleForecast, RadarForecast
from radar.probability import probability_frame_cache_path
from radar.render import frame_cache_path, read_cached_bbox


FrameKind = Literal["observed", "forecast"]


@dataclass(frozen=True)
class FrameSource:
    issued_at: datetime
    lead_minutes: int
    image_url: str
    bbox: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class TimelineSlot:
    valid_at: datetime
    kind: FrameKind
    intensity: FrameSource | None = None
    probability: FrameSource | None = None
    expected: FrameSource | None = None


def build_unified_timeline(
    *, hours: int = 24
) -> tuple[datetime | None, list[TimelineSlot], bool]:
    latest_radar = (
        RadarForecast.objects.filter(status=RadarForecast.Status.PARSED)
        .order_by("-issued_at")
        .prefetch_related("steps")
        .first()
    )
    latest_ensemble = (
        EnsembleForecast.objects.filter(status=EnsembleForecast.Status.PARSED)
        .order_by("-issued_at")
        .prefetch_related("steps")
        .first()
    )

    if latest_radar is None:
        return None, [], latest_ensemble is not None

    now = latest_radar.issued_at
    cutoff = now - timedelta(hours=hours)
    past_forecasts = (
        RadarForecast.objects.filter(
            status=RadarForecast.Status.PARSED,
            issued_at__gte=cutoff,
            issued_at__lte=now,
        )
        .prefetch_related("steps")
        .order_by("issued_at")
    )

    slots: list[TimelineSlot] = []
    for forecast in past_forecasts:
        step = _step_for_lead(forecast, 0)
        if step is None:
            continue
        slots.append(
            TimelineSlot(
                valid_at=step.valid_at,
                kind="observed",
                intensity=_intensity_source(forecast, 0),
                probability=None,
            )
        )

    future_valid_at: set[datetime] = set()
    radar_future_steps: dict[datetime, tuple[RadarForecast, int]] = {}
    for step in latest_radar.steps.all():
        if step.lead_minutes == 0:
            continue
        future_valid_at.add(step.valid_at)
        radar_future_steps[step.valid_at] = (latest_radar, step.lead_minutes)

    ensemble_future_steps: dict[datetime, tuple[EnsembleForecast, int]] = {}
    if latest_ensemble is not None:
        for step in latest_ensemble.steps.all():
            if step.valid_at <= now:
                continue
            future_valid_at.add(step.valid_at)
            ensemble_future_steps[step.valid_at] = (
                latest_ensemble,
                step.lead_minutes,
            )

    for valid_at in sorted(future_valid_at):
        intensity = None
        if valid_at in radar_future_steps:
            forecast, lead_minutes = radar_future_steps[valid_at]
            intensity = _intensity_source(forecast, lead_minutes)

        probability = None
        expected = None
        if valid_at in ensemble_future_steps:
            forecast, lead_minutes = ensemble_future_steps[valid_at]
            probability = _probability_source(forecast, lead_minutes)
            expected = _expected_source(forecast, lead_minutes)

        slots.append(
            TimelineSlot(
                valid_at=valid_at,
                kind="forecast",
                intensity=intensity,
                probability=probability,
                expected=expected,
            )
        )

    return now, slots, latest_ensemble is not None


def build_timeline(*, hours: int = 24) -> tuple[datetime | None, list[TimelineSlot]]:
    now, slots, _ = build_unified_timeline(hours=hours)
    return now, slots


def build_probability_timeline(
    *, hours: int = 24
) -> tuple[datetime | None, list[TimelineSlot], bool]:
    return build_unified_timeline(hours=hours)


def serialize_timeline(*, hours: int = 24) -> dict:
    now, slots = build_timeline(hours=hours)
    return {
        "generated_at": timezone.now().isoformat(),
        "now": now.isoformat() if now else None,
        "frames": [_serialize_slot(slot) for slot in slots],
    }


def serialize_probability_timeline(*, hours: int = 24) -> dict:
    now, slots, ensemble_available = build_probability_timeline(hours=hours)
    return {
        "generated_at": timezone.now().isoformat(),
        "now": now.isoformat() if now else None,
        "ensemble_available": ensemble_available,
        "frames": [_serialize_slot(slot) for slot in slots],
    }


def _serialize_slot(slot: TimelineSlot) -> dict:
    return {
        "valid_at": slot.valid_at.isoformat(),
        "kind": slot.kind,
        "intensity": _serialize_source(slot.intensity),
        "probability": _serialize_source(slot.probability),
        "expected": _serialize_source(slot.expected),
    }


def _serialize_source(source: FrameSource | None) -> dict | None:
    if source is None:
        return None
    return {
        "issued_at": source.issued_at.isoformat(),
        "lead_minutes": source.lead_minutes,
        "image_url": source.image_url,
        "bbox": list(source.bbox) if source.bbox is not None else None,
    }


def _intensity_source(
    forecast: RadarForecast,
    lead_minutes: int,
) -> FrameSource:
    return FrameSource(
        issued_at=forecast.issued_at,
        lead_minutes=lead_minutes,
        image_url=f"/api/radar/frames/{forecast.filename}/{lead_minutes}.png",
        bbox=_cached_intensity_bbox(forecast.filename, lead_minutes),
    )


def _probability_source(
    forecast: EnsembleForecast,
    lead_minutes: int,
) -> FrameSource:
    return FrameSource(
        issued_at=forecast.issued_at,
        lead_minutes=lead_minutes,
        image_url=f"/api/ensemble/frames/{forecast.filename}/{lead_minutes}.png",
        bbox=_cached_probability_bbox(forecast.filename, lead_minutes),
    )


def _expected_source(
    forecast: EnsembleForecast,
    lead_minutes: int,
) -> FrameSource:
    return FrameSource(
        issued_at=forecast.issued_at,
        lead_minutes=lead_minutes,
        image_url=f"/api/ensemble/expected/frames/{forecast.filename}/{lead_minutes}.png",
        bbox=_cached_expected_bbox(forecast.filename, lead_minutes),
    )


def _step_for_lead(forecast: RadarForecast, lead_minutes: int):
    for step in forecast.steps.all():
        if step.lead_minutes == lead_minutes:
            return step
    return None


def _cached_intensity_bbox(
    filename: str,
    lead_minutes: int,
) -> tuple[float, float, float, float] | None:
    cache_path = frame_cache_path(filename, lead_minutes)
    sidecar = cache_path.with_suffix(".bbox")
    if not sidecar.exists():
        return None
    return read_cached_bbox(cache_path)


def _cached_probability_bbox(
    filename: str,
    lead_minutes: int,
) -> tuple[float, float, float, float] | None:
    cache_path = probability_frame_cache_path(filename, lead_minutes)
    sidecar = cache_path.with_suffix(".bbox")
    if not sidecar.exists():
        return None
    return read_cached_bbox(cache_path)


def _cached_expected_bbox(
    filename: str,
    lead_minutes: int,
) -> tuple[float, float, float, float] | None:
    cache_path = expected_frame_cache_path(filename, lead_minutes)
    sidecar = cache_path.with_suffix(".bbox")
    if not sidecar.exists():
        return None
    return read_cached_bbox(cache_path)
