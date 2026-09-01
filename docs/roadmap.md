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
- **Lifecycle events** — `POST /api/agent/events` records the `startup` and `exit`
  an agent reports, kept as a per-host log the console shows on the detail page.
  Separate from the report because an exit has to be sent as the process ends.
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
  `APP_URL` + trusted origins are wired for a panel served at a real domain, and
  the panel **refuses to boot on the development `AUTH_SECRET`** once `APP_URL` is
  a real domain or a proxy is trusted — the same secret signs both session
  cookies and deployment grants, so shipping the published default is a boot-time
  error, not a first-login surprise.
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
- **Lifecycle events** — the agent reports `startup` once it is up and `exit`
  best-effort on a clean stop (`SIGTERM`), out of band from the report loop so an
  exit is sent as the process ends rather than held for an interval that never
  comes. The one exit it cannot send is a `restart` it dies executing, so a
  startup with no matching exit is a host that vanished — which the console draws.
- **Diagnostics** — a `diagnose` command runs one of a fixed allowlist of
  read-only probes (disk, memory, processes, network, uptime) and returns the
  output as the command's outcome. An allowlist, not a shell: the console can
  inspect a host without becoming a way to run anything on it. The report also
  carries the agent's own memory and CPU and whether it is a spreader.
- **`install` / `uninstall`** — writes `/usr/local/bin`, the `0600` config, a
  `/var/lib` state dir, an unprivileged service unit and a root update timer, and
  a single-line sudoers rule that lets the service ask the root timer to update.
  Creates the run user if missing. _Built and typechecked; not yet exercised on a
  real systemd host — see below._
- **`update`** — verifies the published sha256, stages beside the target and
  renames, restarts via systemd. Runs as root from the timer. **Proven end to
  end**: the swap runs against a real panel and release into a temp path, the
  hash-mismatch refusal leaves the old binary intact, and the operator-driven
  queue reaches the swap — the install path and restart are config seams
  (defaulting to `/usr/local/bin` and systemd) that let the suite exercise the
  real code without a machine.
- **`discover`** — a TCP connect sweep of the subnet (no raw socket, so no
  privilege), reported to the panel and never acted on.
- **`propagate`** — autonomous self-spread, **off by default**. See below.
- Identity persists to disk and survives a restart; all diagnostics go to stderr
  so `probe`/`discover`/`propagate --dry-run` leave stdout clean for their JSON.

### Console (`apps/fe`)

Working end to end, on the `landbased-panel` design: an `AppShell` with a header
of primary nav (a burger menu on narrow screens), the fleet-wide controls,
a theme toggle and an account menu, over the active page. **react-router** drives
it — `RequireAuth` (the Better Auth session, no token store) wraps a `RootLayout`
shell over the child routes, and because the panel serves the SPA for any non-API
path, every screen is a real URL that deep-links and survives a reload.

- **Agents** (`/agents`) — the fleet with derived `connected`, version + update
  flag, memory and load, the outstanding intent per agent (never a tick for the
  button press), and the controls: report / update / restart / discover / forget.
  Each row's host links to that agent's page.
- **Agent detail** (`/agents/:id`) — one host in full: its own memory / CPU /
  uptime (not the machine's), **trend charts** of memory and CPU over a chosen
  window, a **diagnostics** panel (run a read-only probe, read its output), its
  **lifecycle activity** (startups and exits as a timeline), its command history,
  and the controls.
- **Commands** (`/commands`) — open vs. recent history, each with its state and
  detail.
- **Discovered** (`/discovered`) — swept hosts not yet managed, with a deployment
  form that takes the credential per install and defaults the callback to this
  origin. The nav badges the count of unmanaged hosts.
- **Lineage** (`/lineage`) — the fleet as a "who installed whom" install tree,
  seed agents at the root, spreaders badged.

Built into `apps/be/public` (gitignored, generated), served by the panel at one
origin, so the session cookie is first-party with no CORS in production.

### Shared contract (`libs/contract`)

`@dunxon/contract` — the import-free wire types and constants (headers, command
vocabulary, report and view shapes) that panel, agent and console all depend on.
It replaced the old `@be/*` / `@agent/*` source aliases, so nothing reaches into
another app's `src`; the panel's zod schemas validate into these same shapes.

### End-to-end (`e2e/`)

An in-process panel on an ephemeral port plus **real agent subprocesses** — the
only way to test the things that matter: that `restart` really ends the process,
that a fresh process reports a fresh uptime, that an identity on disk is found
again by a different process, and that **self-update actually swaps the binary**
and comes back on the new one. 53 tests across enrolment, the command lifecycle,
releases, self-update (the real swap, the hash-mismatch refusal, the
operator-driven queue), **lifecycle events** (a clean stop reports an exit, a kill
reports none), **metrics history** (a point per report, oldest-first, real
memory and CPU), **diagnostics** (a read-only probe runs and returns output, the
allowlist is enforced), **propagation lineage** (a token-enrolled host is
attributed to whoever swept its address, and spreaders report themselves),
provisioning, the propagation kill switch, a multi-agent fleet with an offline
host, and the console — both the panel serving the SPA and **the SPA itself
driven in a real browser** (Playwright): the live fleet table, an agent's detail
page (its trends, diagnostics, activity), the deep link resolving on reload, a
command settling as an intent, and the lineage tree. Sign-in is only the way in,
not the subject — Better Auth covers auth itself. `bun run test:e2e`.

The browser tests skip themselves where the console is unbuilt or no Chromium is
installed (`bunx playwright install chromium`), so a bare checkout stays green; CI
does both and runs them. The harness is the one place that still boots the backend
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

- **Panel visibility of the spread** — **done**. The console has a Lineage view:
  a live "who installed whom" tree built from `installedBy`, which the panel now
  infers for autonomous propagation too (a host is attributed to whichever agent
  swept and found its address, not only to a panel grant). Spreaders — hosts
  locally opted in to propagate — report and badge themselves.
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
- **Report retention** — **done**. The panel keeps a bounded per-agent time
  series (`agent_metrics`, pruned past `AGENT_METRICS_RETENTION_HOURS`), and the
  console charts the trend of the agent's own memory and CPU on the detail page.
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
