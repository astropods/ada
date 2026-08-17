/**
 * OpenTelemetry wiring.
 *
 * Tracing and the standard GenAI metrics come from `@flue/opentelemetry`, the
 * framework's own instrumentation. This module used to hand-roll that mapping
 * — ~330 lines reimplementing Flue's Cloudflare tracing backend for Node —
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
 *   - `content: false`. Ada works on private repositories; prompts,
 *     completions, and tool payloads must never reach the collector, where
 *     they would be retained. This is a policy decision, so it lives with us.
 *   - A cost histogram. Cost is absent from the GenAI semconv and from Flue's
 *     instrumentation, deliberately — it is provider- and pricing-specific.
 *     But pi-ai computes it per turn, and "tool usage + token usage → money" is
 *     a question this deployment has to answer, so we record the one metric
 *     the framework won't.
 */

import type { FlueEvent } from "@flue/runtime";

/** Emitted alongside the framework's metrics; namespaced so it's clearly ours. */
const COST_METRIC = "gen_ai.usage.cost_usd";

interface CostUsage {
  cost?: { total: number };
}

/**
 * Register Flue's OpenTelemetry instrumentation, plus Ada's cost metric.
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
    meter: { createHistogram(n: string, o?: { unit?: string }): { record(v: number, a?: Record<string, string>): void } };
  };
  try {
    const runtime = (await import("@flue/runtime")) as unknown as Pick<typeof deps, "instrument" | "observe">;
    const otelPkg = (await import("@flue/opentelemetry")) as unknown as Pick<
      typeof deps,
      "createOpenTelemetryInstrumentation"
    >;
    const api = (await import("@opentelemetry/api")) as unknown as {
      metrics: { getMeter(n: string): typeof deps.meter };
    };
    deps = { ...runtime, ...otelPkg, meter: api.metrics.getMeter(serviceName) };
  } catch (e) {
    console.warn(`[ada] telemetry: not installed (${(e as Error).message})`);
    return async () => {};
  }

  // `content: false` opts out of prompt/completion/tool-payload capture
  // entirely. If content is ever wanted, prefer the `transform` hook (redact
  // in place) over flipping this on — see the package's ContentOption.
  const disposeTracing = deps.instrument(deps.createOpenTelemetryInstrumentation({ content: false }));

  const costHistogram = deps.meter.createHistogram(COST_METRIC, { unit: "USD" });
  const disposeCost = deps.observe((event) => {
    if (event.type !== "turn") return;
    const cost = (event.response?.usage as CostUsage | undefined)?.cost?.total;
    if (cost == null) return;
    costHistogram.record(cost, {
      "gen_ai.response.model": event.response?.responseModel ?? "unknown",
      "gen_ai.agent.name": event.agentName ?? "unknown",
    });
  });

  console.log(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? "[ada] telemetry: @flue/opentelemetry registered (traces + metrics, no content capture)"
      : "[ada] telemetry: @flue/opentelemetry registered, but no exporter — spans are discarded",
  );

  return async () => {
    disposeCost();
    await disposeTracing();
  };
}
