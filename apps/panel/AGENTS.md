# dunxon-panel

Notes for an agent working in this application. It is a
[dunx](https://github.com/petarzarkov/dunx) app, scaffolded by
`bunx @dunx/create-app`.

## Commands

```bash
bun install
bun run dev          # http://localhost:3000, restarting on a change
bun run start
bun test
bun run typecheck
```

**There is no worker command.** `QueueModule` is given `consume: true`, so the
container opens the workers at `onInit` and closes them before the connections they
use. A handler marked `background: true` is forked by bullmq into
`src/jobs/jobs.processor.ts`, which nobody runs by hand.

## Layout

- `src/main.ts` - exports `createApp`, and serves it when run directly
- `src/app.module.ts` - the root module, importing every feature
- `src/config.ts` - one validation function, flat env in and a shaped object out
- `src/docs/` - openapi
- `src/http/` - http
- `src/guards/` - guards
- `src/database/` - database
- `src/users/` - users
- `src/auth/` - auth
- `src/cache/` - cache
- `src/chat/` - websockets
- `src/pictures/` - images
- `src/jobs/` - jobs
- `src/storage/` - files
- `src/health/` - health
- `src/schedule/` - schedule
- `src/assets/` - assets
- `src/upstream/` - client
- `bunfig.toml` - the preload line constructor injection needs

`main.ts`, `app.module.ts` and `config.ts` were generated for the features chosen
at scaffold time. Everything else was copied from dunx's `examples/full`. The
`*.demo.ts` files are that example's scripted walkthroughs; delete one and its
`providers` entry to drop it.

A test imports `createApp` from `./main.js`; the `import.meta.main` block at the
bottom is what stops that starting a server.

## What is wired up

- **openapi** - OpenAPI 3.1 from the routes own schemas, plus the Swagger UI page.
- **http** - CORS, a middleware of your own on the response, and error mapping.
- **guards** - Route guards with @Roles and @Public, and a protected controller.
- **database** - drizzle over bun:sqlite, with a schema, seeds and migrations.
- **users** - A repository, a service and validated routes over the database.
- **auth** - better-auth mounted, with SessionGuard and an audit trail.
- **cache** - Bun.RedisClient behind a session store, degrading when absent.
- **websockets** - A @Gateway with @OnMessage events, PubSub and a Redis relay.
- **images** - Bun.Image resizing and format conversion behind a route.
- **jobs** - bullmq queues over Bun.RedisClient, background handlers forked.
- **files** - Uploads and downloads on Bun.file, with a workspace root.
- **health** - `HealthModule`'s liveness and readiness probes, wired to this app's own indicators.
- **schedule** - @Cron, @Interval and @OnceOnBoot on Bun.cron, armed at boot and triggerable.
- **assets** - A static directory on Bun.file, with a short max-age and an immutable rule.
- **client** - The outbound half of @dunx/http: retry, backoff and a typed FetchError.

## Services

Each of these reports itself degraded rather than failing the boot, so the app
starts without them.

- **cache** needs Redis or Valkey
- **websockets** needs Redis or Valkey, for multi-node fan-out only
- **jobs** needs Redis or Valkey

## Rules that produce a boot error when broken

- **No `@Injectable()`, no `@Inject()`.** Listing a class in a module's
  `providers` is what makes it injectable. dunx uses TC39 standard decorators,
  which have no parameter decorators. For a value with no constructor parameter to
  hang off, use `inject(Token)` in a field initializer.
- **Do not add `reflect-metadata`, `experimentalDecorators` or
  `emitDecoratorMetadata`.** `bunfig.toml` preloads `@dunx/transform`, which
  records each class's constructor parameter types. Removing that line makes every
  provider fail at boot.
- **A constructor parameter whose type is erased fails at boot, naming the
  parameter.** An interface, a primitive, a union, a class type parameter, or a
  `import type` at an injection site all record as `unresolved`. Inject a class,
  and drop `type` from the import.
- **Relative imports carry `.js`**: `'./users.service.js'`, never
  `'./users.service'`.
- **A module's `exports` is its public surface.** The container is scoped per
  module, so a provider another module injects has to be exported by the module that
  declares it.
- **`bun` only.** No `npm`, `npx`, `yarn` or `pnpm`; run tools with `bunx`.

## Reading this app instead of grepping it

```bash
bunx @dunx/mcp ./src/app.module.ts
```

An MCP server over stdio answering what routes, providers, modules and gateways
exist, and which constructor parameters would fail to resolve. It reads the module
graph and never boots the app.

## The framework's own instructions

- <https://petarzarkov.github.io/dunx/setup.md> - installing, wiring and verifying a dunx app
- <https://petarzarkov.github.io/dunx/llms.txt> - every dunx document, as raw markdown
