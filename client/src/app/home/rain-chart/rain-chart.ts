import {
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { PointSeriesPoint } from '../../radar/radar.service';

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Tooltip,
  Legend,
  Filler,
  annotationPlugin,
);

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_BEFORE_MS = 1 * HOUR_MS;
const DEFAULT_WINDOW_AFTER_MS = 2 * HOUR_MS;

interface IntensityBand {
  label: string;
  min: number;
  max: number | null;
  color: string;
}

// Hues follow the map colormap in radar/render.py so the chart and the map
// legend read as the same scale. Neighbouring bands need a clear hue step, not
// just a darker tint: at the default axis maximum only the lightest two are in
// view, so those two have to be told apart on their own.
const INTENSITY_BANDS: readonly IntensityBand[] = [
  { label: 'miezer', min: 0.1, max: 1, color: 'rgba(186, 230, 253, 0.55)' },
  { label: 'regen', min: 1, max: 5, color: 'rgba(96, 165, 250, 0.35)' },
  { label: 'flinke regen', min: 5, max: 10, color: 'rgba(167, 139, 250, 0.38)' },
  { label: 'stortregen', min: 10, max: 25, color: 'rgba(248, 113, 113, 0.38)' },
  { label: 'wolkbreuk', min: 25, max: null, color: 'rgba(251, 146, 60, 0.45)' },
];

const BAND_BORDER_COLOR = 'rgba(100, 116, 139, 0.35)';
const BAND_LABEL_MIN_HEIGHT_PX = 15;

@Component({
  selector: 'app-rain-chart',
  styleUrl: './rain-chart.scss',
  templateUrl: './rain-chart.html',
})
export class RainChart implements OnDestroy {
  private readonly destroyRef = inject(DestroyRef);
  private readonly chartCanvas = viewChild<ElementRef<HTMLCanvasElement>>('chartCanvas');
  private readonly clockMs = signal(Date.now());

  readonly series = input<PointSeriesPoint[]>([]);
  readonly selectedValidAt = input<string | null>(null);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly locationLabel = input('');

  readonly closed = output<void>();

  readonly extendedWindow = signal(false);

  readonly maxAvailableHours = computed(() => {
    const points = this.series();
    const nowMs = this.clockMs();
    const maxProbabilityMs = resolveMaxProbabilityMs(points);
    if (maxProbabilityMs === null) {
      return null;
    }

    const hoursAhead = (maxProbabilityMs - nowMs) / HOUR_MS;
    if (hoursAhead <= DEFAULT_WINDOW_AFTER_MS / HOUR_MS + 0.25) {
      return null;
    }

    return Math.ceil(hoursAhead);
  });

  private chart: Chart | null = null;

  constructor() {
    const intervalId = window.setInterval(() => this.clockMs.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => window.clearInterval(intervalId));

    afterRenderEffect(() => {
      this.series();
      this.selectedValidAt();
      this.loading();
      this.error();
      this.clockMs();
      this.extendedWindow();
      this.renderChart();
    });
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  close(): void {
    this.closed.emit();
  }

  setWindow(extended: boolean): void {
    this.extendedWindow.set(extended);
  }

  private renderChart(): void {
    const points = this.series();
    const canvas = this.chartCanvas()?.nativeElement;
    if (!canvas || this.loading() || this.error() || points.length === 0) {
      this.chart?.destroy();
      this.chart = null;
      return;
    }

    this.chart?.destroy();

    const nowMs = this.clockMs();
    const minMs = nowMs - WINDOW_BEFORE_MS;
    const maxProbabilityMs = resolveMaxProbabilityMs(points);
    const maxMs =
      this.extendedWindow() && maxProbabilityMs !== null
        ? Math.max(maxProbabilityMs, nowMs + DEFAULT_WINDOW_AFTER_MS)
        : nowMs + DEFAULT_WINDOW_AFTER_MS;
    const windowed = points.filter((point) => {
      const timeMs = new Date(point.valid_at).getTime();
      return timeMs >= minMs && timeMs <= maxMs;
    });

    const intensityData = toChartPoints(windowed, (point) => point.intensity);
    const expectedData = toChartPoints(windowed, (point) => point.expected);
    const probabilityData = toChartPoints(windowed, (point) =>
      point.probability === null ? null : point.probability * 100,
    );

    const selectedMs = this.resolveSelectedMs(this.selectedValidAt(), minMs, maxMs);

    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Intensiteit (mm/u)',
            data: intensityData,
            borderColor: '#1d4ed8',
            backgroundColor: 'rgba(29, 78, 216, 0.08)',
            yAxisID: 'y',
            tension: 0.25,
            pointRadius: 0,
            pointHitRadius: 8,
            spanGaps: false,
          },
          {
            label: 'Verwacht (mm/u)',
            data: expectedData,
            borderColor: '#059669',
            backgroundColor: 'rgba(5, 150, 105, 0.08)',
            yAxisID: 'y',
            tension: 0.25,
            pointRadius: 0,
            pointHitRadius: 8,
            spanGaps: true,
            borderDash: [5, 3],
          },
          {
            label: 'Kans (%)',
            data: probabilityData,
            borderColor: '#c2410c',
            backgroundColor: 'rgba(194, 65, 12, 0.08)',
            yAxisID: 'y1',
            tension: 0.25,
            pointRadius: 0,
            pointHitRadius: 8,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: {
          padding: {
            top: 22,
          },
        },
        interaction: {
          mode: 'nearest',
          axis: 'x',
          intersect: false,
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 12,
              boxHeight: 2,
              usePointStyle: false,
            },
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                const timeMs = items[0]?.parsed.x;
                if (timeMs == null) {
                  return '';
                }
                return formatChartTime(timeMs, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                });
              },
              label: (context) => {
                const value = context.parsed.y;
                if (value === null || Number.isNaN(value)) {
                  return `${context.dataset.label}: —`;
                }
                if (context.dataset.yAxisID === 'y1') {
                  return `${context.dataset.label}: ${value.toFixed(0)}%`;
                }
                return `${context.dataset.label}: ${value.toFixed(2)} mm/u`;
              },
            },
          },
          annotation: buildAnnotations(selectedMs, nowMs),
        },
        scales: {
          x: {
            type: 'linear',
            min: minMs,
            max: maxMs,
            grid: {
              display: false,
            },
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 7,
              callback: (value) => formatChartTime(Number(value), {
                hour: '2-digit',
                minute: '2-digit',
              }),
            },
          },
          y: {
            type: 'linear',
            position: 'left',
            title: {
              display: true,
              text: 'mm/u',
            },
            beginAtZero: true,
            suggestedMax: 2.5,
          },
          y1: {
            type: 'linear',
            position: 'right',
            title: {
              display: true,
              text: '%',
            },
            min: 0,
            max: 100,
            grid: {
              drawOnChartArea: false,
            },
          },
        },
      },
    });
  }

  private resolveSelectedMs(
    selectedValidAt: string | null,
    minMs: number,
    maxMs: number,
  ): number | null {
    if (!selectedValidAt) {
      return null;
    }

    const selectedMs = new Date(selectedValidAt).getTime();
    if (!Number.isFinite(selectedMs) || selectedMs < minMs || selectedMs > maxMs) {
      return null;
    }
    return selectedMs;
  }
}

