/**
 * Flue event stream  ->  AG-UI event translator.
 *
 * Stateful, per-session. Feed it every `FlueEvent` via `handle()`; it returns
 * zero or more AG-UI events to emit, in order. Pure with respect to I/O — it
 * neither reads a socket nor writes SSE; the caller owns transport. This keeps
 * the mapping unit-testable and lets telemetry subscribe to the same source
 * independently.
 *
 * This replaces the Claude Code `stream-json` translator. The upstream shape
 * changed (Flue emits a flat, typed, versioned event union instead of nested
 * Anthropic message envelopes) but the DOWNSTREAM contract did not: the same
 * AG-UI events go over the same SSE stream, so `public/index.html`, the
 * messaging adapter, and any external AG-UI client are unaffected.
 *
 * Mapping summary:
 *   agent_start                     -> RUN_STARTED (+ STATE_SNAPSHOT of session meta)
 *   message_start                   -> (opens an assistant message id)
 *   text_delta                      -> TEXT_MESSAGE_START (lazily) + TEXT_MESSAGE_CONTENT
 *   message_end                     -> TEXT_MESSAGE_END for the open text message
 *   thinking_start|delta|end        -> REASONING_MESSAGE_START|CONTENT|END
 *   toolcall_delta                  -> TOOL_CALL_START (lazily) + TOOL_CALL_ARGS
 *   tool_start                      -> TOOL_CALL_START/ARGS (if no deltas) + TOOL_CALL_END
 *   tool                            -> TOOL_CALL_RESULT
 *   turn                            -> CUSTOM("ada.usage") — tokens + cost for the turn
 *   log                             -> CUSTOM("ada.log")
 *   compaction                      -> CUSTOM("ada.compaction")
 *   agent_end                       -> RUN_FINISHED
 *   submission_settled failed|abort -> RUN_ERROR
 *
 * Ordering note, because it is easy to get wrong: `toolcall_delta` events are
 * a LIVE PREVIEW of arguments while the model is still emitting them, and
 * `tool_start` fires later, when the call actually executes, carrying the
 * complete `args`. So a tool call may arrive either way round. We open the
 * AG-UI tool call on whichever comes first and close it exactly once, on
 * `tool_start` — never twice, and never on a preview alone (a previewed call
 * that the runtime then drops must not leave a dangling open tool call).
 */

import { EventType, type AguiEvent } from "../types/agui.ts";
import type { FlueEvent } from "@flue/runtime";

export interface TranslatorOptions {
  /** Injectable so runIds are deterministic in tests/demos. Default: random. */
  newRunId?: () => string;
  /** Attach the raw Flue event as AG-UI `rawEvent`. Default true. */
  includeRawEvent?: boolean;
  /** Map Flue `thinking_*` -> REASONING_*. Default false (version-dependent). */
  emitReasoning?: boolean;
}

interface OpenToolCall {
  toolName: string;
  /** True once TOOL_CALL_START has been emitted (by a preview delta or by tool_start). */
  started: boolean;
  /** True once any argument text has been emitted, so tool_start doesn't re-send it. */
  argsStreamed: boolean;
}

export class Translator {
  private threadId: string | null = null;
  private runId: string | null = null;
  private currentMessageId: string | null = null;
  /** The text message currently open, if TEXT_MESSAGE_START has been emitted. */
  private openTextMessageId: string | null = null;
  private openReasoningId: string | null = null;
  private readonly openToolCalls = new Map<string, OpenToolCall>();
  private counter = 0;
  private readonly opts: Required<Omit<TranslatorOptions, "newRunId">> & {
    newRunId?: () => string;
  };

  constructor(opts: TranslatorOptions = {}) {
    this.opts = {
      includeRawEvent: opts.includeRawEvent ?? true,
      emitReasoning: opts.emitReasoning ?? false,
      newRunId: opts.newRunId,
    };
  }

  /** The AG-UI threadId (== the Flue instance id) once known. */
  get sessionThreadId(): string | null {
    return this.threadId;
  }
  get currentRunId(): string | null {
    return this.runId;
  }

  handle(ev: FlueEvent): AguiEvent[] {
    const out = this.dispatch(ev);
    if (this.opts.includeRawEvent) for (const e of out) e.rawEvent = ev;
    return out;
  }

