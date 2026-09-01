# dunxon-be

The panel: control plane, API, and release host for the agent fleet. Serves the
operator console (`apps/fe`) at the same origin.

```bash
bun install
bun run dev      # http://localhost:3000, restarting on a change
bun run start
```

There is no default admin and no public sign-up — an account here can restart
machines. Create the first operator by hand:

```bash
bun run create:admin -- --email you@example.com --password 'a good one'
```

Then sign in at `/`. Set `AGENT_ENROLMENT_TOKEN` (`openssl rand -hex 32`) so
agents can enrol; without it enrolment is refused and the panel says so at boot.

## What it is

- **The agent protocol** — `/api/agent/*`, token-authenticated: enrol, report,
  report command outcomes, report discovered hosts, pull the release + binary.
  The report is the whole control channel; queued commands ride back on its reply.
- **The console API** — `/api/agents/*`, session-guarded: the fleet, the command
  lifecycle, discovered hosts, and delegated deployments.
- **Release distribution** — serves the manifest and binary the fleet
  self-updates from, sha256-verified by the agent.
- **The console** — the built SPA, served with a deep-link fallback.

No Redis, no queue, no worker: the database is a local SQLite file, so the panel
starts with nothing else running. See [AGENTS.md](AGENTS.md) for the layout and
the dunx rules, and [../../docs/architecture.md](../../docs/architecture.md) for
why the panel never dials an agent.

## Docs

- Swagger UI: <http://localhost:3000/api/docs>
- OpenAPI: <http://localhost:3000/api/openapi.json>
- Health: <http://localhost:3000/api/health/ready>