function resolveMaxProbabilityMs(points: PointSeriesPoint[]): number | null {
  let maxMs: number | null = null;
  for (const point of points) {
    if (point.probability === null) {
      continue;
    }
    const timeMs = new Date(point.valid_at).getTime();
    if (maxMs === null || timeMs > maxMs) {
      maxMs = timeMs;
    }
  }
  return maxMs;
}

function toChartPoints(
  points: PointSeriesPoint[],
  valueOf: (point: PointSeriesPoint) => number | null,
): { x: number; y: number | null }[] {
  return points.map((point) => ({
    x: new Date(point.valid_at).getTime(),
    y: valueOf(point),
  }));
}

function formatChartTime(
  timeMs: number,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    ...options,
  }).format(new Date(timeMs));
}

function buildIntensityBands() {
  return Object.fromEntries(
    INTENSITY_BANDS.map(
      (band, index) =>
        [
          `intensityBand${index}`,
          {
            type: 'box' as const,
            yScaleID: 'y',
            // Annotations are drawn unclipped so the "Nu" label can sit above
            // the plot, which means a band reaching past the axis maximum would
            // paint over it. Clamping keeps every band inside the plot area.
            yMin: (ctx: { chart: Chart }) => clampToAxis(ctx.chart, band.min),
            yMax: (ctx: { chart: Chart }) => clampToAxis(ctx.chart, band.max),
            adjustScaleRange: false,
            backgroundColor: band.color,
            borderColor: BAND_BORDER_COLOR,
            // A band above the axis maximum collapses onto it, where a border
            // would leave a stray line along the top of the plot.
            borderWidth: (ctx: { chart: Chart }) =>
              bandHeightPx(ctx.chart, band) < 1 ? 0 : 1,
            drawTime: 'beforeDatasetsDraw' as const,
            label: {
              display: (ctx: { chart: Chart }) =>
                bandHeightPx(ctx.chart, band) >= BAND_LABEL_MIN_HEIGHT_PX,
              content: band.label,
              position: {
                x: 'start' as const,
                y: 'center' as const,
              },
              xAdjust: 6,
              color: '#64748b',
              font: {
                size: 10,
              },
            },
          },
        ] as const,
    ),
  );
}

function clampToAxis(chart: Chart, value: number | null): number {
  const axisMax = chart.scales['y']?.max ?? 0;
  return value === null ? axisMax : Math.min(value, axisMax);
}

function bandHeightPx(chart: Chart, band: IntensityBand): number {
  const axis = chart.scales['y'];
  if (!axis) {
    return 0;
  }
  const top = axis.getPixelForValue(clampToAxis(chart, band.max));
  const bottom = axis.getPixelForValue(clampToAxis(chart, band.min));
  return bottom - top;
}

function buildAnnotations(
  selectedMs: number | null,
  nowMs: number | null,
) {
  return {
    clip: false,
    annotations: {
      ...buildIntensityBands(),
      ...(nowMs === null
        ? {}
        : {
            nowTime: {
              type: 'line' as const,
              xMin: nowMs,
              xMax: nowMs,
              borderColor: '#16a34a',
              borderWidth: 2,
            },
            nowLabel: {
              type: 'label' as const,
              xValue: nowMs,
              xScaleID: 'x',
              yValue: (ctx: { chart: Chart }) => ctx.chart.scales['y']?.max ?? 0,
              yScaleID: 'y',
              content: 'Nu',
              position: {
                x: 'center' as const,
                y: 'end' as const,
              },
              yAdjust: -4,
              backgroundColor: '#16a34a',
              color: '#ffffff',
              borderRadius: 4,
              font: {
                size: 10,
                weight: 600,
              },
              padding: {
                x: 6,
                y: 2,
              },
            },
          }),
      ...(selectedMs === null
        ? {}
        : {
            selectedTime: {
              type: 'line' as const,
              xMin: selectedMs,
              xMax: selectedMs,
              borderColor: '#64748b',
              borderWidth: 1,
              borderDash: [4, 4],
            },
          }),
    },
  };
}
