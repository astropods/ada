/**
 * OpenTelemetry wiring.
 *
 * Tracing and the standard GenAI metrics come from `@flue/opentelemetry`, the
 * framework's own instrumentation. This module used to hand-roll that mapping
 * — ~440 lines reimplementing Flue's Cloudflare tracing backend for Node —
 * because the official package was missed: it isn't re-exported from
 * `@flue/runtime`, and the only tracing symbol visible there is
 * `createCloudflareTracing`. It is a sibling package, versioned in lockstep.
 *
 * Using it is strictly better than what it replaced. Beyond being maintained
 * against Flue's event union rather than drifting from it, it emits correlation
 * attributes the hand-written version lacked (`flue.harness.name`,
 * `flue.session.name`, `flue.operation.id`, `flue.turn.id`, `flue.tool.origin`),
 * the correct plural `gen_ai.response.finish_reasons`, the full semconv metric
 * set, and it offers a content `transform` hook and a GenAI log-event logger
 * that the local version had no equivalent for.
 *
 * What is left here is the part that genuinely isn't the framework's job:
 *
 *   - The content policy. Traces carry prompts, completions and tool payloads,
 *     scrubbed for credentials on the way out (see CONTENT POLICY below).
 *   - A cost histogram. Cost is absent from the GenAI semconv and from Flue's
 *     instrumentation, deliberately — it is provider- and pricing-specific.
 *     But pi-ai computes it per turn, and "tool usage + token usage → money" is
 *     a question this deployment has to answer, so we record the one metric
 *     the framework won't.
 *
 * ── CONTENT POLICY ────────────────────────────────────────────────────────
 *
 * Content capture is ON, through the instrumentation's `transform` hook.
 *
 * This reverses the earlier `content: false`, and the reasoning it reverses was
 * sound as far as it went: Ada works on private repositories, and everything
 * the model reads or writes is repository content. What that setting also
 * bought, though, was a trace that could tell you an `execute_tool bash` span
 * took 40 seconds and not what it ran — which is the first question anyone
 * opening a trace has, and the reason they opened it. Answering "what did the
 * agent actually do" is the job.
 *
 * So the trade is made explicitly rather than by omission:
 *
 *   - Everything is scrubbed for CREDENTIALS first (telemetry/redact.ts). That
 *     covers the shapes that are catastrophic and recognisable — App tokens,
 *     cloud keys, JWTs, PEM blocks, `Authorization:` headers, `SECRET=` values,
 *     credentials embedded in a clone URL.
 *   - It does NOT scrub repository content, and cannot: that is the payload the
 *     operator asked to see. THE COLLECTOR NOW HOLDS SOURCE CODE. Its retention
 *     and access controls have to be set accordingly — that is a deployment
 *     decision this module can only surface, which is why it is logged loudly
 *     at startup.
 *   - `ADA_TRACE_CONTENT=off` restores the previous behaviour with no deploy.
 *
 * Flue caps content at 56 KiB per span itself, so size is the framework's
 * problem rather than ours.
 */

import type { FlueEvent } from "@flue/runtime";
import { redactContent } from "./redact.ts";

/**
 * Resolve the content policy from the environment.
 *
 * Two states on purpose. A third — content on with no scrubbing — would be
 * useful about once a year, for debugging the scrubber itself, and would be
 * available by accident for the rest of the time.
 *
 * Exported for tests: `installTelemetry` registers process-global providers and
 * can only run once, so the switch itself has to be checkable on its own.
 */
export function contentPolicy(env: NodeJS.ProcessEnv = process.env): false | { transform: (c: unknown) => unknown } {
  const setting = (env.ADA_TRACE_CONTENT ?? "").toLowerCase();
  if (setting === "off" || setting === "0" || setting === "false") return false;
  // The hook's signature also passes a scope (contentType, agent, session ids).
  // Unused: the scrubber's job is the same for a prompt, a tool argument and a
  // tool result, and branching on scope is how a gap gets introduced.
  return { transform: (content: unknown) => redactContent(content) };
}

/** Emitted alongside the framework's metrics; namespaced so they're clearly ours. */
const COST_METRIC = "gen_ai.usage.cost_usd";
const REVIEW_RUNS_METRIC = "ada.review.runs";
const REVIEW_FINDINGS_METRIC = "ada.review.findings";

/** The subagent whose task results carry review findings. */
const REVIEWER_AGENT = "code-reviewer";

interface CostUsage {
  cost?: { total: number };
}

interface ReviewResult {
  findings?: Array<{ severity?: string; category?: string }>;
}

/**
 * Pull findings out of a reviewer task result.
 *
 * A delegate's contract is its task result as TEXT — `defineSubagent` takes no
 * output schema — so the reviewer writes prose for a human and ends with a
 * fenced `json` block for counting (see the brief in security/reviewer.ts). An
 * earlier version parsed the whole result as JSON, which prose never satisfies,
 * so this metric silently counted nothing.
 *
 * Tolerant by design: a model that omits or malforms the block costs us a data
 * point, never a run.
 *
 * Exported for tests: it is the one piece of parsing here that can silently
 * stop working, which is exactly what happened to its predecessor.
 */
