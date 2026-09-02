import { z } from 'zod';
import {
  AGENT_COMMANDS,
  AGENT_EVENT_KINDS,
  ALERT_COMPARATORS,
  ALERT_METRICS,
  ALERT_RULE_KINDS,
  DIAGNOSE_PROBES,
  SCHEDULE_ACTIONS,
} from '@beacon/contract';

/**
 * The route schemas, which are also the OpenAPI document. Everything an agent or
 * the console sends is validated here before a service sees it; the types in
 * `@beacon/contract` describes the same shapes for the binary and the console,
 * which cannot carry zod. The view types live there too, so these schemas do not
 * restate them.
 */

/** Long enough for a probe that grows, short enough that one host cannot flood the panel. */
const MAX_DETAIL = 500;

/** A diagnostic returns multi-line output, so its outcome detail gets more room. */
const MAX_OUTPUT = 8_000;

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
    // Defaulted, so a new panel still accepts an agent that has not updated to
    // send it yet - an old agent must be able to report in order to collect the
    // update that teaches it to. The view reads 0 as "unknown".
    agentMemBytes: z.number().int().min(0).default(0),
    // Nullable and defaulted for the same reason, plus: the first report of a
    // process has no prior sample to rate against.
    agentCpuPercent: z.number().min(0).nullable().default(null),
    // Defaulted so an agent that predates the field still reports.
    propagateEnabled: z.boolean().default(false),
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
    propagationAllowed: z.boolean(),
  })
  .meta({
    id: 'ReportResponse',
    description: 'The cadence to keep, and anything queued for this agent',
  });

export const commandOutcome = z.object({
  id: z.string().min(1).max(64),
  ok: z.boolean(),
  // Room for diagnostic output, which is multi-line; short outcomes use a line.
  detail: z.string().max(MAX_OUTPUT).optional(),
});

export const outcomesRequest = z
  .object({ outcomes: z.array(commandOutcome).min(1).max(50) })
  .meta({
    id: 'CommandOutcomes',
    description: 'What actually happened, reported after the fact',
  });

export const agentEvent = z.object({
  kind: z.enum(AGENT_EVENT_KINDS),
  message: z.string().min(1).max(MAX_DETAIL),
  at: z.iso.datetime(),
});

export const eventsRequest = z
  .object({ events: z.array(agentEvent).min(1).max(50) })
  .meta({
    id: 'AgentEvents',
    description: 'Lifecycle moments an agent reports: it started, it stopped.',
  });

export const inventoryReport = z
  .object({
    hostname: z.string().min(1).max(255),
    platform: z.string().min(1).max(64),
    osRelease: z.string().min(1).max(255),
    arch: z.string().min(1).max(32),
    cpuModel: z.string().max(255),
    cpuCores: z.number().int().min(0).max(4096),
    memTotalBytes: z.number().int().min(0),
    disks: z
      .array(
        z.object({
          mount: z.string().max(255),
          fsType: z.string().max(64),
          totalBytes: z.number().int().min(0),
          usedBytes: z.number().int().min(0),
        }),
      )
      .max(128),
    nics: z
      .array(
        z.object({
          name: z.string().max(64),
          mac: z.string().max(64),
          addresses: z.array(z.string().max(64)).max(32),
        }),
      )
      .max(128),
    collectedAt: z.iso.datetime(),
  })
  .meta({
    id: 'AgentInventory',
    description:
      'The hardware and OS facts of one host, collected by its agent',
  });

export const inventoryRoute = { body: inventoryReport } as const;

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
 * Queued bare, with no argument: `report`, `update`, `restart` and `inventory`.
 * `discover` takes a subnet and `deploy` a credential, so both have routes of
 * their own that can require one; `diagnose` and `exec` likewise.
 */
export const queueableCommand = z.enum([
  'report',
  'update',
  'restart',
  'inventory',
]);

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
export const eventsRoute = { body: eventsRequest } as const;
export const discoveredRoute = { body: discoveredRequest } as const;

export const listAgentsRoute = {} as const;
export const oneAgentRoute = { params: agentId } as const;
export const agentEventsRoute = {
  params: agentId,
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
} as const;
export const agentMetricsRoute = {
  params: agentId,
  query: z.object({
    // Minutes of history to return. A day at most - the retention window caps it.
    minutes: z.coerce.number().int().min(1).max(1440).default(60),
  }),
} as const;
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
export const diagnoseRoute = {
  params: agentId,
  body: z.object({ probe: z.enum(DIAGNOSE_PROBES) }),
} as const;

