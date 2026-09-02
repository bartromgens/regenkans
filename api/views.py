from django.http import FileResponse, Http404
from django.utils.http import http_date
from rest_framework.decorators import api_view
from rest_framework.response import Response
from rest_framework import status

from radar.expected import render_expected_frame
from radar.models import EnsembleForecast, RadarForecast
from radar.point import build_point_series
from radar.probability import render_probability_frame
from radar.render import render_forecast_frame
from radar.timeline import serialize_probability_timeline, serialize_timeline


def _resolve_radar_step(filename: str, lead_minutes: int) -> RadarForecast:
    forecast = RadarForecast.objects.filter(
        filename=filename,
        status=RadarForecast.Status.PARSED,
    ).first()
    if forecast is None:
        raise Http404("Verwachting niet gevonden")

    if not forecast.steps.filter(lead_minutes=lead_minutes).exists():
        raise Http404("Verwachtingsstap niet gevonden")

    return forecast


def _resolve_ensemble_step(filename: str, lead_minutes: int) -> EnsembleForecast:
    forecast = EnsembleForecast.objects.filter(
        filename=filename,
        status=EnsembleForecast.Status.PARSED,
    ).first()
    if forecast is None:
        raise Http404("Ensembleverwachting niet gevonden")

    if not forecast.steps.filter(lead_minutes=lead_minutes).exists():
        raise Http404("Ensembleverwachtingsstap niet gevonden")

    return forecast


def _frame_png_response(rendered) -> FileResponse:
    west, south, east, north = rendered.bbox
    response = FileResponse(rendered.path.open("rb"), content_type="image/png")
    response["Cache-Control"] = "public, max-age=300"
    response["X-Radar-BBox"] = f"{west},{south},{east},{north}"
    response["Access-Control-Expose-Headers"] = "X-Radar-BBox"
    response["Last-Modified"] = http_date(rendered.path.stat().st_mtime)
    return response


@api_view(["GET"])
def health_check(request):
    return Response({"status": "ok"})


@api_view(["GET"])
def radar_timeline(request):
    hours = int(request.query_params.get("hours", 24))
    return Response(serialize_timeline(hours=hours))


@api_view(["GET"])
def ensemble_timeline(request):
    hours = int(request.query_params.get("hours", 24))
    return Response(serialize_probability_timeline(hours=hours))


@api_view(["GET"])
def radar_frame(request, filename: str, lead_minutes: int):
    forecast = _resolve_radar_step(filename, lead_minutes)

    try:
        rendered = render_forecast_frame(forecast, lead_minutes)
    except (ValueError, OSError) as exc:
        raise Http404(str(exc)) from exc

    return _frame_png_response(rendered)


@api_view(["GET"])
def radar_frame_bbox(request, filename: str, lead_minutes: int):
    forecast = _resolve_radar_step(filename, lead_minutes)

    try:
        rendered = render_forecast_frame(forecast, lead_minutes)
    except (ValueError, OSError) as exc:
        raise Http404(str(exc)) from exc

    return Response({"bbox": list(rendered.bbox)})


@api_view(["GET"])
def ensemble_frame(request, filename: str, lead_minutes: int):
    forecast = _resolve_ensemble_step(filename, lead_minutes)
    rendered = render_probability_frame(forecast, lead_minutes)
    return _frame_png_response(rendered)


@api_view(["GET"])
def ensemble_frame_bbox(request, filename: str, lead_minutes: int):
    forecast = _resolve_ensemble_step(filename, lead_minutes)
    rendered = render_probability_frame(forecast, lead_minutes)
    return Response({"bbox": list(rendered.bbox)})


@api_view(["GET"])
def ensemble_expected_frame(request, filename: str, lead_minutes: int):
    forecast = _resolve_ensemble_step(filename, lead_minutes)
    rendered = render_expected_frame(forecast, lead_minutes)
    return _frame_png_response(rendered)


@api_view(["GET"])
def ensemble_expected_frame_bbox(request, filename: str, lead_minutes: int):
    forecast = _resolve_ensemble_step(filename, lead_minutes)
    rendered = render_expected_frame(forecast, lead_minutes)
    return Response({"bbox": list(rendered.bbox)})


@api_view(["GET"])
def radar_point(request):
    try:
        lat = float(request.query_params.get("lat", ""))
        lng = float(request.query_params.get("lng", ""))
    except (TypeError, ValueError):
        return Response(
            {"detail": "De queryparameters lat en lng zijn verplicht."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if not (-90 <= lat <= 90):
        return Response(
            {"detail": "lat moet tussen -90 en 90 liggen."},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if not (-180 <= lng <= 180):
        return Response(
            {"detail": "lng moet tussen -180 en 180 liggen."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    hours = int(request.query_params.get("hours", 24))
    return Response(build_point_series(lat, lng, hours=hours))
