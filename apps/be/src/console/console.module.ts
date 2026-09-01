import { Module } from '@dunx/core';
import { StaticModule } from '@dunx/http';
import { SpaFallback } from './spa-fallback.js';

/** A content hash, so a change produces a different URL. */
const HASHED = /\.[0-9a-zA-Z_-]{8,}\.(js|css)$/;

/**
 * The operator console, served by the panel itself.
 *
 * `apps/fe` builds straight into `public/`, so there is one deploy and no second
 * thing to host - which also means the console and the API share an origin, and
 * the session cookie needs no cross-site handling in production.
 *
 * `StaticModule` binds `StaticFiles` and `StaticOptions`; the app registers the
 * middleware in `main.ts`, because position in the chain is the app's call and
 * both of these have to sit outside the session guard - the sign-in page is the
 * one request whose whole purpose is to not have a session yet.
 */
@Module({
  imports: [
    StaticModule.forRoot({
      root: new URL('../../public', import.meta.url).pathname,
      path: '/',
      maxAge: 60,
      // Only honest for a content-addressed name: guessing wrong leaves a stale
      // asset nobody can flush. Vite emits `index-Cl8OnTAR.js`, so the hash is
      // the segment before the extension.
      immutable: (pathname) => HASHED.test(pathname),
    }),
  ],
  providers: [SpaFallback],
  exports: [SpaFallback],
})
export class ConsoleModule {}
