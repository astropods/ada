/**
 * OpenTelemetry sink — subscribes to the SAME Flue events as the translator
 * (source of truth) and turns them into OTLP traces + metrics for the
 * collector. Follows OTel GenAI semantic conventions (`gen_ai.*`).
 *
 * Traces:  one root span per turn; a child span per tool call (opened on
 *          `tool_start`, closed on the matching `tool`).
 * Metrics: token counters (input/output/cache r+w), a tool-invocation counter
 *          by tool name, and a cost histogram in USD.
 * Cost:    taken from `turn.response.usage.cost.total`, which pi-ai computes
 *          from the model catalog. The hand-maintained pricing table this
 *          module used to fall back to is gone — the catalog covers both the
 *          direct and gateway paths.
 *
 * Degrades to a no-op if `@opentelemetry/api` isn't installed, so the agent
 * runs without the telemetry deps during development. Wire the real SDK +
 * OTLP exporter via the astropods telemetry adapter (see README).
 *
 * Never records the API key or full env as span attributes.
 */

import type { FlueEvent } from "@flue/runtime";

export interface Telemetry {
  onEvent(sessionId: string, ev: FlueEvent): void;
  endSession(sessionId: string): void;
}

const NOOP: Telemetry = { onEvent() {}, endSession() {} };

interface OtelApi {
  trace: {
    getTracer: (name: string) => {
      startSpan: (name: string, opts?: unknown, ctx?: unknown) => { setAttribute: (k: string, v: unknown) => void; end: () => void; setStatus?: (s: unknown) => void };
    };
    setSpan: (ctx: unknown, span: unknown) => unknown;
  };
  context: { active: () => unknown };
  metrics: {
    getMeter: (name: string) => {
      createCounter: (n: string, o?: unknown) => { add: (v: number, a?: Record<string, unknown>) => void };
      createHistogram: (n: string, o?: unknown) => { record: (v: number, a?: Record<string, unknown>) => void };
    };
  };
}

/**
 * Build the real telemetry sink if OTel is present, else a no-op.
 * Assumes an OTLP exporter/provider is configured out-of-process by the
 * astropods adapter (OTEL_EXPORTER_OTLP_ENDPOINT etc.); we only use the API.
 */
export async function createTelemetry(serviceName = "ada"): Promise<Telemetry> {
  let otel: OtelApi;
  try {
    otel = (await import("@opentelemetry/api")) as unknown as OtelApi;
  } catch {
    return NOOP;
  }

  const tracer = otel.trace.getTracer(serviceName);
  const meter = otel.metrics.getMeter(serviceName);
  const inputTokens = meter.createCounter("gen_ai.usage.input_tokens");
  const outputTokens = meter.createCounter("gen_ai.usage.output_tokens");
  const cacheReadTokens = meter.createCounter("gen_ai.usage.cache_read_tokens");
  const cacheWriteTokens = meter.createCounter("gen_ai.usage.cache_creation_tokens");
  const toolInvocations = meter.createCounter("gen_ai.tool.invocations");
  const costUsd = meter.createHistogram("gen_ai.usage.cost_usd");

  type Span = ReturnType<ReturnType<OtelApi["trace"]["getTracer"]>["startSpan"]>;
  interface Ctx {
    root: Span;
    rootCtx: unknown;
    model: string;
    turns: number;
    tokens: { input: number; output: number };
    cost: number;
    toolSpans: Map<string, Span>;
  }
  const ctx = new Map<string, Ctx>();

  return {
    onEvent(sessionId, ev) {
      switch (ev.type) {
        case "agent_start": {
          const root = tracer.startSpan("ada.run");
          root.setAttribute("gen_ai.system", "anthropic");
          root.setAttribute("gen_ai.operation.name", "agent");
          root.setAttribute("ada.session_id", sessionId);
          if (ev.agentName) root.setAttribute("gen_ai.agent.name", ev.agentName);
          ctx.set(sessionId, {
            root,
            rootCtx: otel.trace.setSpan(otel.context.active(), root),
            model: "unknown",
            turns: 0,
            tokens: { input: 0, output: 0 },
            cost: 0,
            toolSpans: new Map(),
          });
          break;
        }
        case "tool_start": {
          const c = ctx.get(sessionId);
          if (!c) break;
          const span = tracer.startSpan("ada.tool", undefined, c.rootCtx);
          span.setAttribute("gen_ai.tool.name", ev.toolName);
          span.setAttribute("gen_ai.tool.call.id", ev.toolCallId);
          c.toolSpans.set(ev.toolCallId, span);
          toolInvocations.add(1, { "gen_ai.tool.name": ev.toolName });
          break;
        }
        case "tool": {
          const c = ctx.get(sessionId);
          const span = c?.toolSpans.get(ev.toolCallId);
          if (!c || !span) break;
          span.setAttribute("ada.tool.is_error", Boolean(ev.isError));
          span.setAttribute("ada.tool.duration_ms", ev.durationMs);
          span.end();
          c.toolSpans.delete(ev.toolCallId);
          break;
        }
        case "turn": {
          const c = ctx.get(sessionId);
          if (!c) break;
          c.turns += 1;
          const model = ev.response?.responseModel;
          if (model) c.model = model;
          const u = ev.response?.usage;
          if (!u) break;
          const attrs = { "gen_ai.request.model": c.model };
          inputTokens.add(u.input, attrs);
          outputTokens.add(u.output, attrs);
          cacheReadTokens.add(u.cacheRead, attrs);
          cacheWriteTokens.add(u.cacheWrite, attrs);
          c.tokens.input += u.input;
          c.tokens.output += u.output;
          const turnCost = u.cost?.total ?? 0;
          c.cost += turnCost;
          costUsd.record(turnCost, { ...attrs, "ada.cost_source": "catalog" });
          break;
        }
        case "agent_end": {
          const c = ctx.get(sessionId);
          if (!c) break;
          c.root.setAttribute("gen_ai.request.model", c.model);
          c.root.setAttribute("gen_ai.usage.input_tokens", c.tokens.input);
          c.root.setAttribute("gen_ai.usage.output_tokens", c.tokens.output);
          c.root.setAttribute("ada.cost_usd", c.cost);
          c.root.setAttribute("ada.num_turns", c.turns);
          c.root.setAttribute("ada.is_error", false);
          break;
        }
        case "submission_settled": {
          const c = ctx.get(sessionId);
          if (!c) break;
          c.root.setAttribute("ada.is_error", ev.outcome !== "completed");
          if (ev.error?.message) c.root.setAttribute("ada.error", ev.error.message);
          break;
        }
      }
    },
    endSession(sessionId) {
      const c = ctx.get(sessionId);
      if (!c) return;
      for (const span of c.toolSpans.values()) span.end(); // close any leaked tool spans
      c.root.end();
      ctx.delete(sessionId);
    },
  };
}
