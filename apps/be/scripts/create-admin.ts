/**
 * Create the first operator.
 *
 *   bun run create:admin -- --email you@example.com --password 'a good one'
 *
 * There is deliberately no default admin and no public sign-up. This panel
 * restarts machines, so an account on it is a credential for the fleet; handing
 * one out to whoever finds the URL, or shipping one with a known password, is
 * the same mistake twice. Someone with shell access on the panel is the smallest
 * group that can reasonably be trusted to make the first one.
 *
 * Re-running it for an existing email promotes that account to `admin` rather
 * than failing, which is how an operator who was created as a normal user is
 * fixed without a database client.
 */
import { AppFactory, Logger } from '@dunx/core';
import { AppModule } from '../src/app.module.js';
import { createOperator } from '../src/auth/create-operator.js';

const flag = (name: string): string | undefined => {
  const argv = process.argv.slice(2);
  const withEquals = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (withEquals !== undefined) return withEquals.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
};

const email = flag('email');
const password = flag('password');

if (email === undefined || password === undefined) {
  console.error(
    'Usage: bun run create:admin -- --email <email> --password <password> [--name <name>]',
  );
  process.exit(1);
}
if (password.length < 8) {
  console.error('The password must be at least 8 characters.');
  process.exit(1);
}

/**
 * The whole container, not a hand-built connection. `AuthTables.onInit` is what
 * creates better-auth's tables, so a script that opened the database itself
 * would have to duplicate that and would drift from it.
 */
const app = await AppFactory.create(AppModule);
const logger = app.get(Logger);

try {
  const name = flag('name');
  const outcome = await createOperator(app, {
    email,
    password,
    ...(name === undefined ? {} : { name }),
  });
  logger.info(
    outcome === 'created'
      ? `created ${email} as an admin. Sign in at /`
      : `${email} already existed - promoted it to admin`,
  );
} catch (error) {
  logger.error('could not create the operator', {
    err: error instanceof Error ? error.message : String(error),
  });
  await app.shutdown();
  process.exit(1);
}

await app.shutdown();
