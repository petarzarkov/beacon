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

/** A coarse, human duration for an uptime in seconds. */
export const duration = (seconds: number | null): string => {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** How much memory is in use, as a fraction, or null when the agent has not reported. */
export const memoryUsed = (
  total: number | null,
  free: number | null,
): number | null => {
  if (total === null || free === null || total === 0) return null;
  return (total - free) / total;
};
