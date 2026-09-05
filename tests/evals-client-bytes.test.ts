import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, spawnClient, type SpawnedClient } from '../src/evals/mcp-client.js';

/**
 * 候选 #3 (第二轮架构评审 2026-09-05): the maxBytes budget is a client duty,
 * not a probe-author convention. Pins the three structural under-counts the
 * hand-summed `bytes +=` regime could not express:
 *
 * 1. the initialize reply — probes never saw it, yet it is wire bytes;
 * 2. listTools — the biggest single reply, previously dropped entirely;
 * 3. countExternal — off-wire fetches (HTTP probes) deposit into the SAME
 *    counter, so there is one number and nothing to forget to add.
 */
describe('SpawnedClient.bytesSeen — self-accounting wire budget', () => {
  let client: SpawnedClient;

  beforeAll(async () => {
    client = await spawnClient(join(repoRoot(), 'test-fixtures', 'sample-app'));
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it('the initialize handshake already charged the counter before any probe ran', () => {
    // spawnClient completes the handshake; a probe that calls nothing still
    // owes the server's initialize reply to the budget.
    expect(client.bytesSeen()).toBeGreaterThan(50);
  });

  it('listTools grows the counter (the reply probes used to drop)', async () => {
    const before = client.bytesSeen();
    const names = await client.listTools();
    expect(names.length).toBe(14);
    const grew = client.bytesSeen() - before;
    // Fourteen tool schemas are comfortably over a kilobyte — an uncounted
    // listTools would read as ~0 and silently relax the gate.
    expect(grew).toBeGreaterThan(1000);
  });

  it('countExternal folds off-wire bytes into the same counter', () => {
    const before = client.bytesSeen();
    client.countExternal(1234);
    expect(client.bytesSeen()).toBe(before + 1234);
  });
});
