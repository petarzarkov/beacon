# dunxon-panel

Scaffolded with `bunx @dunx/create-app`.

```bash
bun install
bun run dev     # restarts on a change
bun run start
```

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

These features need something running. Each one degrades rather than failing the
boot, so the app still starts without them.

- **cache** needs Redis or Valkey
- **websockets** needs Redis or Valkey, for multi-node fan-out only
- **jobs** needs Redis or Valkey

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

`main.ts`, `app.module.ts` and `config.ts` were generated for the features you
chose; everything else is copied from dunx's `examples/full`, which is run and
toured in CI on every push. The `*.demo.ts` files are that example's scripted
walkthroughs - delete one and its `providers` entry when you do not want it.

A test imports `createApp` from `./main.js` and never starts a server: the
`import.meta.main` block at the bottom of the file is false for an import.

## Constructor injection

`bunfig.toml` preloads `@dunx/transform`, which records each class's constructor
parameter types so the container can resolve them. Without that line providers are
built with no arguments and boot fails saying so.
