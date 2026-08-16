/**
 * OpenTelemetry SDK bootstrap.
 *
 * We are NOT a LangChain/Mastra agent, so the Astropods `serve()` telemetry
 * adapters don't apply. The platform's telemetry guidance for other frameworks
 * is: emit via the OTEL SDK using OTEL_EXPORTER_OTLP_ENDPOINT (injected by the
 * runner). That's what this does — it wires the global tracer/meter providers so
 * the spans/metrics produced in telemetry/otel.ts are actually exported.
 *
 * Since the Flue rewrite these are the ONLY spans Ada produces: the agent loop
 * is in-process, so there is no `claude` child emitting native Claude Code OTel
 * alongside them.
 *
 * - Traces are the primary platform view and are ON whenever the endpoint is set.
 *   Per-run tool usage, token counts, and cost all ride on span attributes, so
 *   traces alone answer "tool usage + token usage → money".
 * - Metrics are OPT-IN (OTEL_METRICS_ENABLED=1) — not every collector ingests
 *   OTLP metrics, and we don't want periodic export errors by default.
 *
 * Exporter is OTLP/proto (matches the proven setup in sibling repos). Versions
 * mirror the repos' 0.217.0 train — reconcile at build if the platform bumps.
 *
 * Dynamic imports + guards so `node agent/index.ts` still runs locally without the
 * OTel deps installed (telemetry silently no-ops), matching the demo's design.
 */

let sdk: { shutdown: () => Promise<void> } | null = null;

export async function startTelemetrySdk(): Promise<boolean> {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // ON by default whenever an endpoint is set.
  //
  // This used to be opt-in (BRIDGE_SELF_TELEMETRY=1), because the `claude`
  // child emitted its own native Claude Code OTel and we didn't want to
  // double-emit. Under Flue the agent loop runs in-process: there is no child
  // and no second source, so our spans are the ONLY spans. Leaving this
  // opt-in would have silently exported nothing. Opt OUT with
  // ADA_SELF_TELEMETRY=0.
  if (!endpoint || process.env.ADA_SELF_TELEMETRY === "0") {
    console.log(
      endpoint
        ? "[ada] telemetry off (ADA_SELF_TELEMETRY=0)"
        : "[ada] telemetry off (no OTEL_EXPORTER_OTLP_ENDPOINT)",
    );
    return false;
  }
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-proto");

    const traceExporter = new OTLPTraceExporter(); // reads OTEL_EXPORTER_OTLP_ENDPOINT

    const metricsOn = process.env.OTEL_METRICS_ENABLED === "1";
    let metricReader: unknown;
    if (metricsOn) {
      const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-proto");
      const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
      metricReader = new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
    }

    const instance = new NodeSDK(metricReader ? { traceExporter, metricReader } : { traceExporter });
    instance.start();
    sdk = instance;
    console.log(`[ada] OTel SDK started → ${endpoint} (traces${metricsOn ? " + metrics" : ""})`);
    return true;
  } catch (err) {
    console.warn(`[ada] OTel SDK not started (deps missing or init failed): ${(err as Error).message}`);
    return false;
  }
}

/** Flush and shut down the SDK — call on process exit so short runs don't lose spans. */
export async function shutdownTelemetrySdk(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* best-effort flush */
  }
  sdk = null;
}

/* `claudeCodeTelemetryEnv()` lived here: it set CLAUDE_CODE_ENABLE_TELEMETRY
 * and friends on the spawned `claude` child so the CLI emitted its own OTLP
 * traces. There is no child under Flue, so it has been removed — the spans in
 * telemetry/otel.ts are now the whole picture. */
