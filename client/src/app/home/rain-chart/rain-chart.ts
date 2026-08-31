import {
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
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
const WINDOW_AFTER_MS = 2 * HOUR_MS;

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
      this.renderChart();
    });
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  close(): void {
    this.closed.emit();
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
    const maxMs = nowMs + WINDOW_AFTER_MS;
    const windowed = points.filter((point) => {
      const timeMs = new Date(point.valid_at).getTime();
      return timeMs >= minMs && timeMs <= maxMs;
    });

    const intensityData = toChartPoints(windowed, (point) => point.intensity);
    const probabilityData = toChartPoints(windowed, (point) =>
      point.probability === null ? null : point.probability * 100,
    );

    const selectedMs = this.resolveSelectedMs(this.selectedValidAt(), minMs, maxMs);

    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Intensity (mm/h)',
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
            label: 'Probability (%)',
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
                return `${context.dataset.label}: ${value.toFixed(2)} mm/h`;
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
              text: 'mm/h',
            },
            beginAtZero: true,
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

function buildAnnotations(
  selectedMs: number | null,
  nowMs: number | null,
) {
  return {
    clip: false,
    annotations: {
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
              content: 'Now',
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
