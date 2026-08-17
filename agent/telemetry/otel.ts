/**
 * OpenTelemetry instrumentation for Flue, on raw OTel.
 *
 * There is no Astropods adapter for Flue and no Node tracing backend in the
 * framework — `createCloudflareTracing` is Cloudflare-only (it imports
 * `cloudflare:workers`). So this is a hand-written `FlueInstrumentation`,
 * modelled on that reference implementation so the spans it produces are the
 * ones Flue's own backend would produce.
 *
 * ── Why an interceptor and not just the event stream ─────────────────────
 *
 * The obvious approach — subscribe with `observe()` and open/close spans as
 * events arrive — is what this module used to do, and it is subtly wrong. A
 * span built from a pair of events does not WRAP the work: it is created and
 * ended from outside, so nothing running inside the operation is inside the
 * span's context. Every HTTP request the model provider makes, every storage
 * call, lands unparented or attached to whatever happened to be active. You get
 * a flat list of spans instead of a trace.
 *
 * `instrument()` takes both halves, and each does the half it is good at:
 *
 *   observe      the events carry the rich detail (model, usage, finish
 *                reason, tool arguments). They build a PENDING span descriptor.
 *   interceptor  wraps the real operation: `startActiveSpan(...) → next()`.
 *                That gives true durations and makes the span the active
 *                context, so nested instrumentation parents correctly.
 *
 * ── Coverage ─────────────────────────────────────────────────────────────
 *
 * Registered once at boot, globally — NOT from the session runner. The runner's
 * observer returns early for instances it doesn't track, so driving telemetry
 * from there silently missed every session started through Flue's native
 * `/agents/ada/:id` routes.
 *
 * ── Privacy ──────────────────────────────────────────────────────────────
 *
 * Prompts, completions, and tool payloads are deliberately NOT recorded. Ada
 * works on private repositories, and span attributes travel to a collector and
 * are retained. Only shape and metrics are exported: model, token counts, cost,
 * durations, tool names, finish reasons, low-cardinality error types. Never a
 * credential, never a message body.
 */

import type { FlueEvent, FlueExecutionContext, FlueExecutionOperation } from "@flue/runtime";

/** GenAI semantic conventions, matching Flue's own backend exactly. */
const ATTR = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseId: "gen_ai.response.id",
  conversationId: "gen_ai.conversation.id",
  agentName: "gen_ai.agent.name",
  requestStream: "gen_ai.request.stream",
  reasoningLevel: "gen_ai.request.reasoning.level",
  maxTokens: "gen_ai.request.max_tokens",
  temperature: "gen_ai.request.temperature",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadTokens: "gen_ai.usage.cache_read.input_tokens",
  cacheCreationTokens: "gen_ai.usage.cache_creation.input_tokens",
  toolName: "gen_ai.tool.name",
  toolCallId: "gen_ai.tool.call.id",
  toolType: "gen_ai.tool.type",
  errorType: "error.type",
  serverAddress: "server.address",
  serverPort: "server.port",
} as const;

/** Flue-specific attributes, same keys the framework's backend uses. */
const FLUE = {
  instanceId: "flue.instance.id",
  submissionId: "flue.submission.id",
  operationKind: "flue.operation.kind",
  taskId: "flue.task.id",
  toolOrigin: "flue.tool.origin",
  turnPurpose: "flue.turn.purpose",
  finishReason: "flue.response.finish_reason",
  usageTotalTokens: "flue.usage.total_tokens",
  canceled: "flue.canceled",
  forcedClose: "flue.span.forced_close",
  coordinatorPhase: "flue.coordinator.phase",
  costUsd: "flue.usage.cost_usd",
} as const;

type Attrs = Record<string, string | number | boolean | undefined>;

/** Minimal shape of the bits of `@opentelemetry/api` we use. */
interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  end(): void;
}
interface OtelApi {
  trace: {
    getTracer(name: string): {
      startActiveSpan<T>(name: string, fn: (span: OtelSpan) => T): T;
    };
  };
  metrics: {
    getMeter(name: string): {
      createCounter(n: string): { add(v: number, a?: Attrs): void };
      createHistogram(n: string): { record(v: number, a?: Attrs): void };
    };
  };
  SpanStatusCode: { ERROR: number };
}

