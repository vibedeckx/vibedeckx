import type { FastifyInstance } from "fastify";
import { getLogger } from "./logger.js";
import {
  formatTraceparent,
  newTraceContext,
  runWithTraceContext,
  type TraceContext,
} from "./trace-context.js";

declare module "fastify" {
  interface FastifyRequest {
    traceContext?: TraceContext;
    traceStartMs?: number;
  }
}

/**
 * Install W3C trace-context correlation on a Fastify instance.
 *
 * Register this *first*, before any other onRequest hook: the gates in
 * createServer can return 404 before later hooks run, and those rejections are
 * exactly the ones worth tracing. Establishing the AsyncLocalStorage context
 * here is also what gives every console.* line in the request — including ones
 * in the onError hook and deep inside managers — a trace ID, with no call-site
 * changes (see the console bridge in logger.ts).
 *
 * The same function runs on the hub and on reverse-connect workers, so a
 * traceparent forwarded down the tunnel is continued rather than restarted.
 */
export function registerTraceContext(server: FastifyInstance): void {
  server.addHook("onRequest", (req, _reply, done) => {
    const ctx = newTraceContext(req.headers["traceparent"]);
    req.traceContext = ctx;
    req.traceStartMs = Date.now();
    // Calling done() inside run() puts the rest of the request lifecycle
    // inside this context — Fastify continues the chain from this callback.
    runWithTraceContext(ctx, done);
  });

  // onSend, not onRequest: this also has to land on 404s, gate rejections and
  // handler throws, none of which reach a route handler. The hard requirement
  // is that *every* response carries the ID, or the whole scheme has holes
  // exactly where debugging starts.
  server.addHook("onSend", (req, reply, payload, done) => {
    if (req.traceContext) {
      reply.header("traceparent", formatTraceparent(req.traceContext));
    }
    done(null, payload);
  });

  // Access log, levelled by status. Failures land at warn/error so they are
  // in the default (info) log file: a 4xx returned normally — reply.code(400)
  // rather than a throw — fires no onError, so without this a trace ID copied
  // from a failed response in devtools would match nothing at all. Successes
  // stay at debug, since per-request logging at info would drown real signal
  // (which is why disableRequestLogging is on).
  server.addHook("onResponse", (req, reply, done) => {
    const ctx = req.traceContext;
    if (ctx) {
      const status = reply.statusCode;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "debug";
      getLogger()[level](
        {
          method: req.method,
          // The route *pattern* (/api/projects/:id), not the concrete URL:
          // low-cardinality and structurally incapable of carrying the query
          // string, where WebSocket/SSE auth material rides.
          route: req.routeOptions?.url,
          statusCode: status,
          ms: req.traceStartMs ? Date.now() - req.traceStartMs : undefined,
          continuedTrace: ctx.continued,
        },
        "request completed",
      );
    }
    done();
  });
}
