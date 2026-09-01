// better-auth's `user`/`session`/`account`/`verification`, re-exported so they are
// part of the one schema object. That is what lets `drizzleDatabase(connection)` in
// auth.module.ts pass no schema of its own - the adapter reads `db._.fullSchema`.
export * from './auth.schema.js';
// The fleet's tables, part of the same object for the same reason: `typeof schema`
// is what every repository's drizzle handle is typed by, so a table added there is
// visible here without being registered anywhere.
export * from '../agents/agents.schema.js';

/**
 * One schema module, because there is one connection and one drizzle handle.
 * `typeof schema` is what flows into `SyncDatabase<typeof schema>` at every
 * injection site.
 *
 * There are no tables of its own left. The panel stores two things - who may sign
 * in, and what the fleet is - and each is declared by the feature that owns it.
 */
