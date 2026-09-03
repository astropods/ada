import { test, expect } from "@playwright/test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import * as api from "@opentelemetry/api";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineTool, init, useModel, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import * as v from "valibot";
import { installTelemetry } from "../agent/telemetry/otel.ts";

/**
 * OpenTelemetry wiring, verified against a REAL Flue agent turn.
 *
 * Tracing itself is `@flue/opentelemetry`'s job, so this is not testing the
 * framework — it is testing that WE INSTALLED IT, and installed it with the
 * settings this deployment requires. Both are easy to get silently wrong: a
 * broken or absent trace looks exactly like a working one until someone opens
 * a dashboard, and a content-capture regression looks like nothing at all
 * while quietly shipping private source to a collector.
 *
 * So this drives an actual agent — real runtime, real interceptor, real tool
 * call — against a faux model provider (no network, no credential).
 *
 * The structural assertion that matters most is PARENTING. An earlier
 * hand-written version built spans from the event stream, which produced
 * plausible-looking spans that did not wrap the work: zero durations and no
 * parent/child structure, so nothing nested inside an operation was ever
 * attributed to it. Asserting one correlated trace catches a regression to
 * anything of that shape.
 *
 * Runs as one test because the tracer provider, the context manager, and Flue's
 * runtime are all process-global — `start()` refuses a second registration.
 */

interface CapturedSpan {
  name: string;
  parent: string | null;
  traceId: string;
  durationMs: number;
  attributes: Record<string, unknown>;
}

