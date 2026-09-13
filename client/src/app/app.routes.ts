import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Regenkans – regenradar met kans op regen',
    data: {
      description:
        'Regenradar voor Nederland met de kans op regen, op basis van KNMI-data. Zie waar het regent, hoe hard en hoe zeker het is. Zonder reclame of account.',
    },
    loadComponent: () => import('./home/home').then((m) => m.Home),
  },
  {
    path: 'over',
    title: 'Over Regenkans – alternatief voor Buienradar',
    data: {
      description:
        'Regenkans is een reclamevrije regenradar voor Nederland. Wat de kaart laat zien, welke KNMI-data wordt gebruikt en hoe de kans op regen wordt berekend.',
    },
    loadComponent: () => import('./about/about').then((m) => m.About),
  },
];
