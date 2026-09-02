# beacon

A panel that manages a fleet of agents. Three apps, one repo:

| App          | What it is                                                       |
| ------------ | ---------------------------------------------------------------- |
| `apps/panel` | A dunx service: the control plane, the API, the release host     |
| `apps/agent` | A dunx app compiled to one executable, running on a managed host |
| `apps/fe`    | The operator console, served by the panel                        |

## The constraint everything else follows from

**The panel can never assume it can reach an agent.** An agent may sit behind
NAT, on a network the panel has no route into, or on the other side of the world.
What holds is the other direction: the agent can reach the panel.

So every connection is outbound from the agent. The panel never dials one, and
there is no port to open on a managed host. That is not a security preference, it
is the only thing that works for a host the panel cannot address.

### What that makes "control"

Best effort, and the interface has to say so. An operator does not restart an
agent; they **queue an intent** that the agent will collect when it next checks
in. A command therefore has a lifecycle, not a result:

```
queued -> delivered -> acknowledged -> completed | failed
      \-> expired
```

Two consequences worth designing for rather than discovering:

- **A command can outlive its usefulness.** Queue with a TTL and let it expire,
  or an agent that has been off for a week comes back and applies a restart
  nobody remembers asking for.
- **`restart` can never be acknowledged normally.** The agent dies executing it.
  Success is the agent reappearing with a fresh uptime and the command id, so the
  panel has to treat "delivered, then silence, then a new session" as completion
  rather than waiting for an ack that cannot arrive.

The console must show the state, not the request. "Restart queued, agent last
seen 3 minutes ago" is honest. A green tick when the button was pressed is not.

### Delivery

A websocket the agent opens and holds, so a queued command reaches it in
milliseconds and the panel learns immediately when it drops. Where a proxy will
not upgrade, the agent falls back to polling. Both are outbound, so the model is
the same either way and only the latency changes.

## Deployment, given the same constraint

The panel cannot install an agent on a host it cannot reach, which rules out the
approach `landbased-panel` uses: SSH from the panel to each machine.

**An agent already inside that network is the only thing positioned to do it.**
So deployment is delegated: the panel asks an agent to install onto a neighbour
it can reach, and that agent reports the result back out.

```
operator -> panel: install on 10.0.4.31
panel    -> queues a deployment for an agent on that subnet
agent    -> pulls the job, reaches the target, installs, reports back
```

This is also what makes a fleet self-extending: one agent placed by hand can
populate its whole segment.

### The credential problem, which this creates

Installing software on a host needs a remote execution primitive, and whatever
holds that credential is worth stealing. Putting a standing SSH key on every
agent means every managed host can install software on every other one, which is
a worse position than the one being replaced.

The shape to build toward: **the agent never holds a standing credential.** It
discovers candidates on its subnet and reports them; a human approves a target;
the panel then issues a credential scoped to that one host and a few minutes, and
the agent uses it for that job and discards it. What that credential is - a
short-lived SSH key, a one-time enrolment token consumed by a bootstrap already
on the image - is open, and it is the decision most worth getting right.

## The agent is a dunx app

Not a script. The same container, lifecycle and config contract as the panel, so
a service here is constructed and injected the way one there is, and both are
classes rather than closures.

```
beacon-agent version     print the version                (any user)
beacon-agent probe       print one report and exit        (any user)
beacon-agent run         connect and report on the panel's cadence
beacon-agent install     install and start the service    (root)
beacon-agent uninstall   stop and remove the service      (root)
beacon-agent update      pull a newer release             (root)
beacon-agent discover    list hosts on this subnet
```

`version` and `probe` answer before the container is built, deliberately. Both
have to work for any user on the host, and an installer asks the binary its
version before deciding whether to replace it, so anything that can fail there
reads as "not installed" and causes a reinstall loop.

Settings resolve from flags, then the environment, then
`/etc/beacon-agent/agent.conf`, so a one-off `--panel-url` wins while debugging a
host and a systemd drop-in can override without rewriting a `0600` file.

### Building it takes two passes, and the reason is not obvious

Constructor injection has no runtime annotation. `@dunx/transform` records each
class's dependencies as a statement appended after the class:

```js
Object.defineProperty(ProbeService, Symbol.for('dunx.deps'), {
  value: () => [AgentConfigService],
});
```

Passing `Bun.build` both `plugins: [depsPlugin]` and `compile` in one call loses
those statements. Measured on Bun 1.4.0: the plugin runs, the marker is present
in a plain `outdir` bundle and the bundle runs correctly, and the same build with
`compile` produces a binary containing `dunx.deps` **zero times**. It then fails
at boot with "no dependencies were recorded", which reads as a missing preload
and is not one.

`scripts/build.ts` bundles first and compiles the emitted JavaScript. By then the
markers are ordinary statements in one module rather than something a plugin
produced during the same pass.

## Updating

The agent verifies the published sha256 before swapping its own binary, and
writes beside the target then renames, so a partial download cannot leave an
unrunnable file where systemd restarts one. Without the hash check an update is a
blind overwrite of the one process managing the host.

The service runs unprivileged; the update runs from a root timer. What the agent
collects depends on which user it is, so running the reporter as root would
silently change the answers, while writing to `/usr/local/bin` needs privilege
the reporter should not hold.

## What is built

The repo, all three apps, the compile-to-binary pipeline with its release
manifest, config resolution, the probe, and the container wiring that proves DI
survives compilation.

`run`, `install`, `uninstall`, `discover` and the whole panel side of the
protocol are not. Each says so rather than pretending.
