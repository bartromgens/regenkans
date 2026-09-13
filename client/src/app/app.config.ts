import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { TitleStrategy, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideMatomo, withRouter } from 'ngx-matomo-client';

import { routes } from './app.routes';
import { SeoTitleStrategy } from './seo';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    { provide: TitleStrategy, useClass: SeoTitleStrategy },
    provideHttpClient(),
    provideAnimationsAsync(),
    ...(environment.matomo.enabled
      ? [
          provideMatomo(
            {
              siteId: environment.matomo.siteId,
              trackerUrl: environment.matomo.trackerUrl,
            },
            withRouter(),
          ),
        ]
      : []),
  ],
};
