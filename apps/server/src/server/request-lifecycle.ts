import { ServerResponse } from "node:http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Hooks are execution, not completion signals: reply.send() can run from any
// of them while their returned promise is still doing application work.
const REQUEST_HOOKS = new Set([
  "onRequest",
  "preParsing",
  "preValidation",
  "preHandler",
  "preSerialization",
  "onSend",
  "onError",
  "onResponse",
  "onTimeout",
  "onRequestAbort",
]);
type Fn = (this: unknown, ...args: any[]) => any;
type State = {
  active: number;
  ended: boolean;
  abortedBody: boolean;
  drained: boolean;
  lost: boolean;
  external: boolean;
  finite: boolean;
  responseStarted: boolean;
  responseDone: boolean;
  finished: boolean;
  scheduled: boolean;
  reply: FastifyReply;
};

/**
 * Install immediately after Fastify(), BEFORE registering hooks or plugins.
 * Fastify's encapsulated instances inherit these public registration methods.
 * onRoute also instruments route-local hook arrays and error handlers; wrapping
 * later onRoute registrations ensures plugin handler replacements are covered.
 *
 * Application work must belong to the returned promise or callback contract.
 * Callback completion ends its work contract; asynchronous tails must be
 * returned. Detached background work and upgraded/streaming writers need their
 * own authoritative maintenance owners. Losing their socket is not settlement.
 */
