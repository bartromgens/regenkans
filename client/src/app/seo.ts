import { DOCUMENT, Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRouteSnapshot, RouterStateSnapshot, TitleStrategy } from '@angular/router';

export const SITE_URL = 'https://regenkans.nl';

const FALLBACK_TITLE = 'Regenkans – regenradar met kans op regen';
const FALLBACK_DESCRIPTION =
  'Regenradar voor Nederland met de kans op regen, op basis van KNMI-data. Zie waar het regent, hoe hard en hoe zeker het is. Zonder reclame of account.';

/**
 * Keeps the title, meta description and canonical URL in sync with the active
 * route. Routes supply `title` and `data.description`; the values in
 * `index.html` are the fallback for anything that does not.
 */
@Injectable()
export class SeoTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  override updateTitle(state: RouterStateSnapshot): void {
    const title = this.buildTitle(state) ?? FALLBACK_TITLE;
    const description = deepest(state.root).data['description'] ?? FALLBACK_DESCRIPTION;
    const url = SITE_URL + state.url.split(/[?#]/)[0];

    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:url', content: url });
    this.meta.updateTag({ name: 'twitter:title', content: title });
    this.meta.updateTag({ name: 'twitter:description', content: description });
    this.setCanonical(url);
  }

  private setCanonical(url: string): void {
    let link = this.document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.rel = 'canonical';
      this.document.head.appendChild(link);
    }
    link.href = url;
  }
}

function deepest(route: ActivatedRouteSnapshot): ActivatedRouteSnapshot {
  return route.firstChild ? deepest(route.firstChild) : route;
}
