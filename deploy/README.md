# Deploying the panel publicly

Agents dial the panel from anywhere, so it has to be reachable on the public
internet. The panel also serves the console (`apps/fe` builds into
`apps/be/public`) and the agent releases (`apps/be/data/agent`), so one process
is the whole deploy.

## The shape

```
agent (anywhere) ──HTTPS──▶ Caddy :443 ──▶ panel :3000 (localhost)
operator browser ──HTTPS──▶ Caddy :443 ──▶ panel :3000  (same origin as the API)
```

A TLS-terminating reverse proxy (Caddy here; nginx works the same) is in front.
The panel binds all interfaces, so a firewall should keep `:3000` off the
internet — only the proxy reaches it.

## Once, on the host

```bash
# 1. Check the repo out (the unit assumes /opt/beacon; edit it if not).
sudo git clone <repo> /opt/beacon && cd /opt/beacon
sudo bun install

# 2. Secrets + public config. Fill APP_URL, AUTH_SECRET, AGENT_ENROLMENT_TOKEN.
sudo cp deploy/panel.env.example /etc/beacon-panel.env
sudo chmod 600 /etc/beacon-panel.env && sudo "$EDITOR" /etc/beacon-panel.env
sudo mkdir -p /var/lib/beacon      # DATABASE_FILE + AGENT_RELEASE_DIR live here

# 3. The first operator (no public sign-up by design).
bun run create:admin -- --email you@example.com --password '…'

# 4. TLS + proxy.
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile   # edit the domain
sudo systemctl reload caddy
```

## The service

`svc:*` in the root `package.json` wrap `systemctl`. `svc:install` builds the FE
and the agent, installs the unit, and starts it:

```bash
bun run svc:install     # build + install + enable --now
bun run svc:status
bun run svc:logs        # journalctl -u beacon-panel -f
bun run svc:restart     # rebuild + restart
bun run svc:stop / svc:start / svc:uninstall
```

## What must be right for a public panel

- **`APP_URL`** is the real origin. Better Auth signs cookies and checks the
  sign-in Origin against it; left on `localhost`, every browser sign-in is
  rejected as CSRF.
- **`TRUST_PROXY=true`**, because a deployment grant is bound to the agent's
  source address. Behind a proxy with this off, every agent looks like the proxy
  and no grant is ever honoured.
- **`AGENT_ENROLMENT_TOKEN`** and **`AUTH_SECRET`** are real secrets
  (`openssl rand -hex 32`), not the development defaults.
- **`DATABASE_FILE`** is an absolute path outside the checkout, so a redeploy
  does not wipe the fleet.
