import { Module, provide } from '@dunx/core';
import { CompressionModule, HttpOptionsProvider } from '@dunx/http';
import { AppHttpOptions } from './http-options.js';
import { RequestTrail, RequestTrailMiddleware } from './request-trail.js';

// `use()` resolves middleware from the container, and every class self-binds - so
// declaring them here is for the reader, not for the resolver.
@Module({
  imports: [
    // Binds `Compression`; the **app** registers it, in `main.ts`, for the same
    // reason `StaticFiles` is registered there. Nothing is installed by importing
    // this, so an app that never calls `app.use(Compression)` has no branch in
    // the request path to skip.
    //
    // The threshold is here to be seen: a body under it is sent as it is,
    // because gzip's header and trailer alone are 18 bytes and a short JSON
    // response comes out larger. A report is well over it, and the fleet's
    // reports are most of this panel's inbound traffic.
    CompressionModule.forRoot({ threshold: 1024 }),
  ],
  providers: [
    // The HTTP settings that read from config, resolved after the container
    // exists. `HttpFactory` promotes a default, so binding this replaces it.
    provide(HttpOptionsProvider, { useClass: AppHttpOptions }),
    RequestTrail,
    RequestTrailMiddleware,
  ],
  exports: [HttpOptionsProvider, RequestTrail, RequestTrailMiddleware],
})
export class HttpModule {}
