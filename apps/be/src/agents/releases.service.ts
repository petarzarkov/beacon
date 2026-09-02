import { Logger } from '@dunx/core';
import { HttpError, HttpStatusCode } from '@dunx/http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { AppConfigService } from '../config.js';
import { MANIFEST_FILE, type ReleaseManifest } from '@beacon/contract';

/**
 * The panel is the fleet's single distribution point: one binary is placed by
 * hand, and every agent afterwards compares its own version against this
 * manifest and pulls a replacement itself.
 *
 * Nothing here is cached. The release directory is written by
 * `bun run build:agent` while the panel is running, and a cached manifest would
 * mean a published release the fleet cannot see until someone restarts the
 * panel - which is exactly the situation self-update exists to avoid.
 */
export class ReleasesService {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: Logger,
  ) {}

  /** Absolute, so it does not depend on where the panel was started from. */
  get dir(): string {
    const configured = this.config.get('agents').releaseDir;
    return isAbsolute(configured)
      ? configured
      : resolve(process.cwd(), configured);
  }

  /** `null` when nothing has been published yet, which is a state, not an error. */
  manifest(): ReleaseManifest | null {
    const path = join(this.dir, MANIFEST_FILE);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest;
    } catch (error) {
      // A half-written manifest is what a build interrupted mid-write leaves.
      // Reporting "nothing published" keeps the fleet on the version it has,
      // which is the safe reading of an unparseable one.
      this.logger.error('release manifest is unreadable', {
        path,
        err: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  manifestOrThrow(): ReleaseManifest {
    const manifest = this.manifest();
    if (manifest === null) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        'No agent release has been published. Run `bun run build:agent`.',
      );
    }
    return manifest;
  }

  /** Whether an agent on `version` has something newer to pull. */
  isOutdated(version: string): boolean {
    const manifest = this.manifest();
    return manifest !== null && manifest.version !== version;
  }

  /**
   * The published binary as a response.
   *
   * `file` comes from the panel's own manifest, but it is still pinned inside
   * the release directory: a hand-edited manifest would otherwise be a path
   * traversal that reads any file the panel can, to anyone holding an agent
   * token.
   */
  binary(): Response {
    const manifest = this.manifestOrThrow();
    const root = resolve(this.dir);
    const path = resolve(root, manifest.file);
    if (!path.startsWith(`${root}/`)) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        'The published binary is outside the release directory',
      );
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        'The manifest names a binary that is not there',
      );
    }
    return new Response(Bun.file(path), {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${manifest.file}"`,
        // Stated rather than left to the stream: the agent verifies a sha256
        // over the whole body, so a truncated download has to be visible as one.
        'content-length': String(statSync(path).size),
        'x-agent-version': manifest.version,
      },
    });
  }
}
