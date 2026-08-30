from django.urls import path

from . import views

urlpatterns = [
    path("health/", views.health_check, name="health-check"),
    path("radar/timeline/", views.radar_timeline, name="radar-timeline"),
    path(
        "radar/frames/<str:filename>/<int:lead_minutes>.png",
        views.radar_frame,
        name="radar-frame",
    ),
]
