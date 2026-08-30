from django.http import FileResponse, Http404
from django.utils.http import http_date
from rest_framework.decorators import api_view
from rest_framework.response import Response

from radar.models import EnsembleForecast, RadarForecast
from radar.probability import render_probability_frame
from radar.render import render_forecast_frame
from radar.timeline import serialize_probability_timeline, serialize_timeline


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
    forecast = RadarForecast.objects.filter(
        filename=filename,
        status=RadarForecast.Status.PARSED,
    ).first()
    if forecast is None:
        raise Http404("Forecast not found")

    if not forecast.steps.filter(lead_minutes=lead_minutes).exists():
        raise Http404("Forecast step not found")

    try:
        rendered = render_forecast_frame(forecast, lead_minutes)
    except (ValueError, OSError) as exc:
        raise Http404(str(exc)) from exc

    west, south, east, north = rendered.bbox
    response = FileResponse(rendered.path.open("rb"), content_type="image/png")
    response["Cache-Control"] = "public, max-age=300"
    response["X-Radar-BBox"] = f"{west},{south},{east},{north}"
    response["Access-Control-Expose-Headers"] = "X-Radar-BBox"
    response["Last-Modified"] = http_date(rendered.path.stat().st_mtime)
    return response


@api_view(["GET"])
def ensemble_frame(request, filename: str, lead_minutes: int):
    forecast = EnsembleForecast.objects.filter(
        filename=filename,
        status=EnsembleForecast.Status.PARSED,
    ).first()
    if forecast is None:
        raise Http404("Ensemble forecast not found")

    if not forecast.steps.filter(lead_minutes=lead_minutes).exists():
        raise Http404("Ensemble forecast step not found")

    rendered = render_probability_frame(forecast, lead_minutes)

    west, south, east, north = rendered.bbox
    response = FileResponse(rendered.path.open("rb"), content_type="image/png")
    response["Cache-Control"] = "public, max-age=300"
    response["X-Radar-BBox"] = f"{west},{south},{east},{north}"
    response["Access-Control-Expose-Headers"] = "X-Radar-BBox"
    response["Last-Modified"] = http_date(rendered.path.stat().st_mtime)
    return response
