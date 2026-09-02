from django.db import models


class RadarForecast(models.Model):
    class Status(models.TextChoices):
        DOWNLOADED = "downloaded", "Gedownload"
        PARSED = "parsed", "Verwerkt"
        FAILED = "failed", "Mislukt"

    filename = models.CharField(max_length=255, unique=True)
    issued_at = models.DateTimeField(db_index=True)
    knmi_created = models.DateTimeField(null=True, blank=True)
    knmi_last_modified = models.DateTimeField(null=True, blank=True)
    size = models.PositiveIntegerField(null=True, blank=True)
    file_path = models.CharField(max_length=512)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.DOWNLOADED,
    )
    error = models.TextField(blank=True)
    rows = models.PositiveIntegerField(null=True, blank=True)
    cols = models.PositiveIntegerField(null=True, blank=True)
    proj4 = models.TextField(blank=True)
    downloaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-issued_at"]

    def __str__(self) -> str:
        return self.filename


class RadarForecastStep(models.Model):
    forecast = models.ForeignKey(
        RadarForecast,
        on_delete=models.CASCADE,
        related_name="steps",
    )
    image_name = models.CharField(max_length=32)
    lead_minutes = models.PositiveSmallIntegerField()
    valid_at = models.DateTimeField()

    class Meta:
        ordering = ["lead_minutes"]
        constraints = [
            models.UniqueConstraint(
                fields=["forecast", "lead_minutes"],
                name="unique_forecast_lead_minutes",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.forecast.filename} +{self.lead_minutes}m"


class EnsembleForecast(models.Model):
    class Status(models.TextChoices):
        DOWNLOADED = "downloaded", "Gedownload"
        PARSED = "parsed", "Verwerkt"
        FAILED = "failed", "Mislukt"

    filename = models.CharField(max_length=255, unique=True)
    issued_at = models.DateTimeField(db_index=True)
    knmi_created = models.DateTimeField(null=True, blank=True)
    knmi_last_modified = models.DateTimeField(null=True, blank=True)
    size = models.PositiveBigIntegerField(null=True, blank=True)
    file_path = models.CharField(max_length=512)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.DOWNLOADED,
    )
    error = models.TextField(blank=True)
    rows = models.PositiveIntegerField(null=True, blank=True)
    cols = models.PositiveIntegerField(null=True, blank=True)
    proj4 = models.TextField(blank=True)
    member_count = models.PositiveSmallIntegerField(null=True, blank=True)
    downloaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-issued_at"]

    def __str__(self) -> str:
        return self.filename


class EnsembleForecastStep(models.Model):
    forecast = models.ForeignKey(
        EnsembleForecast,
        on_delete=models.CASCADE,
        related_name="steps",
    )
    lead_minutes = models.PositiveSmallIntegerField()
    valid_at = models.DateTimeField()

    class Meta:
        ordering = ["lead_minutes"]
        constraints = [
            models.UniqueConstraint(
                fields=["forecast", "lead_minutes"],
                name="unique_ensemble_forecast_lead_minutes",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.forecast.filename} +{self.lead_minutes}m"
