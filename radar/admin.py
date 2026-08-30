from django.contrib import admin

from radar.models import (
    EnsembleForecast,
    EnsembleForecastStep,
    RadarForecast,
    RadarForecastStep,
)


class RadarForecastStepInline(admin.TabularInline):
    model = RadarForecastStep
    extra = 0
    readonly_fields = ("image_name", "lead_minutes", "valid_at")
    can_delete = False


@admin.register(RadarForecast)
class RadarForecastAdmin(admin.ModelAdmin):
    list_display = (
        "filename",
        "issued_at",
        "status",
        "size",
        "downloaded_at",
    )
    list_filter = ("status",)
    search_fields = ("filename",)
    readonly_fields = (
        "filename",
        "issued_at",
        "knmi_created",
        "knmi_last_modified",
        "size",
        "file_path",
        "status",
        "error",
        "rows",
        "cols",
        "proj4",
        "downloaded_at",
    )
    inlines = [RadarForecastStepInline]


@admin.register(RadarForecastStep)
class RadarForecastStepAdmin(admin.ModelAdmin):
    list_display = ("forecast", "image_name", "lead_minutes", "valid_at")
    list_filter = ("lead_minutes",)
    search_fields = ("forecast__filename", "image_name")


class EnsembleForecastStepInline(admin.TabularInline):
    model = EnsembleForecastStep
    extra = 0
    readonly_fields = ("lead_minutes", "valid_at")
    can_delete = False


@admin.register(EnsembleForecast)
class EnsembleForecastAdmin(admin.ModelAdmin):
    list_display = (
        "filename",
        "issued_at",
        "status",
        "member_count",
        "size",
        "downloaded_at",
    )
    list_filter = ("status",)
    search_fields = ("filename",)
    readonly_fields = (
        "filename",
        "issued_at",
        "knmi_created",
        "knmi_last_modified",
        "size",
        "file_path",
        "status",
        "error",
        "rows",
        "cols",
        "proj4",
        "member_count",
        "downloaded_at",
    )
    inlines = [EnsembleForecastStepInline]


@admin.register(EnsembleForecastStep)
class EnsembleForecastStepAdmin(admin.ModelAdmin):
    list_display = ("forecast", "lead_minutes", "valid_at")
    list_filter = ("lead_minutes",)
    search_fields = ("forecast__filename",)
