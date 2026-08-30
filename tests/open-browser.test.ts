import { describe, expect, it } from 'vitest';
import { shouldAutoOpen } from '../src/server/open-browser.js';

/**
 * Code-review 2026-08-29: popup policy. A desktop client spawns one server
 * process per project at app open, so popping at startup produced N tabs
 * before the user touched anything; a per-session process popped one tab per
 * new session. shouldAutoOpen only ARMS an instance (index.ts executes the
 * popup on the first real activity). Within one root exactly one instance
 * arms: the preferred-port holder, or a bumped instance whose band walk found
 * no same-root holder. The decision is a pure function so every branch is
 * pinned here.
 */
describe('shouldAutoOpen (armed popup policy)', () => {
  it('arms the preferred-port holder (first instance of a root)', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: false, sameRootHolder: false })).toBe(true);
  });

  it('--no-open overrides everything, including --open', () => {
    expect(shouldAutoOpen({ noOpen: true, forceOpen: true, portBumped: false, sameRootHolder: false })).toBe(false);
  });

  it('stays headless when the band walk found a same-root instance', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: true, sameRootHolder: true })).toBe(false);
  });

  it('arms a bumped instance when the band holds only closed ports / foreign roots', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: false, portBumped: true, sameRootHolder: false })).toBe(true);
  });

  it('--open forces a tab even for a same-root secondary', () => {
    expect(shouldAutoOpen({ noOpen: false, forceOpen: true, portBumped: true, sameRootHolder: true })).toBe(true);
  });
});
