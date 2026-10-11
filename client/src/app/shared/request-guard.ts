export function createLatestRequestGuard(): {
  next(): number;
  isCurrent(token: number): boolean;
} {
  let latest = 0;
  return {
    next(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
  };
}
