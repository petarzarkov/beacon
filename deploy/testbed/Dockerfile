# Propagation testbed images, all from one multi-stage build.
#
#   build      - installs, builds the console and compiles the agent binary once
#   panel      - runs the panel, serving the console and the release the seed spreads
#   seed       - a single agent, propagation armed, with ssh/sshpass to reach neighbours
#   neighbour  - a bare systemd host with sshd; the seed installs the agent onto it
#
# The neighbour stage is a real systemd host so `beacon-agent install` runs the
# way it does in production - writing units, creating the run user, starting the
# service - which is the one part of propagation a single dev host cannot fake.

# ---- build: compile the agent + build the console, once -----------------------
FROM oven/bun:1.4.0 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:fe
RUN bun run build:agent

# ---- panel: control plane, release host, console ------------------------------
FROM oven/bun:1.4.0 AS panel
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
# Run through the workspace filter so the panel's own `bunfig.toml` preload (the
# DI transform) applies, and its cwd is `apps/be` - which is where the default
# release dir and database resolve to, and where the agent binary was published.
CMD ["sh", "-lc", "bun run --filter beacon-be create:admin -- --email admin@beacon.local --password beacon-testbed --name Admin; exec bun run --filter beacon-be start"]

# ---- seed: one agent that spreads --------------------------------------------
FROM ubuntu:24.04 AS seed
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     openssh-client sshpass ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/apps/be/data/agent/beacon-agent /usr/local/bin/beacon-agent
RUN chmod +x /usr/local/bin/beacon-agent
CMD ["beacon-agent", "run"]

# ---- neighbour: a bare systemd host with sshd --------------------------------
FROM ubuntu:24.04 AS neighbour
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     systemd systemd-sysv openssh-server sudo passwd iproute2 ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/*
ARG ROOT_PASSWORD=beacon-testbed
RUN mkdir -p /run/sshd \
  && sed -i 's/#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
  && sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
  && echo "root:${ROOT_PASSWORD}" | chpasswd \
  && systemctl enable ssh \
  # Strip the baked machine-id so systemd mints a unique one per container at
  # boot - otherwise every neighbour built from this one image shares an id and
  # they all enrol onto a single agent row, each re-enrolment invalidating the
  # last (see the machine-id note in the agent's settings.ts).
  && rm -f /etc/machine-id /var/lib/dbus/machine-id
# systemd wants this signal to shut down cleanly, and its own PID 1.
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
