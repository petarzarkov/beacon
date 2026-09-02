/**
 * Every query key in one place, so an invalidation names the same tuple the
 * query registered under. A typo here is a cache that never refreshes, which is
 * the quietest kind of bug a live console can have.
 */
export const keys = {
  session: ['session'] as const,
  agents: ['agents'] as const,
  commands: ['commands'] as const,
  discovered: ['discovered'] as const,
  release: ['release'] as const,
  settings: ['settings'] as const,
  library: ['library'] as const,
  alerts: ['alerts'] as const,
  alertRules: ['alert-rules'] as const,
  schedules: ['schedules'] as const,
};
