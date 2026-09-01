# Roadmap

Where dunxon is, and what is left. The design rationale lives in
[architecture.md](architecture.md); this is the build order.

The one constraint everything answers to, restated because every item below
inherits it: **the panel can never dial an agent.** Control is best-effort
intents an agent collects when it next reports.

## Shipped

A working first version: an agent enrols, reports, and obeys queued commands; the
panel serves updates and brokers deployments; both are covered end to end by real
processes.

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
- **Auth** — Better Auth sessions guard the console API; agent routes are token-
  checked instead. No public sign-up: `bun run create:admin` is the only way an
  operator comes to exist, because an account here can restart machines.
- **Health** — readiness reports whether a release is published and how much of
  the fleet is reporting, both non-critical.

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

Scaffolded: a Mantine + TanStack Query table over the agent API, calling the right
endpoints. **Not yet usable against the live panel** — see the top near-term item.

### End-to-end (`e2e/`)

An in-process panel on an ephemeral port plus **real agent subprocesses** — the
only way to test the three things that matter: that `restart` really ends the
process, that a fresh process reports a fresh uptime, and that an identity on disk
is found again by a different process. 25 tests across enrolment, the command
lifecycle, releases, provisioning, and a multi-agent fleet with an offline host.
`bun run test:e2e`.

## Near-term

### 1. The console, end to end

The API is session-guarded now, so the scaffolded console gets a 401 and cannot
render. To make it the working front end it is meant to be:

- A **login screen** and a `RequireAuth` boundary; the session cookie is already
  same-origin in production.
- Align the table with the richer `AgentView` — `os`/`arch`, load and memory,
  `updateAvailable`, and the honest `connected` (derived from last-seen, never a
  stored flag).
- A **discovered-hosts** view and a **deployment** form: name a target, supply the
  credential, watch the command settle. The console must show the _state of the
  intent_, never a tick for having pressed the button.
- Surface command history and outcomes per agent.

### 2. Prove `install` on a real host

The systemd path is written but has only been typechecked. It needs one run on a
real Linux host, as root, to confirm: the unit comes up unprivileged, the update
timer fires as root, the sudoers rule validates under `visudo -c`, and a
hand-seeded agent enrols. Until then, treat `install` as unverified.

### 3. Deployment credentials — the decision worth getting right

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
panel-brokered `deploy` stays the default. Before it is more than opt-in:

- **Panel visibility and a kill switch** — an operator should see a fleet spread
  and be able to stop it, which today means turning it off host by host.
- **Rate and blast-radius limits** — a cap per pass, and a refusal to sweep wider
  than a /24 without an explicit CIDR (already enforced in `discover`).
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
