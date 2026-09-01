import { createTheme } from '@mantine/core';

/**
 * The console's look, mirrored from `landbased-panel`: indigo primary, soft
 * radius, Inter, slightly heavier headings. One place, so a screen added later
 * inherits it rather than restating it.
 */
export const theme = createTheme({
  primaryColor: 'indigo',
  defaultRadius: 'md',
  fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  headings: { fontWeight: '650' },
});
