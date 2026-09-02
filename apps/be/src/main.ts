import { Auth, betterAuthDocument } from '@dunx/auth';
import { Logger } from '@dunx/core';
import {
  Compression,
  HttpFactory,
  StaticFiles,
  type HttpApp,
} from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config.js';
import { SpaFallback } from './console/spa-fallback.js';
import { RequestTrailMiddleware } from './http/request-trail.js';

/**
 * One app for `bun run start`, `bun run dev` and the tests, and one file:
 * `createApp` is exported for a caller that wants the shape without a server, and
 * the block at the bottom serves it when this file is the entry point.
 *
 * `create()` boots the container and discovers routes; `listen()` is what builds
 * the `Bun.serve` route table. Everything between the two still gets to shape it,
 * and after `listen()` every one of those throws.
 */
export const createApp = async (): Promise<HttpApp> => {
  const app = await HttpFactory.create(
    OpenApiModule.forRootAsync({
      root: AppModule,
      inject: [Auth] as const,
      useFactory: (auth: Auth) => ({
        title: 'beacon-be',
        version: '0.1.0',
        description:
          'The control plane. `/api/agent` is the protocol agents speak; ' +
          '`/api/agents` is what the console asks. The panel never dials an agent.',
        contribute: [
          betterAuthDocument(auth, { basePath: '/api/auth', tag: 'Auth' }),
        ],
      }),
    }),
  );

  /**
   * Order is the design here.
   *
   * `Compression` outermost, so it sees whatever the chain below produces.
   * `StaticFiles` next and `SpaFallback` after it - an existing file wins over
   * the rewrite, and the fallback only ever fires on a route-table miss. Both sit
   * ahead of anything that authenticates, because the sign-in page is the one
   * request whose whole purpose is to not have a session yet.
   *
   * There is no global session guard: `FleetController` carries
   * `@UseGuards(SessionGuard)` itself, and `AgentController` must never see it -
   * an agent has a token and no browser session.
   */
  app.use(Compression);
  app.use(StaticFiles);
  app.use(SpaFallback);
  app.use(RequestTrailMiddleware);

  return app;
};

const start = async (): Promise<void> => {
  const app = await createApp();
  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);
  const url = await app.listen(config.get('port'));

  logger.info(`listening on ${url}`);
  logger.info(`console ${url}`);
  logger.info(`docs    ${new URL('api/docs', url).href}`);
  logger.info(`health  ${new URL('api/health/ready', url).href}`);

  // The one thing worth refusing to be quiet about. With no enrolment token set
  // no host can ever join the fleet, and the failure surfaces on the agent as a
  // 403 rather than here - so say it here, at boot, where an operator is looking.
  if (config.get('agents').enrolmentToken === '') {
    logger.warn(
      'AGENT_ENROLMENT_TOKEN is unset: no agent can enrol. Generate one with `openssl rand -hex 32`.',
    );
  }

  // Nothing else to do: the server holds the process open, and the shutdown hooks
  // resolve this once a signal arrives.
  await app.closed;
};

// False when a test imports this file for `createApp` alone, which is what lets one
// module be both the entry point and the app's definition.
if (import.meta.main) {
  start().catch((error: unknown) => {
    console.error('failed to start', error);
    process.exit(1);
  });
}