export function parseReview(result: unknown): ReviewResult | null {
  if (result && typeof result === "object" && "findings" in result) return result as ReviewResult;
  if (typeof result !== "string") return null;

  // Last fenced json block, so a block quoted earlier in the prose loses to the
  // real summary at the end.
  const blocks = [...result.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidate = blocks.length > 0 ? blocks[blocks.length - 1][1] : result;
  try {
    const parsed = JSON.parse(candidate.trim()) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ReviewResult;
  } catch {
    /* no usable block — nothing to count */
  }
  return null;
}

/**
 * Register Flue's OpenTelemetry instrumentation, plus Ada's own metrics
 * (cost, and code-review outcomes).
 * Returns a dispose function.
 *
 * Degrades to a no-op if the OTel API or the instrumentation package isn't
 * installed, so the agent still runs in a bare environment.
 */
export async function installTelemetry(serviceName = "ada"): Promise<() => Promise<void>> {
  let deps: {
    instrument: (i: unknown) => () => Promise<void>;
    observe: (fn: (e: FlueEvent) => void) => () => void;
    createOpenTelemetryInstrumentation: (o: unknown) => unknown;
    meter: {
      createHistogram(n: string, o?: { unit?: string }): { record(v: number, a?: Record<string, string>): void };
      createCounter(n: string, o?: { unit?: string }): { add(v: number, a?: Record<string, string>): void };
    };
    activeSpan(): { setAttribute(k: string, v: number | string): void } | undefined;
  };
  try {
    const runtime = (await import("@flue/runtime")) as unknown as Pick<typeof deps, "instrument" | "observe">;
    const otelPkg = (await import("@flue/opentelemetry")) as unknown as Pick<
      typeof deps,
      "createOpenTelemetryInstrumentation"
    >;
    const api = (await import("@opentelemetry/api")) as unknown as {
      metrics: { getMeter(n: string): typeof deps.meter };
      trace: { getActiveSpan(): ReturnType<typeof deps.activeSpan> };
    };
    deps = {
      ...runtime,
      ...otelPkg,
      meter: api.metrics.getMeter(serviceName),
      activeSpan: () => api.trace.getActiveSpan(),
    };
  } catch (e) {
    console.warn(`[ada] telemetry: not installed (${(e as Error).message})`);
    return async () => {};
  }

  const content = contentPolicy();
  const disposeTracing = deps.instrument(deps.createOpenTelemetryInstrumentation({ content }));

  const costHistogram = deps.meter.createHistogram(COST_METRIC, { unit: "USD" });
  const reviewRuns = deps.meter.createCounter(REVIEW_RUNS_METRIC);
  const reviewFindings = deps.meter.createCounter(REVIEW_FINDINGS_METRIC);

  // The reviewer subagent's SPANS come free — Flue emits `task` operations and
  // the framework instrumentation traces them as nested `invoke_agent`. What it
  // cannot know is what a review CONCLUDED, which is the number worth watching:
  // findings by severity tells you whether the reviewer is earning its cost, or
  // whether it has quietly started returning nothing on every change.
  /**
   * Running cost per agent operation, so the span attribute is the TOTAL rather
   * than the last turn's. Keyed on the operation id and dropped when it ends —
   * a long conversation must not accumulate entries forever.
   */
  const costByOperation = new Map<string, number>();

  const disposeMetrics = deps.observe((event) => {
    if (event.type === "turn") {
      const cost = (event.response?.usage as CostUsage | undefined)?.cost?.total;
      if (cost == null) return;
      costHistogram.record(cost, {
        "gen_ai.response.model": event.response?.responseModel ?? "unknown",
        "gen_ai.agent.name": event.agentName ?? "unknown",
      });

      // Also put it on the span. Cost is absent from the GenAI semconv and from
      // Flue's instrumentation, so a trace UI has nothing to show in its Cost
      // column — it reads span attributes, not metrics. On a `turn` event the
      // active span is the enclosing `invoke_agent` (the `chat` span has
      // already been closed by the framework), which is the right place for a
      // per-run total anyway.
      const op = event.operationId;
      if (op) {
        const total = (costByOperation.get(op) ?? 0) + cost;
        costByOperation.set(op, total);
        deps.activeSpan()?.setAttribute(COST_METRIC, Math.round(total * 1e6) / 1e6);
      }
      return;
    }
    if (event.type === "operation" && event.operationId) {
      costByOperation.delete(event.operationId);
      return;
    }
    if (event.type === "task" && event.agent === REVIEWER_AGENT) {
      reviewRuns.add(1, { "ada.review.outcome": event.isError ? "error" : "ok" });
      const review = parseReview(event.result);
      for (const f of review?.findings ?? []) {
        reviewFindings.add(1, {
          "ada.review.severity": f.severity ?? "unknown",
          "ada.review.category": f.category ?? "unknown",
        });
      }
    }
  });

  // Loud, and specifically about the content, because "the collector now holds
  // repository source" is a deployment fact an operator has to act on and
  // cannot discover from a dashboard until it is already true.
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.log("[ada] telemetry: @flue/opentelemetry registered, but no exporter — spans are discarded");
  } else if (content === false) {
    console.log("[ada] telemetry: registered (traces + metrics, content capture OFF)");
  } else {
    console.warn(
      "[ada] telemetry: registered WITH content capture — prompts, completions and tool " +
        "payloads are exported (credentials scrubbed, repository content is NOT). " +
        "Set ADA_TRACE_CONTENT=off to disable.",
    );
  }

  return async () => {
    disposeMetrics();
    await disposeTracing();
  };
}
