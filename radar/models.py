from django.db import models
from django.utils import timezone


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


class EnsembleIngestState(models.Model):
    """Outcome of the most recent attempt to fetch KNMI's latest ensemble file."""

    SINGLETON_PK = 1

    finished_at = models.DateTimeField()
    success = models.BooleanField()
    error = models.TextField(blank=True)

    class Meta:
        verbose_name = "Ensemble-ingeststatus"
        verbose_name_plural = "Ensemble-ingeststatus"

    def __str__(self) -> str:
        status = "geslaagd" if self.success else "mislukt"
        return f"Laatste ensemble-ingest ({status})"

    @classmethod
    def record(cls, *, success: bool, error: str = "") -> None:
        cls.objects.update_or_create(
            pk=cls.SINGLETON_PK,
            defaults={
                "finished_at": timezone.now(),
                "success": success,
                "error": error,
            },
        )

    @classmethod
    def last_latest_ingest_succeeded(cls) -> bool:
        row = cls.objects.filter(pk=cls.SINGLETON_PK).first()
        return bool(row and row.success)