  private dispatch(ev: FlueEvent): AguiEvent[] {
    switch (ev.type) {
      case "agent_start":
        return this.onAgentStart(ev);
      case "message_start":
        this.currentMessageId = messageId(ev.message, ev.turnId);
        return [];
      case "text_delta":
        return this.onTextDelta(ev.text);
      case "message_end":
        return this.closeOpenText();
      case "thinking_start":
        return this.onThinkingStart();
      case "thinking_delta":
        return this.onThinkingDelta(ev.delta);
      case "thinking_end":
        return this.onThinkingEnd();
      case "toolcall_delta":
        return this.onToolCallDelta(ev.toolCallId, ev.toolName, ev.argumentTextDelta);
      case "tool_start":
        return this.onToolStart(ev.toolCallId, ev.toolName, ev.args);
      case "tool":
        return this.onToolResult(ev.toolCallId, ev.isError, ev.result);
      case "turn":
        return this.onTurn(ev.response?.usage, ev.response?.responseModel);
      case "log":
        return [
          {
            type: EventType.CUSTOM,
            name: "ada.log",
            value: { level: ev.level, message: ev.message, attributes: ev.attributes },
          },
        ];
      case "compaction":
        return [
          {
            type: EventType.CUSTOM,
            name: "ada.compaction",
            value: {
              messagesBefore: ev.messagesBefore,
              messagesAfter: ev.messagesAfter,
              isError: ev.isError,
            },
          },
        ];
      case "agent_end":
        return this.onAgentEnd();
      case "submission_settled":
        return ev.outcome === "completed"
          ? []
          : [
              {
                type: EventType.RUN_ERROR,
                message: ev.error?.message ?? `Ada run ${ev.outcome}`,
                code: ev.error?.type ?? ev.outcome,
              },
            ];
      default:
        // turn_start / turn_request / turn_messages / operation* / task* /
        // submission_queued|running|recovery / idle: telemetry-only, no AG-UI event.
        return [];
    }
  }

  private nextRunId(): string {
    return this.opts.newRunId ? this.opts.newRunId() : `run_${++this.counter}_${Date.now()}`;
  }