/**
 * Span names follow the semconv `{operation} {target}` grammar, falling back to
 * the bare operation when the composed name would be unreasonably long — a
 * high-cardinality span name wrecks aggregation.
 */
function spanName(operation: string, target?: string): string {
  if (!target) return operation;
  const name = `${operation} ${target}`;
  return new TextEncoder().encode(name).length <= 64 ? name : operation;
}

/** Error types are a metric dimension, so anything odd collapses to `_OTHER`. */
function lowCardinality(value: string | undefined): string {
  if (!value) return "_OTHER";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : "_OTHER";
}

/**
 * Identity for correlating an event-built descriptor with the interception that
 * opens it. Must use the same fields on both sides or the span never opens.
 */
function keyOf(kind: string, parts: Array<string | undefined>): string {
  return JSON.stringify([kind, ...parts.map((p) => p ?? null)]);
}
const opKey = (v: FlueExecutionContext | FlueEvent) =>
  keyOf("operation", [v.instanceId, v.harness, v.conversationId, v.session, v.taskId, v.operationId]);
const turnKey = (v: FlueExecutionContext | FlueEvent) =>
  keyOf("turn", [v.instanceId, v.harness, v.conversationId, v.session, v.turnId]);
const toolKeyOf = (v: (FlueExecutionContext | FlueEvent) & { toolCallId?: string }) =>
  keyOf("tool", [v.instanceId, v.harness, v.conversationId, v.session, v.toolCallId]);

/**
 * Flue reports `input` as the NON-cached prompt tokens, while semconv's
 * `gen_ai.usage.input_tokens` means every token sent. Summing here is what
 * Flue's own backend does; getting it wrong under-reports spend by the whole
 * cache-read volume, which on a coding agent is most of it.
 */
function usageAttrs(u: FlueUsage | undefined): Attrs {
  if (!u) return {};
  return {
    [ATTR.inputTokens]: u.input + u.cacheRead + u.cacheWrite,
    [ATTR.outputTokens]: u.output,
    [ATTR.cacheReadTokens]: u.cacheRead,
    [ATTR.cacheCreationTokens]: u.cacheWrite,
    [FLUE.usageTotalTokens]: u.totalTokens,
    [FLUE.costUsd]: u.cost?.total,
  };
}

interface FlueUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { total: number };
}

/** A span described by an event, waiting for the interception that opens it. */
interface Pending {
  name: string;
  attributes: Attrs;
  /** The operation span this one belongs to, so it can be swept with it. */
  owner?: string;
  submissionId?: string;
}
interface Active {
  span: OtelSpan;
  ended: boolean;
  owner?: string;
  submissionId?: string;
}

/**
 * Register Flue instrumentation. Returns a dispose function.
 *
 * Degrades to a no-op when `@opentelemetry/api` isn't installed, so the agent
 * still runs in a bare environment.
 */
