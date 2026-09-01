import { drizzleDatabase } from '@dunx/auth/drizzle';
import type { App } from '@dunx/core';
import { DbConnection, SyncDatabase } from '@dunx/infra/db';
import { betterAuth } from 'better-auth';
import { eq } from 'drizzle-orm';
import { AppConfigService } from '../config.js';
import * as schema from '../database/schema.js';
import { authOptions } from './auth.options.js';

export interface NewOperator {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  /**
   * Make them an admin. The default, because both real callers - `create:admin`
   * and seeding the e2e operator - want one. `false` leaves the account at the
   * plugin's default role, which is how a test exercises a non-admin path.
   */
  readonly admin?: boolean;
}

export type OperatorResult = 'created' | 'promoted';

/**
 * Create (or promote) an operator, given a booted container.
 *
 * Two callers - `scripts/create-admin.ts` and the end-to-end harness - and one
 * definition, for the reason `auth.options.ts` exists: a second path that hashed
 * passwords differently would produce accounts nobody can sign in with, and the
 * failure would look exactly like a wrong password.
 *
 * The instance is built here rather than taken from the container because the
 * app's own has sign-up disabled. That is not a workaround: closing the HTTP
 * endpoint is what stops anyone who finds the URL making themselves an account,
 * and someone who already has the container has the database anyway.
 */
export const createOperator = async (
  app: Pick<App, 'get'>,
  operator: NewOperator,
): Promise<OperatorResult> => {
  const config = app.get(AppConfigService);
  const connection = app.get(DbConnection);
  const db = app.get(SyncDatabase) as SyncDatabase<typeof schema>;

  const auth = betterAuth(
    authOptions({
      secret: config.get('auth.secret'),
      baseURL: `http://localhost:${config.get('port')}`,
      database: drizzleDatabase(connection),
      openSignUp: true,
    }),
  );

  const existing = db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, operator.email))
    .get();

  if (existing === undefined) {
    await auth.api.signUpEmail({
      body: {
        email: operator.email,
        password: operator.password,
        name: operator.name ?? operator.email.split('@')[0] ?? 'operator',
      },
    });
  }

  // Set directly rather than through the admin plugin's endpoint, which requires
  // an admin caller: at this point there may not be one, which is the whole
  // reason this exists.
  if (operator.admin !== false) {
    db.update(schema.user)
      .set({ role: 'admin' })
      .where(eq(schema.user.email, operator.email))
      .run();
  }

  return existing === undefined ? 'created' : 'promoted';
};
