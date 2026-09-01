import {
  UNMATCHED,
  type Middleware,
  type Next,
  type RouteContext,
} from '@dunx/http';
import type { BunRequest } from 'bun';
import { StaticOptions } from '@dunx/http';

/**
 * Serves `index.html` for a path the route table does not own, so a browser
 * reloaded on `/agents/abc` gets the console instead of a 404.
 *
 * `StaticFiles` deliberately has no fallback of its own - it would mean that
 * middleware deciding what a 404 means for paths it does not own. This is that
 * decision, made one layer out, where the app knows a miss is a client route.
 *
 * The four conditions are all doing work:
 *
 * - **`UNMATCHED`** rather than a returned status, because a miss is thrown, and
 *   because it is the only thing that distinguishes "no route" from a handler
 *   that answered 404 on purpose.
 * - **GET only**, or a mistyped `POST /api/agnets` would answer 200 with HTML
 *   and a client would parse the document as its response.
 * - **not `/api`**, so a wrong API path stays a 404 an operator can read.
 * - **`Accept: text/html`**, so `fetch` and `curl` get the 404 they asked for
 *   and only a navigating browser gets the document.
 */
export class SpaFallback implements Middleware {
  readonly #index: string;

  constructor(options: StaticOptions) {
    this.#index = `${options.root}/index.html`;
  }

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    if (ctx.get(UNMATCHED) !== true || req.method !== 'GET') return next();

    const { pathname } = new URL(req.url);
    if (pathname.startsWith('/api')) return next();
    if (!(req.headers.get('accept') ?? '').includes('text/html')) return next();

    const index = Bun.file(this.#index);
    // Absent until `bun run build:fe` has run. Falling through gives the real
    // 404 rather than an empty 200, which is the honest answer for a panel whose
    // console has never been built.
    if (!(await index.exists())) return next();

    return new Response(index, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // The document carries the hashed asset names, so a cached one points at
        // bundles that a later deploy has already removed.
        'cache-control': 'no-cache',
      },
    });
  }
}
