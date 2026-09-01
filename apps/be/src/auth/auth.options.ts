import { bunPassword } from '@dunx/auth';
import type { BetterAuthOptions } from 'better-auth';
import { admin, bearer, openAPI } from 'better-auth/plugins';

export interface AuthOptionsInit {
  readonly secret: string;
  readonly baseURL: string;
  /** The result of `drizzleDatabase(connection)`. */
  readonly database: BetterAuthOptions['database'];
  /**
   * Whether `POST /sign-up/email` is served.
   *
   * Closed in the app and open for `create:admin`, which is the only reason
   * this is a parameter. A panel that restarts machines cannot have a public
   * sign-up form: anyone who can make themselves an account can restart the
   * fleet. The first operator is created by someone with shell access, which is
   * a deliberate act in a way that filling in a form is not.
   */
  readonly openSignUp: boolean;
}

/**
 * The better-auth options, and the one definition of them.
 *
 * Two callers: `AuthModule.forRootAsync` builds the instance the app serves, and
 * `scripts/create-admin.ts` needs a ready instance with the sign-up endpoint
 * open. Splitting the options from the instance is what stops the two drifting -
 * a script that hashed passwords differently from the server would create
 * accounts nobody can sign in with.
 */
export const authOptions = (init: AuthOptionsInit): BetterAuthOptions => ({
  secret: init.secret,
  baseURL: init.baseURL,
  // What better-auth matches a pathname against; the global prefix is what makes
  // the mounted `/auth` route answer here.
  basePath: '/api/auth',
  database: init.database,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // better-auth's own default is JavaScript scrypt; this is `Bun.password`'s
    // native bcrypt. Named rather than left to `AuthModule`'s default because
    // the CLI script has no module to apply one.
    password: bunPassword,
  },
  ...(init.openSignUp ? {} : { disabledPaths: ['/sign-up/email'] }),
  // `admin` puts `role` on the user for `@Roles()`; `bearer` lets a client send a
  // token instead of a cookie. `openAPI()` is what makes `generateOpenAPISchema`
  // exist for `betterAuthDocument` to merge, and `disableDefaultReference` keeps
  // it to one explorer.
  plugins: [admin(), bearer(), openAPI({ disableDefaultReference: true })],
});
