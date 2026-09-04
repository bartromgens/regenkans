import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./home/home').then((m) => m.Home) },
  { path: 'over', loadComponent: () => import('./about/about').then((m) => m.About) },
];
