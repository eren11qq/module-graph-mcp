/**
 * Contract vocabulary for the evals probe suite (trust-loop roadmap PR-2).
 *
 * An EvalTask is one self-contained probe against a COLD-STARTED server:
 * the runner spawns a fresh `dist/server/index.js` per task, hands the
 * client to `probe`, and judges the task red unless every invariant held
 * AND the run stayed inside maxMs / maxBytes. maxBytes is a hard contract
 * (ADR 0001): a probe response that outgrows it turns CI red on purpose.
 */

/** One tools/call reply, shaped for probes: parsed payload + wire size. */
export interface ToolCallOutcome {
  /** Parsed JSON of the first text content entry; undefined when absent/invalid. */
  payload: unknown;
  /** Raw text of the first text content entry ('' when the reply carried none). */
  text: string;
  /** true when the tool reported isError or the transport returned an error. */
  failed: boolean;
  /** JSON-RPC error envelope when the transport itself failed (unknown tool, …). */
  rpcError?: { code: number; message: string };
  /** Byte length of the whole JSON-RPC reply line — the maxBytes gate reads this. */
  bytes: number;
}

/** The slice of an MCP stdio server a probe needs. */
export interface McpClient {
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallOutcome>;
  listTools(): Promise<string[]>;
  /** Kill the spawned server and wait for it to exit. */
  close(): Promise<void>;
}

/** What one probe reports back: invariants held + how many wire bytes it saw. */
export interface ProbeResult {
  /** Sum of the reply sizes the probe counted (bytes gate). */
  bytes: number;
}

/** A probe invariant failed — the runner turns this into a red row + detail. */
export class ProbeFailure extends Error {}

/** Assert an invariant inside a probe; throws ProbeFailure on violation. */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProbeFailure(message);
}

export interface EvalTask {
  /** Stable id; must equal the task file's basename (registry ⇄ disk audit). */
  id: string;
  /** One line: what the probe pins down. */
  description: string;
  /** Hard wall-clock budget for the whole cold-start run, milliseconds. */
  maxMs: number;
  /** Hard wire-size budget: summed reply bytes, bytes. */
  maxBytes: number;
  /**
   * Extra env vars for THIS probe's server spawn (GitNexus port step 6),
   * e.g. MODULE_GRAPH_MCP_READ_ONLY=1 for the read-only-mode probe.
   */
  spawnEnv?: Record<string, string>;
  /** The probe: run against a fresh client; throw ProbeFailure to go red. */
  probe(client: McpClient, fixtureRoot: string): Promise<ProbeResult>;
}
