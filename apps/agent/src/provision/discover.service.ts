import { Logger } from '@dunx/core';
import { promises as dns } from 'node:dns';
import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { DiscoverPayload, DiscoveredHost } from '@dunxon/contract';

/** Ports that mean "a machine, not a printer". Overridable per sweep. */
const DEFAULT_PORTS = [22] as const;

/** Per-address, per-port. Long enough for a slow switch, short enough for 254 hosts. */
const CONNECT_TIMEOUT_MS = 700;

/** Sockets in flight. High enough to be quick, low enough not to exhaust the fd table. */
const CONCURRENCY = 64;

/** Reverse lookup is a nicety, and must never hold up a sweep. */
const DNS_TIMEOUT_MS = 500;

/**
 * Finding hosts on this agent's subnet, so the panel can offer them as
 * deployment targets.
 *
 * A TCP connect sweep rather than ICMP: `ping` needs a raw socket or a setuid
 * binary, and the service deliberately runs unprivileged. Connecting to a port
 * needs nothing, and "answers on 22" is a better signal for "could have an agent
 * installed on it" than "answers a ping" anyway.
 *
 * **This decides nothing.** It reports what answered; whether any of it belongs
 * in the fleet is a question for a human, because an agent cannot tell a kiosk
 * from a colleague's laptop that happens to run sshd.
 */
export class DiscoverService {
  constructor(private readonly logger: Logger) {}

  async sweep(
    payload: DiscoverPayload = {},
  ): Promise<readonly DiscoveredHost[]> {
    const cidr = payload.cidr ?? this.localCidr();
    const ports = payload.ports ?? DEFAULT_PORTS;
    const addresses = expand(cidr);

    this.logger.info('sweeping', {
      cidr,
      ports: [...ports],
      addresses: addresses.length,
    });

    const found: DiscoveredHost[] = [];
    for (let at = 0; at < addresses.length; at += CONCURRENCY) {
      const batch = addresses.slice(at, at + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (address) => {
          const open: number[] = [];
          for (const port of ports) {
            if (await knock(address, port)) open.push(port);
          }
          if (open.length === 0) return null;
          const name = await reverse(address);
          return {
            address,
            ports: open,
            ...(name === null ? {} : { hostname: name }),
          } satisfies DiscoveredHost;
        }),
      );
      found.push(...results.filter((host) => host !== null));
    }

    this.logger.info('swept', { cidr, found: found.length });
    return found;
  }

  /**
   * The agent's own /24.
   *
   * Capped at /24 whatever the interface mask says. A host on a /16 would
   * otherwise expand to 65,534 addresses, which is a twenty-minute sweep and
   * looks exactly like a port scan to anything watching the network - and an
   * operator who genuinely wants a wider range can pass a `cidr` and mean it.
   */
  localCidr(): string {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== 'IPv4' || address.internal) continue;
        const octets = address.address.split('.');
        return `${octets.slice(0, 3).join('.')}.0/24`;
      }
    }
    throw new Error('No non-internal IPv4 interface to sweep from');
  }

  /**
   * This host's own IPv4 addresses, loopback included.
   *
   * Propagation subtracts these from a sweep so an agent never tries to install
   * onto itself - which would either clobber its own binary or, more likely,
   * fail an SSH-to-self that has no matching credential and look like a real
   * failure in the report.
   */
  localAddresses(): readonly string[] {
    const out: string[] = ['127.0.0.1'];
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === 'IPv4') out.push(address.address);
      }
    }
    return out;
  }
}

/** Every usable host address in a CIDR, network and broadcast excluded. */
const expand = (cidr: string): readonly string[] => {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (base === undefined || !Number.isInteger(bits) || bits < 16 || bits > 32) {
    throw new Error(`Not a sweepable CIDR: ${cidr} (expected /16 to /32)`);
  }
  const octets = base.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((o) => !Number.isInteger(o) || o > 255)
  ) {
    throw new Error(`Not an IPv4 address: ${base}`);
  }
  const start =
    (((octets[0] ?? 0) << 24) |
      ((octets[1] ?? 0) << 16) |
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)) >>>
    0;
  const size = 2 ** (32 - bits);
  const network = (start & (size === 2 ** 32 ? 0 : ~(size - 1))) >>> 0;

  const out: string[] = [];
  // A /31 or /32 has no network or broadcast address to skip; anything wider does.
  const first = size <= 2 ? 0 : 1;
  const last = size <= 2 ? size : size - 1;
  for (let at = first; at < last; at += 1) {
    const value = (network + at) >>> 0;
    out.push(
      `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`,
    );
  }
  return out;
};

/** One TCP connect. Resolves false for refused, unreachable and timed out alike. */
const knock = (address: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = new Socket();
    const settle = (open: boolean): void => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
    socket.connect(port, address);
  });

/** Best effort, and bounded: an unreachable resolver must not stall the sweep. */
const reverse = async (address: string): Promise<string | null> => {
  try {
    const names = await Promise.race([
      dns.reverse(address),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS),
      ),
    ]);
    return names[0] ?? null;
  } catch {
    return null;
  }
};
