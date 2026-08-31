/**
 * Compile the agent to one self-contained executable and publish it where the
 * panel serves releases from, so a running fleet can update itself.
 *
 * **Two passes, and the reason is load bearing.** Constructor injection has no
 * runtime annotation, so `@dunx/transform` records each class's dependencies as a
 * statement it appends after the class:
 *
 *   Object.defineProperty(ProbeService, Symbol.for("dunx.deps"), { ... })
 *
 * Handing `Bun.build` both `plugins: [depsPlugin]` and `compile` in one call
 * loses those statements. Measured on Bun 1.4.0: the plugin runs and the marker
 * is present in a plain `outdir` bundle, and the same build with `compile`
 * produces a binary containing the string `dunx.deps` zero times. The binary then
 * fails at boot with "no dependencies were recorded", which reads as a missing
 * preload and is not one.
 *
 * Bundling first and compiling the emitted JavaScript keeps them: by then the
 * markers are ordinary statements in one module rather than something a plugin
 * produced during the same pass.
 *
 *   bun run build:agent    # from the repo root
 */
import { depsPlugin } from '@dunx/transform';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pkg from '../package.json';

const AGENT_DIR = resolve(import.meta.dir, '..');
const BINARY_NAME = 'dunxon-agent';

/** Mirrors AGENT_RELEASE_DIR on the panel. */
const releaseDir =
  process.env['AGENT_RELEASE_DIR'] ?? resolve(AGENT_DIR, '../panel/data/agent');

// The binary reads this same package.json through a bundled JSON import, so the
// version in the manifest and the version the agent reports cannot disagree.
const { version } = pkg;
const outfile = join(releaseDir, BINARY_NAME);

console.log(`Building agent ${version} -> ${outfile}`);
const started = performance.now();

const staging = mkdtempSync(join(tmpdir(), 'dunxon-agent-'));
try {
  const bundled = await Bun.build({
    entrypoints: [join(AGENT_DIR, 'src/main.ts')],
    target: 'bun',
    outdir: staging,
    plugins: [depsPlugin],
    tsconfig: join(AGENT_DIR, 'tsconfig.json'),
  });
  if (!bundled.success) {
    for (const log of bundled.logs) console.error(log);
    throw new AggregateError(bundled.logs, 'Agent bundle failed');
  }

  const compiled = await Bun.build({
    entrypoints: [join(staging, 'main.js')],
    // A standalone executable: the Bun runtime plus the bundle in one file, so a
    // managed host needs nothing installed to run it.
    compile: { outfile },
    target: 'bun',
    minify: true,
    // Debug symbols would add tens of megabytes to something copied to every
    // host, and a stack trace is never read off one of them.
    sourcemap: 'none',
  });
  if (!compiled.success) {
    for (const log of compiled.logs) console.error(log);
    throw new AggregateError(compiled.logs, 'Agent compile failed');
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const bytes = await Bun.file(outfile).bytes();
const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

// The panel serves this beside the binary and the agent verifies the hash before
// swapping itself out. Without it a self-update is a blind overwrite of the one
// process that manages the host.
await Bun.write(
  join(releaseDir, 'manifest.json'),
  `${JSON.stringify(
    {
      version,
      sha256,
      sizeBytes: bytes.byteLength,
      file: BINARY_NAME,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Published ${BINARY_NAME} ${version}, ` +
    `${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}, ` +
    `in ${Math.round(performance.now() - started)}ms -> ${releaseDir}`,
);
