import {
  HttpOptionsProvider,
  type CorsOptions,
  type RequestLoggingOptions,
} from '@dunx/http';
import { AppConfigService } from '../config.js';

/**
 * The HTTP settings that come from validated config, answered from the container
 * rather than computed before it exists.
 *
 * `main.ts` would otherwise open with `const log = validate(Bun.env).log`,
 * because `HttpFactory.create(root, options)` builds the container and so its
 * argument has to be ready first. That is a second call to `validate` on a second
 * copy of the environment, invisible to `ConfigModule`. This class injects
 * `AppConfigService` like anything else.
 */
export class AppHttpOptions extends HttpOptionsProvider {
  constructor(private readonly config: AppConfigService) {
    super();
    this.trustProxy = this.config.get('trustProxy');
  }

  /**
   * A field on the base, so a field here (TS2611 rejects an accessor), assigned
   * in the constructor, which is how a field derives from config.
   *
   * It decides more in this app than in most. A deployment grant is bound to the
   * address it was minted for, and `ClientAddress` is what reads that address -
   * so behind a proxy with this off, every agent appears to arrive from the proxy
   * and no grant can ever be honoured.
   */
  override readonly trustProxy: boolean;

  override get prefix(): string {
    return 'api';
  }

  override get cors(): CorsOptions {
    return {
      origin: this.config.get('corsOrigin'),
      // The console authenticates with a session cookie, so the browser has to
      // be allowed to send it cross-origin during development.
      credentials: true,
      exposedHeaders: ['x-handled-by'],
      maxAge: 600,
    };
  }

  /**
   * A miss answers 404 rather than the session guard's 401.
   *
   * dunx defaults to `'guarded'` to stop route enumeration. This app serves a
   * SPA, and `SpaFallback` has to be able to tell an unmatched navigation from a
   * refusal - a guarded miss would turn every deep link into a 401 before the
   * fallback ever ran.
   */
  override readonly notFound = 'public';

  override get requestLogging(): RequestLoggingOptions {
    const log = this.config.get('log');
    return {
      // Off by default: both cost a `req.clone().text()` on the hot path, and a
      // fleet reporting every 30s makes that the hot path.
      requestBody: log.requestBody,
      responseBody: log.responseBody,
      // The dashboard polls every five seconds and would bury everything else.
      ignorePrefix: ['/api/_dunx'],
      // ~360 ns per request, so off by default. On here so `traceId` joins
      // `requestId` and one agent's report is followable across the log.
      trace: true,
    };
  }
}