export function installRequestLifecycle(
  app: FastifyInstance,
  callbacks: {
    started: (request: FastifyRequest) => void;
    finished: (request: FastifyRequest, statusCode: number) => void;
  }
): void {
  const states = new WeakMap<FastifyRequest, State>();
  const wrapped = new WeakSet<Fn>();
  const schedule = (request: FastifyRequest, state: State) => {
    if (state.finished || state.scheduled) return;
    state.scheduled = true;
    // Let Fastify advance synchronous/callback and promise hook runners first.
    // This is NOT a transport timeout: no elapsed time can retire a request.
    setImmediate(() => {
      state.scheduled = false;
      if (state.finished || state.active !== 0) return;
      if (!state.ended && !state.abortedBody) return;
      if (
        state.responseStarted &&
        !state.responseDone &&
        request.routeOptions.url !== undefined
      )
        return;
      if (!state.drained && !(state.lost && !state.external)) return;
      state.finished = true;
      callbacks.finished(request, state.lost ? 499 : state.reply.statusCode);
    });
  };

  // This first onRequest runs before admission, without an asynchronous gap.
  app.addHook("onRequest", (request, reply, done) => {
    if (!request.url.startsWith("/api/")) return done();
    const state: State = {
      active: 0,
      ended: false,
      abortedBody: false,
      drained: false,
      lost: false,
      external: !!request.headers.upgrade,
      finite: false,
      responseStarted: false,
      responseDone: false,
      finished: false,
      scheduled: false,
      reply,
    };
    states.set(request, state);
    callbacks.started(request);
    const write = reply.raw.write;
    reply.raw.write = function (this: ServerResponse, ...args: any[]) {
      if (!state.finite) state.external = true;
      return write.apply(this, args as Parameters<typeof write>);
    } as typeof write;
    const end = reply.raw.end;
    reply.raw.end = function (this: ServerResponse, ...args: any[]) {
      state.ended = true;
      const result = end.apply(this, args as Parameters<typeof end>);
      // Bun 1.3.13 _http_server.ts: end() returns BEFORE setting finished when
      // its native response is aborted/closed. A healthy end (even buffered)
      // sets finished synchronously. Pin this compatibility path; unknown
      // runtimes fail closed. Never apply it to streams, hijacks or upgrades.
      // https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/node/_http_server.ts#L1314-L1385
      if (
        process.versions.bun === "1.3.13" &&
        this.finished === false &&
        Object.getPrototypeOf(this) === ServerResponse.prototype &&
        end === ServerResponse.prototype.end &&
        this.socket !== null &&
        this.socket === request.raw.socket &&
        !state.external
      )
        state.lost = true;
      schedule(request, state);
      return result;
    } as typeof end;
    const hijack = reply.hijack;
    reply.hijack = function () {
      state.external = true;
      return hijack.call(this);
    };
    reply.raw.on("finish", () => {
      if (reply.raw.writableFinished) state.drained = true;
      schedule(request, state);
    });
    reply.raw.on("close", () => {
      if (reply.raw.writableFinished) state.drained = true;
      else state.lost = true;
      schedule(request, state);
    });
    request.raw.on("aborted", () => {
      state.lost = true;
      // An incomplete body cannot reach a handler through Fastify's parser.
      if (!request.raw.complete) state.abortedBody = true;
      schedule(request, state);
    });
    done();
  });
  app.addHook("onResponse", (request, _reply, done) => {
    const state = states.get(request);
    if (state) state.responseStarted = true;
    done();
  });
  const observePayload = (
    request: FastifyRequest,
    _reply: FastifyReply,
    payload: unknown,
    done: Fn
  ) => {
    const state = states.get(request);
    // Only finite serialized payloads may use disconnected-response retirement.
    if (
      state &&
      payload !== null &&
      payload !== undefined &&
      typeof payload !== "string" &&
      !Buffer.isBuffer(payload)
    ) {
      state.external = true;
    }
    if (state) state.finite = !state.external;
    done(null, payload);
  };
  app.addHook("onSend", observePayload);

  function wrap(fn: Fn, requestIndex = 0, callback = false, hook?: string): Fn {
    if (wrapped.has(fn)) return fn;
    const result: Fn = function (...args) {
      const request = args[requestIndex] as FastifyRequest;
      const state = states.get(request);
      if (!state || state.finished) return fn.apply(this, args);
      state.active++;
      let returned = false;
      let completed = !callback;
      let settled = false;
      const finish = () => {
        if (settled || !returned || !completed) return;
        settled = true;
        state.active--;
        schedule(request, state);
      };
      if (callback) {
        const next = args[args.length - 1];
        args[args.length - 1] = (...values: any[]) => {
          try {
            if (hook === "onResponse" && values[0]) state.responseDone = true;
            return next(...values);
          } finally {
            completed = true;
            finish();
          }
        };
      }
      try {
        const value = fn.apply(this, args);
        if (value && typeof value.then === "function") {
          return value.then(
            (payload: unknown) => {
              const reply = args[requestIndex + 1] as FastifyReply;
              // wrap-thenable deliberately skips send(undefined) on a lost
              // connection. No response/end callback will follow that branch.
              if (
                hook === "handler" &&
                payload === undefined &&
                !state.external &&
                reply.sent === false &&
                reply.raw.headersSent === false &&
                (request.raw.aborted ||
                  !request.raw.socket ||
                  request.raw.socket.destroyed)
              ) {
                state.ended = true;
              }
              returned = true;
              finish();
              return payload;
            },
            (error: unknown) => {
              if (hook === "onResponse") state.responseDone = true;
              returned = true;
              completed = true;
              finish();
              throw error;
            }
          );
        }
        returned = true;
        finish();
        return value;
      } catch (error) {
        if (hook === "onResponse") state.responseDone = true;
        returned = true;
        completed = true;
        finish();
        throw error;
      }
    };
    // Fastify validates callback arity and AsyncFunction shape at registration.
    Object.defineProperty(result, "length", { value: fn.length });
    Object.defineProperty(result, "constructor", { value: fn.constructor });
    wrapped.add(result);
    return result;
  }

  const responseDone = (
    request: FastifyRequest,
    _reply: FastifyReply,
    done: Fn
  ) => {
    const state = states.get(request);
    if (state) {
      state.responseDone = true;
      schedule(request, state);
    }
    done();
  };
  function instrumentRoute(options: Record<string, any>) {
    options.handler = wrap(options.handler, 0, false, "handler");
    if (options.errorHandler)
      options.errorHandler = wrap(options.errorHandler, 1);
    for (const name of REQUEST_HOOKS) {
      const hooks: Fn[] = options[name] ? [].concat(options[name]) : [];
      options[name] = hooks
        .filter((fn) => fn !== responseDone && fn !== observePayload)
        .map((fn) =>
          wrap(
            fn,
            0,
            fn.constructor.name !== "AsyncFunction" &&
              fn.length >=
                (name === "onRequestAbort"
                  ? 2
                  : [
                        "preParsing",
                        "preSerialization",
                        "onSend",
                        "onError",
                      ].includes(name)
                    ? 4
                    : 3),
            name
          )
        );
    }
    options.onSend.push(observePayload);
    options.onResponse.push(responseDone);
  }
  app.addHook("onRoute", instrumentRoute);
  const addHook = app.addHook;
  app.addHook = function (this: FastifyInstance, name: any, fn: any) {
    if (name === "onRoute") {
      const original = fn;
      fn = function (this: unknown, options: Record<string, any>) {
        original.call(this, options);
        instrumentRoute(options);
      };
    } else if (REQUEST_HOOKS.has(name) && typeof fn === "function") {
      fn = wrap(
        fn,
        0,
        fn.constructor.name !== "AsyncFunction" &&
          fn.length >=
            (name === "onRequestAbort"
              ? 2
              : [
                    "preParsing",
                    "preSerialization",
                    "onSend",
                    "onError",
                  ].includes(name)
                ? 4
                : 3),
        name
      );
    }
    return addHook.call(this, name, fn);
  } as typeof app.addHook;
  const setNotFoundHandler = app.setNotFoundHandler;
  app.setNotFoundHandler = function (this: FastifyInstance, ...args: any[]) {
    const options = {
      ...(args.length > 1 ? args[0] : {}),
      handler: args[args.length - 1],
    };
    instrumentRoute(options);
    return (setNotFoundHandler as Fn).call(this, options, options.handler);
  } as typeof app.setNotFoundHandler;
  const addContentTypeParser = app.addContentTypeParser;
  app.addContentTypeParser = function (this: FastifyInstance, ...args: any[]) {
    const index = args.length - 1;
    const fn = args[index];
    args[index] = wrap(
      fn,
      0,
      fn.constructor.name !== "AsyncFunction" && fn.length >= 3
    );
    return (addContentTypeParser as Fn).apply(this, args);
  } as typeof app.addContentTypeParser;
  const setErrorHandler = app.setErrorHandler;
  app.setErrorHandler = function (this: FastifyInstance, fn: any) {
    return setErrorHandler.call(this, wrap(fn, 1));
  } as typeof app.setErrorHandler;
}
