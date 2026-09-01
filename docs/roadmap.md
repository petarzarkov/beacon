# Roadmap

Where dunxon is, and what is left. The design rationale lives in
[architecture.md](architecture.md); this is the build order.

The one constraint everything answers to, restated because every item below
inherits it: **the panel can never dial an agent.** Control is best-effort
intents an agent collects when it next reports.

## Start here (next session)

Everything below in **Shipped** is done, verified, and pushed to `main`. The
first things to pick up:

1. **Verify on a real host** — both `dunxon-agent install` (systemd, as root) and
   the panel deploy (`deploy/`, `svc:install`, behind Caddy with a real domain).
   Both are written and typecheck; neither has run on a real machine. This is the
   one gap between "a working first version" and "running in production."
2. **Deployment credentials** — the interim grant is scoped + expiring but not
   single-use, and the SSH credential still travels in the deploy job. Decide the
   end state (see near-term #2).
3. **Harden propagation** — panel kill switch and the dry-run exist; still missing
   are rate/blast-radius limits and real multi-host SSH coverage (near-term #3).

## Shipped

A working first version: an agent enrols, reports, and obeys queued commands; the
panel serves updates, brokers deployments, and gates fleet-wide propagation; the
console drives all of it; and everything is covered end to end by real processes.

### Panel (`apps/be`)

- **Enrolment** — a fleet-wide token buys one thing, an identity. The panel keeps
  only the sha256 of the per-agent token it issues, so a database dump is not a
  set of working fleet credentials. Re-enrolling the same `machineId` lands on the
  same row rather than forking history.
- **The report loop** — `POST /api/agent/report` is the whole control channel:
  the agent asks, and anything queued for it rides back on the answer.
- **The command lifecycle** — `queued → delivered → completed | failed | expired`,
  with a TTL sweep so an agent dark for a week does not come back to a restart
  nobody remembers. `restart` is completed by the panel noticing a process
  _younger_ than the delivery report in — the one command an agent cannot
  acknowledge, because it dies running it.
- **Releases** — the panel is the single distribution point; it serves the
  manifest and binary the fleet self-updates from, token-gated, with the sha256
  the agent verifies before it swaps itself out.
- **Delegated deployment** — an operator names a target, the panel picks the agent
  that reported seeing it and signs a deployment grant scoped to that one address
  and a few minutes. The agent installing holds no standing credential.
- **The propagation kill switch** — a fleet-wide switch (`fleet_settings`, admin
  only) delivered on every report. Self-propagation needs two keys: a host opting
  in locally _and_ the panel armed. Paused by default, so it is never on by the
  panel's silence; pausing it stops the fleet within one report interval.
- **Auth** — Better Auth sessions guard the console API; agent routes are token-
  checked instead. No public sign-up: `bun run create:admin` is the only way an
  operator comes to exist, because an account here can restart machines.
  `APP_URL` + trusted origins are wired for a panel served at a real domain.
- **Health** — readiness reports whether a release is published and how much of
  the fleet is reporting, both non-critical.

### Public deployment (`deploy/`)

The panel is reachable from anywhere, since agents dial in from anywhere. A
systemd unit, a production env template, and a Caddy TLS reverse-proxy example,
plus `svc:*` scripts that build and manage the service. `TRUST_PROXY=true` and
`APP_URL` are required behind the proxy — the first because a deployment grant is
bound to the agent's source address, the second because Better Auth checks the
sign-in origin against it. **Written, not yet run on a real host.**

### Agent (`apps/agent`)

A dunx app compiled to one binary. `version` and `probe` answer before the
container is built, for any user; everything else boots the container.

- **`run`** — enrol if needed, then report on the panel's cadence and execute what
  comes back. Retries enrolment and reporting forever rather than exiting; an
  unreachable panel is a wait, not a failure.
- **`install` / `uninstall`** — writes `/usr/local/bin`, the `0600` config, a
  `/var/lib` state dir, an unprivileged service unit and a root update timer, and
  a single-line sudoers rule that lets the service ask the root timer to update.
  Creates the run user if missing. _Built and typechecked; not yet exercised on a
  real systemd host — see below._
- **`update`** — verifies the published sha256, stages beside the target and
  renames, restarts via systemd. Runs as root from the timer.
- **`discover`** — a TCP connect sweep of the subnet (no raw socket, so no
  privilege), reported to the panel and never acted on.
- **`propagate`** — autonomous self-spread, **off by default**. See below.
- Identity persists to disk and survives a restart; all diagnostics go to stderr
  so `probe`/`discover`/`propagate --dry-run` leave stdout clean for their JSON.

### Console (`apps/fe`)

Working end to end. A session gate (`useSession` → login or fleet, no router for
two screens), then three views:

- **Agents** — the fleet with derived `connected`, version + update flag, memory
  and load, the outstanding intent per agent (never a tick for the button press),
  and the controls: report / update / restart / discover / forget.
- **Commands** — open vs. recent history, each with its state and detail.
- **Discovered** — swept hosts not yet managed, with a deployment form that takes
  the credential per install and defaults the callback URL to this origin.

Built into `apps/be/public` (gitignored, generated), served by the panel at one
origin, so the session cookie is first-party with no CORS in production.

### Shared contract (`libs/contract`)

`@dunxon/contract` — the import-free wire types and constants (headers, command
vocabulary, report and view shapes) that panel, agent and console all depend on.
It replaced the old `@be/*` / `@agent/*` source aliases, so nothing reaches into
another app's `src`; the panel's zod schemas validate into these same shapes.

### End-to-end (`e2e/`)

An in-process panel on an ephemeral port plus **real agent subprocesses** — the
only way to test the three things that matter: that `restart` really ends the
process, that a fresh process reports a fresh uptime, and that an identity on disk
is found again by a different process. 29 tests across enrolment, the command
lifecycle, releases, provisioning, the console (SPA serving + the auth gate), the
propagation kill switch, and a multi-agent fleet with an offline host. 33 tests.
`bun run test:e2e`. The harness is the one place that still boots the backend
in-process (`createApp`), which is inherent to an in-process suite rather than a
cross-import of types.

## Near-term

### 1. Prove `install` and the panel deploy on a real host

Both the agent's systemd install and the panel's `deploy/` are written and
typecheck, but neither has run on a real machine.

- **Agent `install`** (as root): the service comes up unprivileged, the update
  timer fires as root, the sudoers rule validates under `visudo -c`, and a
  hand-seeded agent enrols.
- **Panel deploy**: `svc:install` behind Caddy with a real `APP_URL` and
  `TRUST_PROXY=true` — sign in from the domain (proves the trusted-origin wiring),
  and enrol an agent from another host (proves the grant address-binding through
  the proxy). Until this runs, treat both as unverified.

### 2. Deployment credentials — the decision worth getting right

`architecture.md` flags this as the most important open question, and the current
grant (a signed `address|expiry`, minutes long) is the interim answer. What to
settle:

- A grant is **scoped and expiring but not single-use** — it needs no storage,
  which was the point, but a leaked one admits its address for the rest of its
  window. Decide whether one-time consumption (a table, a write on the hot
  enrolment path) is worth it.
- The SSH credential still travels **in the deploy job**. The end state is an
  operator supplying it at approval time to a short-lived channel, never at rest
  on the panel or an agent.

## Later

### Self-propagation, hardened

`propagate` exists and is off by default. It is the one path that holds a
**standing credential** — a fleet-wide SSH key or password — so a stolen agent
becomes a way into its neighbours. It is the deliberate trade for a fleet that
assembles itself from one seeded host, and it is why the credential-free
panel-brokered `deploy` stays the default. The **kill switch is done** (a
fleet-wide, admin-only pause, on by default). Still to do before it is more than
opt-in:

- **Panel visibility of the spread** — the console shows the switch and
  discovered hosts, but not a live "which agent installed which" tree; an
  operator watching a fleet colonise a segment would want that.
- **Rate and blast-radius limits** — a cap on installs per pass, and a refusal to
  sweep wider than a /24 without an explicit CIDR (already enforced in `discover`).
- **Real multi-host SSH coverage** — the planner and partitioning are unit-tested
  and the dry-run is covered end to end, but the SSH install itself needs a
  container matrix; a single dev host cannot exercise it faithfully.

### Cross-platform (Windows)

The agent is Linux-only today: systemd units, `/etc` and `/var/lib` paths, `ssh`
and `sshpass`. Bun compiles a standalone binary for Windows and macOS, so the
reporting core is portable as written; what is not is everything host-shaped.

- Abstract the service manager (systemd → a Windows service / `sc.exe`,
  launchd on macOS) behind the interface `InstallService` already implies.
- Path resolution per platform for the binary, config and identity.
- The install transport (`ssh`/`scp`) needs a Windows equivalent — WinRM or
  OpenSSH-for-Windows — behind the `Installer` seam that already exists.
- `probe` should report the platform so the panel can serve the right binary.

### Scale and operations

- **Postgres** — the panel is SQLite-first; `DatabaseModule` is one `forRoot` call
  from Postgres, and the repositories would move off the synchronous handle.
- **Fleet-wide cadence and grouping** — slow a segment centrally, target a command
  at a group rather than one agent.
- **Report retention** — today the panel keeps only the last report per agent;
  trends (memory, load) need a time series.
- **Multi-node panel** — the report loop is stateless, but the TTL sweep is a
  single-node `@Interval`; at more than one replica it becomes a job that must
  fire once per fleet.

## Decided against

- **A websocket transport.** The architecture doc once pointed at it as the
  destination. It is not: an agent may be behind a proxy that will not upgrade or
  a NAT that will not hold a connection open, and the one thing that works
  everywhere is the agent making a request. HTTP polling is the transport, not a
  fallback. Revisit only if push latency ever proves to matter more than
  reaching every host, which the constraint says it will not.
