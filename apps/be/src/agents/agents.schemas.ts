import { z } from 'zod';
import { AGENT_COMMANDS, COMMAND_STATES } from './agent.contract.js';

/**
 * The route schemas, which are also the OpenAPI document. Everything an agent or
 * the console sends is validated here before a service sees it; the types in
 * `agent.contract.ts` describe the same shapes for the binary, which cannot
 * carry zod.
 */

/** Long enough for a probe that grows, short enough that one host cannot flood the panel. */
const MAX_DETAIL = 500;

export const hostReport = z
  .object({
    agentVersion: z.string().min(1).max(64),
    hostname: z.string().min(1).max(255),
    os: z.string().min(1).max(255),
    arch: z.string().min(1).max(32),
    uptimeSeconds: z.number().int().min(0),
    agentUptimeSeconds: z.number().int().min(0),
    load1: z.number().min(0),
    memTotalBytes: z.number().int().min(0),
    memFreeBytes: z.number().int().min(0),
    collectedAt: z.iso.datetime(),
  })
  .meta({ id: 'HostReport', description: 'One host, as its agent sees it' });

export const enrolRequest = z
  .object({
    hostname: z.string().min(1).max(255),
    os: z.string().min(1).max(255),
    arch: z.string().min(1).max(32),
    agentVersion: z.string().min(1).max(64),
    machineId: z.string().min(1).max(128),
  })
  .meta({
    id: 'EnrolRequest',
    description: 'An agent asking the panel for an identity',
  });

export const enrolResponse = z
  .object({
    agentId: z.string(),
    agentToken: z.string(),
  })
  .meta({
    id: 'EnrolResponse',
    description: 'Issued once. The panel keeps only a hash of the token.',
  });

export const commandEnvelope = z
  .object({
    id: z.string(),
    command: z.enum(AGENT_COMMANDS),
    payload: z.unknown().nullable(),
  })
  .meta({ id: 'CommandEnvelope', description: 'One collected intent' });

export const reportResponse = z
  .object({
    ok: z.literal(true),
    agentId: z.string(),
    reportIntervalMs: z.number().int(),
    commands: z.array(commandEnvelope),
  })
  .meta({
    id: 'ReportResponse',
    description: 'The cadence to keep, and anything queued for this agent',
  });

export const commandOutcome = z.object({
  id: z.string().min(1).max(64),
  ok: z.boolean(),
  detail: z.string().max(MAX_DETAIL).optional(),
});

export const outcomesRequest = z
  .object({ outcomes: z.array(commandOutcome).min(1).max(50) })
  .meta({
    id: 'CommandOutcomes',
    description: 'What actually happened, reported after the fact',
  });

export const discoveredHost = z.object({
  address: z.ipv4(),
  ports: z.array(z.number().int().min(1).max(65535)).max(32),
  hostname: z.string().max(255).optional(),
});

export const discoveredRequest = z
  .object({ hosts: z.array(discoveredHost).max(1024) })
  .meta({
    id: 'DiscoveredHosts',
    description: 'What answered a subnet sweep. Recorded, never acted on.',
  });

export const releaseManifest = z
  .object({
    version: z.string(),
    sha256: z.string(),
    sizeBytes: z.number().int(),
    file: z.string(),
    builtAt: z.string(),
  })
  .meta({
    id: 'ReleaseManifest',
    description: 'The published agent release an update verifies against',
  });

/**
 * What the console is shown. `connected` is derived rather than stored - the
 * panel never dials an agent, so the honest question is "did it report
 * recently", and a column would only be a cache of the clock.
 */
export const agentView = z
  .object({
    id: z.string(),
    hostname: z.string(),
    agentVersion: z.string(),
    os: z.string(),
    arch: z.string(),
    enrolledAt: z.string(),
    lastSeenAt: z.string(),
    lastIp: z.string().nullable(),
    uptimeSeconds: z.number().int(),
    /** Null until the first report: an enrolled agent has not necessarily spoken yet. */
    load1: z.number().nullable(),
    memTotalBytes: z.number().int().nullable(),
    memFreeBytes: z.number().int().nullable(),
    reportedAt: z.string().nullable(),
    connected: z.boolean(),
    /** True when the panel has a newer release than this agent is running. */
    updateAvailable: z.boolean(),
  })
  .meta({ id: 'Agent', description: 'A managed host, as the console sees it' });

export const commandView = z
  .object({
    id: z.string(),
    agentId: z.string(),
    command: z.enum(AGENT_COMMANDS),
    state: z.enum(COMMAND_STATES),
    queuedAt: z.string(),
    expiresAt: z.string(),
    deliveredAt: z.string().nullable(),
    settledAt: z.string().nullable(),
    detail: z.string().nullable(),
    issuedBy: z.string().nullable(),
  })
  .meta({
    id: 'Command',
    description: 'A queued intent and where it got to, never a result',
  });

export const discoveryView = z
  .object({
    address: z.string(),
    hostname: z.string().nullable(),
    ports: z.array(z.number().int()),
    foundBy: z.string(),
    lastSeenAt: z.string(),
    enrolledAgentId: z.string().nullable(),
  })
  .meta({
    id: 'DiscoveredHost',
    description: 'A host on a managed subnet that is not managed yet',
  });

/**
 * Only `report`, `update` and `restart` are queued bare. `discover` takes a
 * subnet and `deploy` takes a credential, so both have routes of their own that
 * can require one.
 */
export const queueableCommand = z.enum(['report', 'update', 'restart']);

export const deployCredential = z
  .object({
    kind: z.enum(['password', 'privateKey']),
    username: z.string().min(1).max(64),
    value: z.string().min(1).max(16_384),
    port: z.number().int().min(1).max(65535).default(22),
  })
  .meta({
    id: 'DeployCredential',
    description:
      'Supplied per deployment and discarded when it settles. The panel holds no standing key.',
  });

export const deployRequest = z
  .object({
    target: z.ipv4(),
    credential: deployCredential,
    /** The address the target can reach the panel on, which the panel cannot infer. */
    panelUrl: z.url(),
    /**
     * Minutes, not hours. The credential travels to another machine, so the
     * window in which a collected job is still worth anything must be short.
     */
    ttlMinutes: z.number().int().min(1).max(60).default(10),
  })
  .meta({
    id: 'DeployRequest',
    description: 'Install onto a host the panel cannot reach, via one that can',
  });

const agentId = z.object({ id: z.string().min(1).max(64) });

export const enrolRoute = { body: enrolRequest } as const;
export const reportRoute = { body: hostReport } as const;
export const outcomesRoute = { body: outcomesRequest } as const;
export const discoveredRoute = { body: discoveredRequest } as const;

export const listAgentsRoute = {} as const;
export const oneAgentRoute = { params: agentId } as const;
export const listCommandsRoute = {
  query: z.object({
    state: z.enum(['open', 'recent']).default('open'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
} as const;
export const queueRoute = {
  params: agentId,
  body: z.object({ command: queueableCommand }),
} as const;
export const discoverRoute = {
  params: agentId,
  body: z.object({
    cidr: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/)
      .optional(),
    ports: z.array(z.number().int().min(1).max(65535)).max(16).optional(),
  }),
} as const;
export const deployRoute = { body: deployRequest } as const;

export type AgentView = z.infer<typeof agentView>;
export type CommandView = z.infer<typeof commandView>;
export type DiscoveryView = z.infer<typeof discoveryView>;
