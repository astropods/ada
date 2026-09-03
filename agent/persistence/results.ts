/**
 * Persist the final result of each run for later billing/observability
 * queries — not just streamed to the client and discarded.
 *
 * Captures session id, model, cost, token usage, turn count, duration, and
 * outcome. Interface + an in-memory and a JSONL-file impl for the scaffold;
 * swap for the platform's datastore later.
 *
 * Usage and cost come from Flue's per-turn `turn` events (pi-ai computes cost
 * from the model catalog), accumulated across the turns of one delivery. There
 * is no longer a `total_cost_usd` field reported by an upstream CLI, so the
 * `costSource: "reported" | "computed"` distinction is gone — the catalog is
 * the single basis, direct or gateway.
 */

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface RunRecord extends RunUsage {
  sessionId: string;
  model: string | null;
  numTurns: number;
  durationMs: number | null;
  isError: boolean;
  finishedAt: string; // ISO
}

export function emptyUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

/** Fold one Flue `turn` event's usage into a running total. Mutates `into`. */
export function addTurnUsage(
  into: RunUsage,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost?: { total: number };
  },
): RunUsage {
  into.inputTokens += usage.input;
  into.outputTokens += usage.output;
  into.cacheReadTokens += usage.cacheRead;
  into.cacheCreationTokens += usage.cacheWrite;
  into.totalTokens += usage.totalTokens;
  into.costUsd += usage.cost?.total ?? 0;
  return into;
}

export function toRunRecord(
  sessionId: string,
  model: string | null,
  usage: RunUsage,
  meta: { numTurns: number; durationMs: number | null; isError: boolean },
): RunRecord {
  return {
    sessionId,
    model,
    ...usage,
    // Cost is summed in floating point across turns; round to the cent-fraction
    // the pricing catalog is meaningful at rather than emitting 1e-17 tails.
    costUsd: Math.round(usage.costUsd * 1e6) / 1e6,
    numTurns: meta.numTurns,
    durationMs: meta.durationMs,
    isError: meta.isError,
    finishedAt: new Date().toISOString(),
  };
}

export interface ResultStore {
  save(record: RunRecord): Promise<void>;
}

export class InMemoryResultStore implements ResultStore {
  readonly records: RunRecord[] = [];
  async save(record: RunRecord): Promise<void> {
    this.records.push(record);
  }
}

