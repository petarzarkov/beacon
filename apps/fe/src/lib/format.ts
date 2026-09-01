/** Small, dependency-free formatters shared across the console. */

export const relativeTime = (iso: string | null): string => {
  if (iso === null) return 'never';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

export const bytes = (value: number | null): string => {
  if (value === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
};

/** How much memory is in use, as a fraction, or null when the agent has not reported. */
export const memoryUsed = (
  total: number | null,
  free: number | null,
): number | null => {
  if (total === null || free === null || total === 0) return null;
  return (total - free) / total;
};
