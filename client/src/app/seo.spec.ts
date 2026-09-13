import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { RouterStateSnapshot } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { SeoTitleStrategy } from './seo';

function makeState(url: string, title: string | undefined, description?: string) {
  return {
    url,
    root: { data: {}, firstChild: { data: description ? { description } : {}, firstChild: null } },
    // buildTitle() reads this internal field on the deepest route.
    __title: title,
  } as unknown as RouterStateSnapshot;
}

describe('SeoTitleStrategy', () => {
  let strategy: SeoTitleStrategy;
  let meta: Meta;
  let title: Title;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [SeoTitleStrategy] });
    strategy = TestBed.inject(SeoTitleStrategy);
    meta = TestBed.inject(Meta);
    title = TestBed.inject(Title);
    document.head.querySelector('link[rel="canonical"]')?.remove();
  });

  function canonical() {
    return document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  }

  it('applies the route title, description and canonical URL', () => {
    const state = makeState('/over', undefined, 'Over de radar');
    // buildTitle() resolves through the router internals, so stub it directly.
    (strategy as unknown as { buildTitle: () => string }).buildTitle = () => 'Over Regenkans';

    strategy.updateTitle(state);

    expect(title.getTitle()).toBe('Over Regenkans');
    expect(meta.getTag('name="description"')?.content).toBe('Over de radar');
    expect(meta.getTag('property="og:url"')?.content).toBe('https://regenkans.nl/over');
    expect(canonical()).toBe('https://regenkans.nl/over');
  });

  it('falls back to the site defaults when the route supplies nothing', () => {
    const state = makeState('/', undefined);
    (strategy as unknown as { buildTitle: () => undefined }).buildTitle = () => undefined;

    strategy.updateTitle(state);

    expect(title.getTitle()).toContain('Regenkans');
    expect(meta.getTag('name="description"')?.content).toContain('kans op regen');
    expect(canonical()).toBe('https://regenkans.nl/');
  });

  it('strips query strings and fragments from the canonical URL', () => {
    const state = makeState('/over?utm_source=x#top', undefined);
    (strategy as unknown as { buildTitle: () => string }).buildTitle = () => 'Over Regenkans';

    strategy.updateTitle(state);

    expect(canonical()).toBe('https://regenkans.nl/over');
  });
});