test("emits a correctly parented GenAI trace for a real agent turn", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  api.trace.setGlobalTracerProvider(provider);
  api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  // Metrics too, because the cost histogram is the one instrument Ada adds
  // itself — the GenAI semconv has no cost metric and Flue deliberately emits
  // none, so nothing but this test would notice it disappearing.
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  api.metrics.setGlobalMeterProvider(meterProvider);

  const dispose = await installTelemetry("ada-test");

  // A scripted model: one tool call, then a final answer. Two model turns and
  // one tool execution, so the trace has something to nest.
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "faux-1", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("ping", { n: 1 }, { id: "call_1" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
  ]);

  const ping = defineTool({
    name: "ping",
    description: "test tool",
    input: v.object({ n: v.number() }),
    async run({ data }) {
      // Long enough that a real (wrapping) span records a duration a
      // zero-width, event-derived span could not.
      await new Promise((r) => setTimeout(r, 25));
      return { output: { pong: data.n } };
    },
  });

  function Probe() {
    useModel("faux/faux-1");
    useTool(ping);
    return "You are a test agent.";
  }
  Probe.agentName = "probe";

  const flue = await start({ agents: [Probe], providers: [faux.provider] });
  try {
    const handle = init(Probe, { id: "probe-1" });
    const reply = await handle.read(await handle.dispatch("go"));
    expect(reply.text).toContain("done");
  } finally {
    await flue.stop();
    await dispose();
  }
  await provider.forceFlush();
  await metricReader.forceFlush();

  const raw = exporter.getFinishedSpans();
  const byId = new Map(raw.map((s) => [s.spanContext().spanId, s]));
  const spans: CapturedSpan[] = raw.map((s) => {
    const pid = (s as { parentSpanContext?: { spanId?: string }; parentSpanId?: string })
      .parentSpanContext?.spanId ?? (s as { parentSpanId?: string }).parentSpanId;
    return {
      name: s.name,
      parent: pid ? (byId.get(pid)?.name ?? "(external)") : null,
      traceId: s.spanContext().traceId,
      durationMs: Number(s.duration[0]) * 1e3 + Number(s.duration[1]) / 1e6,
      attributes: s.attributes as Record<string, unknown>,
    };
  });

  const find = (n: string) => spans.find((s) => s.name === n);

  // ---- semconv span names ------------------------------------------------
  // Dashboards and the GenAI semconv key off these. `ada.run`/`ada.tool` (the
  // previous names) are invisible to anything standard.
  const agent = find("invoke_agent probe");
  const tool = find("execute_tool ping");
  const chats = spans.filter((s) => s.name === "chat faux-1");
  expect(agent, "an invoke_agent span").toBeTruthy();
  expect(tool, "an execute_tool span").toBeTruthy();
  expect(chats.length, "one chat span per model turn").toBe(2);

  // ---- structure ---------------------------------------------------------
  expect(new Set(spans.map((s) => s.traceId)).size, "all spans in one trace").toBe(1);
  expect(agent!.parent, "invoke_agent is the root").toBeNull();
  expect(tool!.parent, "tool nests under the agent").toBe("invoke_agent probe");
  for (const c of chats) expect(c.parent, "chat nests under the agent").toBe("invoke_agent probe");

  // ---- spans WRAP the work ----------------------------------------------
  // The regression guard. An event-derived span opens and closes from outside
  // the operation and records ~0ms; a real one covers the tool's 25ms sleep.
  expect(tool!.durationMs, "tool span covers real execution time").toBeGreaterThan(20);
  expect(agent!.durationMs, "agent span spans the whole turn").toBeGreaterThanOrEqual(tool!.durationMs);

  // ---- attributes --------------------------------------------------------
  expect(agent!.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
  expect(agent!.attributes["gen_ai.agent.name"]).toBe("probe");
  expect(agent!.attributes["flue.instance.id"]).toBe("probe-1");
  expect(agent!.attributes["flue.submission.id"]).toBeTruthy();
  // Correlation keys the framework's instrumentation provides and the previous
  // hand-written mapping did not.
  expect(agent!.attributes["flue.harness.name"], "harness correlation").toBeTruthy();
  expect(agent!.attributes["flue.session.name"], "session correlation").toBeTruthy();

  expect(tool!.attributes["gen_ai.tool.name"]).toBe("ping");
  expect(tool!.attributes["gen_ai.tool.call.id"]).toBe("call_1");
  expect(tool!.attributes["gen_ai.tool.type"]).toBe("function");

  const chat = chats[0];
  expect(chat.attributes["gen_ai.operation.name"]).toBe("chat");
  expect(chat.attributes["gen_ai.provider.name"]).toBe("faux");
  expect(chat.attributes["gen_ai.request.model"]).toBe("faux-1");
  expect(chat.attributes["gen_ai.response.finish_reasons"]).toBeTruthy();

  // Usage must be split across the four buckets. `input_tokens` is the semconv
  // total-sent figure (non-cached + cache read + cache write), not Flue's
  // non-cached `input` — reporting the latter under-counts spend by the whole
  // cache-read volume, which on a coding agent is most of it.
  const totalSent =
    Number(chat.attributes["gen_ai.usage.cache_read.input_tokens"]) +
    Number(chat.attributes["gen_ai.usage.cache_creation.input_tokens"]);
  expect(Number(chat.attributes["gen_ai.usage.input_tokens"])).toBeGreaterThanOrEqual(totalSent);
  expect(chat.attributes["gen_ai.usage.output_tokens"]).toBeDefined();

  // ---- Ada's own cost metric --------------------------------------------
  const metricNames = metricExporter
    .getMetrics()
    .flatMap((m) => m.scopeMetrics)
    .flatMap((sm) => sm.metrics)
    .map((m) => m.descriptor.name);
  expect(metricNames, "the framework's semconv metrics are present").toContain(
    "gen_ai.client.token.usage",
  );
  expect(metricNames, "Ada's cost histogram survives the swap").toContain("gen_ai.usage.cost_usd");

  // ---- cost on the span, not only in metrics ------------------------------
  // A trace UI reads span attributes, not metrics, so without this its Cost
  // column shows "–" even though the tokens are right there. Cost is absent
  // from the GenAI semconv and from Flue's instrumentation, so it is ours to
  // add. The faux provider prices at zero, hence presence rather than
  // magnitude — the guard is against it disappearing.
  expect(
    Object.keys(agent!.attributes),
    "the run span carries a cost attribute",
  ).toContain("gen_ai.usage.cost_usd");

  // ---- no content capture ------------------------------------------------
  // Ada works on private repositories; prompts, completions and tool payloads
  // must never travel to the collector.
  for (const s of spans) {
    for (const key of Object.keys(s.attributes)) {
      expect(key, `no message content on ${s.name}`).not.toMatch(
        /input_messages|output_messages|system_instructions|tool_definitions|arguments|result/,
      );
    }
  }
});
