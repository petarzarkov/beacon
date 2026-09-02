# Propagation testbed

A whole fleet on one machine, so the one thing a single dev host cannot fake —
**an agent installing the agent onto another host over SSH** — can be watched
end to end. Four containers on a private `/24`:

- **panel** — the control plane, release host, and console
- **seed** — one agent, propagation armed, with `ssh`/`sshpass` to reach neighbours
- **neighbour-1..3** — bare **systemd** hosts running only `sshd`

The seed sweeps the subnet, finds the neighbours on port 22, copies the agent
binary over, runs `dunxon-agent install` on each (real systemd units, a real run
user), and each neighbour enrols. Because the seed is the one that swept and
found their addresses, the panel attributes each to the seed — so the **Lineage**
view draws the tree of who installed whom.

## Run it

```bash
docker compose -f deploy/testbed/docker-compose.yml up --build
```

First build compiles the agent binary and the console, so it takes a few minutes.
Then open **http://localhost:3001** and sign in:

- **admin@dunxon.local** / **dunxon-testbed**

Within a sweep interval (~15 s) the three neighbours appear under **Agents**, and
the **Lineage** tab shows them nested beneath `seed`. The seed carries a
`spreader` badge.

Tear down (and wipe the throwaway state):

```bash
docker compose -f deploy/testbed/docker-compose.yml down -v
```

## What it proves

- The real SSH path: `scp` the binary, `sudo dunxon-agent install`, systemd
  brings the service up, the agent enrols.
- Lineage for **autonomous** propagation: neighbours enrol with the shared token
  (no panel grant), yet the panel attributes each to the seed from the sweep.
- The two-key kill switch end to end: nothing spreads unless the host opted in
  (`AGENT_PROPAGATE=true` on the seed) **and** the panel is armed
  (`AGENT_PROPAGATION_ALLOWED=true`). Flip the panel switch off in the console and
  the spread stops within one interval.

## It is a testbed, not a deployment

Everything here is a throwaway on a private network: a fixed root password on the
neighbours, propagation armed on boot, `privileged` containers so systemd can run
as PID 1 (cgroup v2). None of that belongs anywhere real — the panel-brokered
`deploy` with per-install credentials is the production path.
