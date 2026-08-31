/**
 * Pre-commit: run the repo's own lint + format scripts (a single source of
 * truth with CI / `bun run lint` / `bun run format`) rather than per-file
 * commands. The function ignores lint-staged's staged-file list so the scripts'
 * fixed targets are used — this avoids type-aware oxlint choking on files that
 * live outside the tsconfigs' `include` (e.g. `drizzle.config.ts`,
 * `vite.config.ts`) and keeps the hook identical to what CI runs.
 */
export default {
  '*': () => ['bun run lint', 'bun run format'],
};
