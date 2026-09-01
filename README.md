# dunxon

Control plane for a fleet of hosts, each running an agent the panel installs,
updates and collects from.

```
dunxon/
├── apps/
│   ├── panel/     # dunx service: API, control plane, release host
│   ├── agent/     # a dunx app compiled to one executable per managed host
│   └── fe/        # operator console, built into the panel's public dir
├── docs/
│   └── architecture.md
└── package.json   # bun workspaces
```

**The panel never dials an agent.** An agent may be behind NAT or on a network
the panel has no route into, so every connection is outbound from the agent and
control is best effort: an operator queues an intent that the agent collects when
it next checks in. Deployment onto an unreachable host is delegated to an agent
that can already reach it.

Built on [dunx](https://github.com/petarzarkov/dunx). The panel was scaffolded
with `@dunx/create-app`, so its version floor moves with the framework rather
than freezing a copy of it.

## Quick start

```bash
bun install
bun run dev            # the panel
bun run build:agent    # compile the agent, publish it to the panel's release dir
```

The agent binary is about 79 MB and lands in `apps/be/data/agent/` with a
`manifest.json` carrying its version and sha256. Both are gitignored.

```bash
./apps/be/data/agent/dunxon-agent version
./apps/be/data/agent/dunxon-agent probe
```

## Where this is

The repo, all three apps, the compile-to-binary pipeline with its release
manifest, and the container wiring that proves DI survives compilation.

`run`, `install`, `uninstall`, `discover` and the whole panel side of the
protocol are not, and say so when called.

[docs/architecture.md](docs/architecture.md) has the design, including the parts
that need a decision before they are worth building, and what
`landbased-panel` already learned about each of them.
