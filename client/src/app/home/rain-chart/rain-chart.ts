import {
  Component,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  input,
  output,
  viewChild,
} from '@angular/core';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
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
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
  annotationPlugin,
);

@Component({
  selector: 'app-rain-chart',
  styleUrl: './rain-chart.scss',
  templateUrl: './rain-chart.html',
})
export class RainChart implements OnDestroy {
  private readonly chartCanvas = viewChild<ElementRef<HTMLCanvasElement>>('chartCanvas');

  readonly series = input<PointSeriesPoint[]>([]);
  readonly selectedValidAt = input<string | null>(null);
  readonly loading = input(false);
  readonly error = input<string | null>(null);
  readonly locationLabel = input('');

  readonly closed = output<void>();

  private chart: Chart | null = null;

  constructor() {
    afterRenderEffect(() => {
      this.series();
      this.selectedValidAt();
      this.loading();
      this.error();
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

    const labels = points.map((point) =>
      new Intl.DateTimeFormat('nl-NL', {
        timeZone: 'Europe/Amsterdam',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(point.valid_at)),
    );

    const intensityData = points.map((point) => point.intensity);
    const expectedData = points.map((point) => point.expected);
    const probabilityData = points.map((point) =>
      point.probability === null ? null : point.probability * 100,
    );

    const selectedIndex = this.resolveSelectedIndex(points, this.selectedValidAt());

    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
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
            label: 'Expected rain (mm/h)',
            data: expectedData,
            borderColor: '#7c3aed',
            backgroundColor: 'rgba(124, 58, 237, 0.08)',
            yAxisID: 'y',
            tension: 0.25,
            pointRadius: 0,
            pointHitRadius: 8,
            spanGaps: true,
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
        interaction: {
          mode: 'index',
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
                const index = items[0]?.dataIndex ?? 0;
                const point = points[index];
                if (!point) {
                  return '';
                }
                return new Intl.DateTimeFormat('nl-NL', {
                  timeZone: 'Europe/Amsterdam',
                  weekday: 'short',
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                }).format(new Date(point.valid_at));
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
          annotation: selectedIndex === null
            ? undefined
            : {
                annotations: {
                  selectedTime: {
                    type: 'line',
                    xMin: selectedIndex,
                    xMax: selectedIndex,
                    borderColor: '#64748b',
                    borderWidth: 1,
                    borderDash: [4, 4],
                  },
                },
              },
        },
        scales: {
          x: {
            grid: {
              display: false,
            },
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
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

  private resolveSelectedIndex(
    points: PointSeriesPoint[],
    selectedValidAt: string | null,
  ): number | null {
    if (!selectedValidAt || points.length === 0) {
      return null;
    }

    const index = points.findIndex((point) => point.valid_at === selectedValidAt);
    return index >= 0 ? index : null;
  }
}