  private onAgentStart(ev: FlueEvent): AguiEvent[] {
    this.threadId = ev.instanceId ?? ev.conversationId ?? this.threadId ?? "unknown";
    this.runId = this.nextRunId();
    return [
      { type: EventType.RUN_STARTED, threadId: this.threadId, runId: this.runId },
      // Surface session metadata as initial shared state for dashboard views.
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: {
          sessionId: this.threadId,
          agentName: ev.agentName ?? null,
          submissionId: ev.submissionId ?? null,
        },
      },
    ];
  }

  private onTextDelta(text: string): AguiEvent[] {
    if (text.length === 0) return [];
    const out: AguiEvent[] = [];
    if (!this.openTextMessageId) {
      this.openTextMessageId = this.currentMessageId ?? `msg_${++this.counter}`;
      out.push({
        type: EventType.TEXT_MESSAGE_START,
        messageId: this.openTextMessageId,
        role: "assistant",
      });
    }
    out.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: this.openTextMessageId,
      delta: text,
    });
    return out;
  }

  private closeOpenText(): AguiEvent[] {
    if (!this.openTextMessageId) return [];
    const messageId = this.openTextMessageId;
    this.openTextMessageId = null;
    return [{ type: EventType.TEXT_MESSAGE_END, messageId }];
  }

  private onThinkingStart(): AguiEvent[] {
    if (!this.opts.emitReasoning || this.openReasoningId) return [];
    this.openReasoningId = `reasoning_${++this.counter}`;
    return [
      { type: EventType.REASONING_MESSAGE_START, messageId: this.openReasoningId, role: "reasoning" },
    ];
  }

  private onThinkingDelta(delta: string): AguiEvent[] {
    if (!this.opts.emitReasoning || !this.openReasoningId || delta.length === 0) return [];
    return [
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: this.openReasoningId, delta },
    ];
  }

  private onThinkingEnd(): AguiEvent[] {
    if (!this.openReasoningId) return [];
    const messageId = this.openReasoningId;
    this.openReasoningId = null;
    return [{ type: EventType.REASONING_MESSAGE_END, messageId }];
  }

  /**
   * Live preview of a tool call's arguments. `argumentTextDelta` is a JSON
   * string fragment, which is EXACTLY what AG-UI `TOOL_CALL_ARGS.delta`
   * expects — a 1:1 map, as `input_json_delta.partial_json` was before it.
   */
  private onToolCallDelta(toolCallId: string, toolName: string, delta: string): AguiEvent[] {
    const out: AguiEvent[] = [];
    let call = this.openToolCalls.get(toolCallId);
    if (!call) {
      call = { toolName, started: false, argsStreamed: false };
      this.openToolCalls.set(toolCallId, call);
    }
    // Text and tool calls interleave; close any open text message so the client
    // doesn't append tool arguments to the assistant bubble.
    if (!call.started) {
      out.push(...this.closeOpenText());
      out.push({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: toolName,
        parentMessageId: this.currentMessageId ?? undefined,
      });
      call.started = true;
    }
    if (delta.length > 0) {
      out.push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta });
      call.argsStreamed = true;
    }
    return out;
  }

  /**
   * The call is now executing and `args` is complete. Opens the AG-UI tool call
   * if no preview deltas arrived (the non-streaming path), backfills the
   * arguments in that case, and closes the call exactly once.
   */
  private onToolStart(toolCallId: string, toolName: string, args: unknown): AguiEvent[] {
    const out: AguiEvent[] = [];
    const call = this.openToolCalls.get(toolCallId);
    if (!call?.started) {
      out.push(...this.closeOpenText());
      out.push({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName: toolName,
        parentMessageId: this.currentMessageId ?? undefined,
      });
    }
    if (!call?.argsStreamed) {
      out.push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args ?? {}) });
    }
    out.push({ type: EventType.TOOL_CALL_END, toolCallId });
    this.openToolCalls.delete(toolCallId);
    return out;
  }

  private onToolResult(toolCallId: string, isError: boolean, result: unknown): AguiEvent[] {
    return [
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: this.currentMessageId ?? `msg_tool_${toolCallId}`,
        toolCallId,
        content: stringifyToolContent(isError ? { error: result } : result),
        role: "tool",
      },
    ];
  }

  /**
   * Per-turn token usage and cost, as a replayable CUSTOM event.
   *
   * Cost now comes from pi-ai's model catalog rather than a hand-maintained
   * pricing table, so it is correct under the gateway as well as direct.
   */
  private onTurn(usage: FlueUsage | undefined, model: string | undefined): AguiEvent[] {
    if (!usage) return [];
    return [
      {
        type: EventType.CUSTOM,
        name: "ada.usage",
        value: {
          model: model ?? null,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheCreationTokens: usage.cacheWrite,
          totalTokens: usage.totalTokens,
          costUsd: usage.cost?.total ?? null,
          costSource: usage.cost ? "catalog" : "unknown",
        },
      },
    ];
  }

  private onAgentEnd(): AguiEvent[] {
    const out: AguiEvent[] = [...this.closeOpenText(), ...this.onThinkingEnd()];
    // Defensive: close any tool call the runtime previewed but never executed,
    // so the client isn't left with a spinner that never resolves.
    for (const toolCallId of this.openToolCalls.keys()) {
      out.push({ type: EventType.TOOL_CALL_END, toolCallId });
    }
    this.openToolCalls.clear();
    out.push({
      type: EventType.RUN_FINISHED,
      threadId: this.threadId ?? "unknown",
      runId: this.runId ?? "run_unknown",
    });
    return out;
  }
}

interface FlueUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { total: number };
}

/** A Flue message id, falling back to the turn when the message carries none. */
function messageId(message: unknown, turnId: string): string {
  if (message && typeof message === "object" && "id" in message) {
    const id = (message as { id: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return `msg_${turnId}`;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    // array of blocks, e.g. [{type:"text",text:"..."}]
    const texts = content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : null))
      .filter((t): t is string => t !== null);
    if (texts.length) return texts.join("");
  }
  return JSON.stringify(content);
}
