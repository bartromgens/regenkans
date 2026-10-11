const AMSTERDAM: Intl.DateTimeFormatOptions = {
  timeZone: 'Europe/Amsterdam',
};

export function formatAmsterdamTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return new Intl.DateTimeFormat('nl-NL', {
    ...AMSTERDAM,
    ...options,
  }).format(date);
}