// --- Custom commands: the library (Tier 1) and exec (Tier 1 + Tier 2) ---------

export const libraryEntry = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[a-zA-Z0-9._-]+$/,
        'letters, digits, dot, dash, underscore only',
      ),
    description: z.string().max(280).optional(),
    argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  })
  .meta({
    id: 'CommandLibraryEntry',
    description: 'A named, admin-curated command an operator can run',
  });
export const createLibraryRoute = { body: libraryEntry } as const;
export const libraryIdRoute = {
  params: z.object({ id: z.string().min(1).max(64) }),
} as const;

/** Tier 1: run a library entry by id (any operator). */
export const execRoute = {
  params: agentId,
  body: z.object({ libraryId: z.string().min(1).max(64) }),
} as const;
/** Tier 2: run a free-form command (admin only, gated by ALLOW_ARBITRARY_EXEC). */
export const execRawRoute = {
  params: agentId,
  body: z.object({ command: z.string().min(1).max(4096) }),
} as const;

// --- Alerting -----------------------------------------------------------------

export const alertRule = z
  .object({
    name: z.string().min(1).max(80),
    kind: z.enum(ALERT_RULE_KINDS),
    metric: z.enum(ALERT_METRICS).optional(),
    comparator: z.enum(ALERT_COMPARATORS).optional(),
    threshold: z.number().optional(),
    silenceSeconds: z.number().int().min(1).max(86_400).optional(),
  })
  .refine(
    (r) =>
      r.kind !== 'metric_threshold' ||
      (r.metric !== undefined &&
        r.comparator !== undefined &&
        r.threshold !== undefined),
    { message: 'metric_threshold needs metric, comparator and threshold' },
  )
  .refine((r) => r.kind !== 'agent_silent' || r.silenceSeconds !== undefined, {
    message: 'agent_silent needs silenceSeconds',
  })
  .meta({
    id: 'AlertRule',
    description: 'An alerting rule, evaluated fleet-wide',
  });
export const createAlertRuleRoute = { body: alertRule } as const;
export const alertRuleIdRoute = {
  params: z.object({ id: z.string().min(1).max(64) }),
} as const;
export const alertsRoute = {
  query: z.object({
    scope: z.enum(['active', 'all']).default('active'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
} as const;
export const alertIdRoute = {
  params: z.object({ id: z.string().min(1).max(64) }),
} as const;
export const alertWebhookRoute = {
  body: z.object({ url: z.string().max(2048) }),
} as const;

// --- Scheduled tasks ----------------------------------------------------------

export const scheduleTask = z
  .object({
    name: z.string().min(1).max(80),
    // Null (or absent) targets the whole fleet; otherwise one agent.
    agentId: z.string().min(1).max(64).nullable().optional(),
    action: z.enum(SCHEDULE_ACTIONS),
    probe: z.enum(DIAGNOSE_PROBES).optional(),
    libraryId: z.string().min(1).max(64).optional(),
    // A Bun.cron expression or named schedule; the registry parses it for real
    // and an unparseable one comes back a 400 from the service.
    cron: z.string().min(1).max(120),
  })
  .refine((r) => r.action !== 'diagnose' || r.probe !== undefined, {
    message: 'a diagnose task needs a probe',
  })
  .refine((r) => r.action !== 'exec' || r.libraryId !== undefined, {
    message: 'an exec task needs a library command',
  })
  .meta({
    id: 'ScheduledTask',
    description: 'A command the panel queues on a cadence',
  });
export const createScheduleRoute = { body: scheduleTask } as const;
export const scheduleIdRoute = {
  params: z.object({ id: z.string().min(1).max(64) }),
} as const;
export const toggleScheduleRoute = {
  params: z.object({ id: z.string().min(1).max(64) }),
  body: z.object({ enabled: z.boolean() }),
} as const;

export const fleetSettings = z
  .object({ propagationAllowed: z.boolean() })
  .meta({
    id: 'FleetSettings',
    description: 'Fleet-wide switches an operator controls live',
  });
export const settingsRoute = { body: fleetSettings } as const;
