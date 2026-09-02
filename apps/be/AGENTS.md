# beacon-be

The panel: the control plane, the API, and the release host for the agent fleet.
It also serves the operator console. A [dunx](https://github.com/petarzarkov/dunx)
app, originally scaffolded by `bunx @dunx/create-app` and since stripped to the
one feature it exists for.

Read [../../docs/architecture.md](../../docs/architecture.md) first: the one
constraint the whole system answers to is that **the panel can never dial an
agent**, and everything here follows from it.

## Commands

```bash
bun install
bun run dev            # http://localhost:3000, restarting on a change
bun run start
bun test
bun run typecheck
bun run create:admin -- --email you@example.com --password '…'   # the only way an operator exists
```

**No external services.** The panel needs nothing running — the database is a
local SQLite file, and there is no Redis, queue or worker. That is a deliberate
narrowing from the scaffold: a control plane that must stay reachable to be useful
should not have a dependency that can take it down.

## Layout

- `src/main.ts` — exports `createApp`, and serves it when run directly. Mounts
  `Compression`, `StaticFiles`, `SpaFallback` and the request trail, in that
  order, all ahead of any auth.
- `src/app.module.ts` — the root module. Construction order is the list order.
- `src/config.ts` — one validation function, flat env in and a shaped object out.
- `src/agents/` — **the feature.** Two controllers, because an agent and an
  operator are different callers with different credentials:
  - `agent.controller.ts` — `/api/agent/*`, token-checked, `@Public()` (no
    session). Enrol, report, outcomes, events, inventory, discovered, release +
    binary.
  - `fleet.controller.ts` — `/api/agents/*`, `@UseGuards(SessionGuard)`. The
    console's API: list, one agent + its events + metric history + inventory,
    commands, discovered, deployments, read-only diagnostics, the command library
    (`@Roles('admin')` to curate) and `exec` (Tier 1 library, Tier 2 free-form),
    alerting (rules + alerts + the notification webhook), and scheduled tasks.
  - `alerts.service.ts` — alert rules, evaluation (thresholds on report, silence
    on the sweep, failed commands), the alert lifecycle, and the webhook.
  - `schedule.service.ts` — recurring tasks: persists the definition and
    arms/removes them in dunx's `ScheduleRegistry` (a `Bun.cron` job each), whose
    handler queues the task's command. The registry owns the cadence and firing.
  - `agents.service.ts` — enrolment, report ingest, the fleet views.
  - `commands.service.ts` — the command lifecycle and the TTL sweep.
  - `releases.service.ts` — serves the published binary + manifest.
  - `enrolment.ts` — token hashing and the signed deployment grants.
  - `agents.repository.ts` — every SQL statement, synchronous throughout.
  - `agents.schema.ts` — the drizzle tables; `agents.schemas.ts` — the zod route
    schemas (also the OpenAPI document); `agents.views.ts` — rows → what the
    console sees.
- `src/auth/` — better-auth via `@dunx/auth`: `auth.module.ts`, `auth.options.ts`
  (shared with `scripts/create-admin.ts`), `auth.tables.ts`, `SessionGuard`, an
  audit trail, and `create-operator.ts`. Sign-up is disabled; the console API is
  session-guarded.
- `src/console/` — serves the built SPA (`apps/fe` → `public/`) with a deep-link
  fallback. One origin with the API, so the session cookie is first-party.
- `src/database/` — one connection, one drizzle handle. `schema.ts` re-exports
  the auth tables and the agents tables; no tables of its own.
- `src/health/` — `/api/health/{live,ready}`; readiness reports whether a release
  is published and how much of the fleet is reporting.
- `src/http/` — CORS, compression, error mapping and the request trail, read from
  config.
- `bunfig.toml` — the one preload line constructor injection needs.

The shared wire types (`HostReport`, the command vocabulary, the console view
shapes) live in **`@beacon/contract`** (`libs/contract`), not here — the agent and
console read the same definitions. The zod schemas in `agents.schemas.ts` validate
requests into those shapes.

A test imports `createApp` from `./main.js`; the `import.meta.main` block at the
bottom is what stops that starting a server.

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
  parameter.** An interface, a primitive, a union, or an `import type` at an
  injection site all record as `unresolved`. Inject a class, and drop `type` from
  the import — which is why a repository injects `SyncDatabase`, not a type alias.
- **Relative imports carry `.js`**: `'./agents.service.js'`, never
  `'./agents.service'`.
- **A module's `exports` is its public surface.** The container is scoped per
  module, so a provider another module injects has to be exported by the module
  that declares it. `AccountsModule` exports `SessionGuard` and `AuthContext` for
  exactly this reason.
- **`bun` only.** No `npm`, `npx`, `yarn` or `pnpm`; run tools with `bunx`.

## Reading this app instead of grepping it

```bash
bunx @dunx/mcp ./src/app.module.ts
```

An MCP server over stdio answering what routes, providers, modules and gateways
exist, and which constructor parameters would fail to resolve. It reads the module
graph and never boots the app.

## The framework's own instructions

- <https://petarzarkov.github.io/dunx/setup.md> — installing, wiring and verifying a dunx app
- <https://petarzarkov.github.io/dunx/llms.txt> — every dunx document, as raw markdown