export async function installTelemetry(serviceName = "ada"): Promise<() => Promise<void>> {
  let otel: OtelApi;
  let instrument: (i: unknown) => () => Promise<void>;
  try {
    otel = (await import("@opentelemetry/api")) as unknown as OtelApi;
    ({ instrument } = (await import("@flue/runtime")) as unknown as {
      instrument: (i: unknown) => () => Promise<void>;
    });
  } catch {
    return async () => {};
  }

  const tracer = otel.trace.getTracer(serviceName);
  const meter = otel.metrics.getMeter(serviceName);
  const mInput = meter.createCounter("gen_ai.usage.input_tokens");
  const mOutput = meter.createCounter("gen_ai.usage.output_tokens");
  const mCacheRead = meter.createCounter("gen_ai.usage.cache_read_tokens");
  const mCacheWrite = meter.createCounter("gen_ai.usage.cache_creation_tokens");
  const mTools = meter.createCounter("gen_ai.tool.invocations");
  const mCost = meter.createHistogram("gen_ai.usage.cost_usd");

  const pending = new Map<string, Pending>();
  const active = new Map<string, Active>();
  let disposed = false;

  const write = (t: Active, attrs: Attrs) => {
    if (t.ended) return;
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== undefined) {
        try {
          t.span.setAttribute(k, v);
        } catch {
          /* an attribute must never break the run */
        }
      }
    }
  };

  const settle = (key: string, t: Active, attrs?: Attrs) => {
    if (t.ended) return;
    if (attrs) write(t, attrs);
    t.ended = true;
    try {
      t.span.end();
    } catch (e) {
      console.error(`[ada:telemetry] failed to end span: ${(e as Error).message}`);
    }
    active.delete(key);
  };

  /** Close a span from its terminal EVENT (which carries the result detail). */
  const endFromEvent = (key: string, attrs: Attrs) => {
    pending.delete(key);
    const t = active.get(key);
    if (!t) return;
    settle(key, t, attrs);
  };

  /** Open a pending span AROUND the real work, so nesting and duration are real. */
  const open = <T>(key: string, p: Pending, next: () => Promise<T>): Promise<T> =>
    tracer.startActiveSpan(p.name, (span) => {
      pending.delete(key);
      const t: Active = { span, ended: false, owner: p.owner, submissionId: p.submissionId };
      active.set(key, t);
      write(t, p.attributes);
      let running: Promise<T>;
      try {
        running = next();
      } catch (e) {
        settle(key, t, failure(e));
        throw e;
      }
      return running.then(
        (v) => v,
        (e) => {
          settle(key, t, failure(e));
          throw e;
        },
      );
    });

  /** A cancellation is a control path, not an error — it must not inflate error rates. */
  const failure = (e: unknown): Attrs => {
    const name = (e as { name?: string })?.name;
    if (name === "AbortError") return { [FLUE.canceled]: true };
    try {
      (e as never) && undefined;
    } catch {
      /* noop */
    }
    return { [ATTR.errorType]: lowCardinality(name) };
  };

  const observe = (event: FlueEvent): void => {
    if (disposed) return;
    switch (event.type) {
      // ---- span descriptions, opened later by the interceptor ----
      case "operation_start": {
        if (event.operationKind !== "prompt" && event.operationKind !== "skill") return;
        if (event.taskId && event.operationKind === "prompt") return;
        pending.set(opKey(event), {
          name: spanName("invoke_agent", event.agentName),
          submissionId: event.submissionId,
          attributes: {
            [ATTR.operationName]: "invoke_agent",
            [ATTR.agentName]: event.agentName,
            [ATTR.conversationId]: event.conversationId,
            [FLUE.instanceId]: event.instanceId,
            [FLUE.submissionId]: event.submissionId,
            [FLUE.operationKind]: event.operationKind,
          },
        });
        return;
      }
      case "turn_request": {
        const r = event.request;
        pending.set(turnKey(event), {
          name: spanName("chat", r.requestedModel),
          owner: event.operationId ? opKey(event) : undefined,
          submissionId: event.submissionId,
          attributes: {
            [ATTR.operationName]: "chat",
            [ATTR.providerName]: r.providerName,
            [ATTR.requestModel]: r.requestedModel,
            [ATTR.requestStream]: true,
            [ATTR.agentName]: event.agentName,
            [ATTR.conversationId]: event.conversationId,
            [ATTR.reasoningLevel]: r.reasoningLevel,
            [ATTR.maxTokens]: r.maxTokens,
            [ATTR.temperature]: r.temperature,
            [ATTR.serverAddress]: r.serverAddress,
            [ATTR.serverPort]: r.serverPort,
            ...(event.purpose !== "agent" ? { [FLUE.turnPurpose]: event.purpose } : {}),
          },
        });
        return;
      }
      case "tool_start": {
        pending.set(toolKeyOf(event), {
          name: spanName("execute_tool", event.toolName),
          owner: event.operationId ? opKey(event) : undefined,
          submissionId: event.submissionId,
          attributes: {
            [ATTR.operationName]: "execute_tool",
            [ATTR.toolName]: event.toolName,
            [ATTR.toolCallId]: event.toolCallId,
            [ATTR.toolType]: "function",
            [ATTR.agentName]: event.agentName,
            [ATTR.conversationId]: event.conversationId,
          },
        });
        mTools.add(1, { [ATTR.toolName]: event.toolName });
        return;
      }

      // ---- terminal events close the matching span ----
      case "turn": {
        const u = event.response?.usage as FlueUsage | undefined;
        const model = event.response?.responseModel;
        if (u) {
          const dims = { [ATTR.requestModel]: model ?? "unknown" };
          mInput.add(u.input + u.cacheRead + u.cacheWrite, dims);
          mOutput.add(u.output, dims);
          mCacheRead.add(u.cacheRead, dims);
          mCacheWrite.add(u.cacheWrite, dims);
          if (u.cost?.total != null) mCost.record(u.cost.total, dims);
        }
        endFromEvent(turnKey(event), {
          [ATTR.responseModel]: model,
          [ATTR.responseId]: event.response?.responseId,
          ...(event.response?.finishReason
            ? { [FLUE.finishReason]: lowCardinality(event.response.finishReason) }
            : {}),
          ...usageAttrs(u),
          ...(event.isError ? { [ATTR.errorType]: lowCardinality(event.response?.error?.type) } : {}),
        });
        return;
      }
      case "tool": {
        endFromEvent(toolKeyOf(event), {
          ...(event.isError ? { [ATTR.errorType]: "tool_error" } : {}),
        });
        return;
      }
      case "operation": {
        const key = opKey(event);
        // Close anything still open beneath this operation before the parent
        // ends, so a child never outlives its parent in the trace.
        for (const [childKey, t] of active) {
          if (childKey !== key && t.owner === key) settle(childKey, t, { [FLUE.forcedClose]: "operation" });
        }
        for (const [childKey, p] of pending) if (p.owner === key) pending.delete(childKey);
        endFromEvent(key, {
          ...usageAttrs(event.usage as FlueUsage | undefined),
          ...(event.isError ? { [ATTR.errorType]: "operation_failed" } : {}),
        });
        return;
      }

      // A settled submission must leave nothing open. Without this, a missed
      // terminal event leaks a span that never ends and never exports.
      case "submission_settled": {
        let swept = 0;
        for (const [key, t] of active) {
          if (t.submissionId !== event.submissionId) continue;
          settle(key, t, { [FLUE.forcedClose]: "settlement" });
          swept += 1;
        }
        for (const [key, p] of pending) if (p.submissionId === event.submissionId) pending.delete(key);
        if (swept > 0) {
          console.warn(`[ada:telemetry] submission ${event.submissionId} settled with ${swept} span(s) open — force-closed`);
        }
        return;
      }
    }
  };

  const interceptor = <T>(
    operation: FlueExecutionOperation,
    ctx: FlueExecutionContext,
    next: () => Promise<T>,
  ): Promise<T> => {
    if (disposed) return next();

    if (operation.type === "coordinator") {
      // Framework bookkeeping. Given its own span so platform-instrumented
      // storage calls group under it rather than landing as unparented noise.
      return tracer.startActiveSpan("flue.coordinator", (span) => {
        const t: Active = { span, ended: false };
        write(t, {
          [FLUE.coordinatorPhase]: operation.phase,
          [FLUE.instanceId]: ctx.instanceId,
          [ATTR.agentName]: ctx.agentName,
        });
        return next().finally(() => {
          t.ended = true;
          try {
            span.end();
          } catch {
            /* best effort */
          }
        });
      });
    }

    let key: string | undefined;
    if (operation.type === "agent") key = opKey({ ...ctx, operationId: operation.operationId });
    else if (operation.type === "model") key = turnKey({ ...ctx, turnId: operation.turnId });
    else if (operation.type === "tool") key = toolKeyOf({ ...ctx, toolCallId: operation.toolCallId });
    if (!key) return next();

    // Already open (a retried interception) or never described by an event —
    // either way, don't open a second span.
    if (active.has(key)) return next();
    const p = pending.get(key);
    if (!p) return next();
    return open(key, p, next);
  };

  const dispose = instrument({ observe, interceptor, dispose: () => {} });

  // Registering is worthwhile even with no exporter wired: spans go to the
  // no-op tracer at negligible cost, and nothing has to be re-registered if a
  // provider shows up. Say so, though — "instrumentation registered" directly
  // under "telemetry off" otherwise reads like a contradiction.
  console.log(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? "[ada] telemetry: Flue instrumentation registered (traces + metrics, no content capture)"
      : "[ada] telemetry: Flue instrumentation registered, but no exporter — spans are discarded",
  );

  return async () => {
    disposed = true;
    for (const [key, t] of active) settle(key, t, { [FLUE.forcedClose]: "dispose" });
    pending.clear();
    await dispose();
  };
}
