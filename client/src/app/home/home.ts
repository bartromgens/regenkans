import { Component, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

interface HealthResponse {
  status: string;
}

@Component({
  imports: [MatCardModule, MatProgressSpinnerModule],
  selector: 'app-home',
  styles: `
    mat-card {
      max-width: 400px;
      margin: 2rem;
    }
  `,
  templateUrl: './home.html',
})
export class Home implements OnInit {
  private readonly http = inject(HttpClient);

  protected readonly healthStatus = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.http.get<HealthResponse>('/api/health/').subscribe({
      next: (response) => {
        this.healthStatus.set(response.status);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Unable to reach the API');
        this.loading.set(false);
      },
    });
  }
}
