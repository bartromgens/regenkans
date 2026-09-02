from django.urls import path

from . import views

urlpatterns = [
    path("health/", views.health_check, name="health-check"),
    path("radar/timeline/", views.radar_timeline, name="radar-timeline"),
    path("ensemble/timeline/", views.ensemble_timeline, name="ensemble-timeline"),
    path(
        "radar/frames/<str:filename>/<int:lead_minutes>.png",
        views.radar_frame,
        name="radar-frame",
    ),
    path(
        "ensemble/frames/<str:filename>/<int:lead_minutes>.png",
        views.ensemble_frame,
        name="ensemble-frame",
    ),
    path(
        "ensemble/expected/frames/<str:filename>/<int:lead_minutes>.png",
        views.ensemble_expected_frame,
        name="ensemble-expected-frame",
    ),
    path("radar/point/", views.radar_point, name="radar-point"),
]
