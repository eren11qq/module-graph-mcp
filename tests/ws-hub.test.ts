import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { WebSocketServer } from 'ws';
import { WsHub } from '../src/server/http.js';

/**
 * Code-review 2026-08-31: hasOpenClient is the popup rhythm's only view into
 * "does the user visibly have the dashboard". It must count OPEN sockets only
 * — a socket stuck in CONNECTING/CLOSING has no live tab. WsHub never touches
 * its WebSocketServer outside the constructor and reads sockets through
 * readyState/OPEN/send/on, so a hand-rolled fake pins every state without a
 * real handshake.
 */
class FakeSocket {
  readonly OPEN = WebSocket.OPEN;
  readyState: number;
  private readonly handlers = new Map<string, () => void>();

  constructor(readyState: number) {
    this.readyState = readyState;
  }

  on(event: string, cb: () => void): void {
    this.handlers.set(event, cb);
  }

  send(_payload: string): void {
    /* not exercised by hasOpenClient */
  }

  fire(event: string): void {
    this.handlers.get(event)?.();
  }

  asReal(): WebSocket {
    return this as unknown as WebSocket;
  }
}

function newHub(): WsHub {
  return new WsHub({} as unknown as WebSocketServer);
}

describe('WsHub.hasOpenClient', () => {
  it('is false while no socket has ever registered', () => {
    expect(newHub().hasOpenClient()).toBe(false);
  });

  it('is true once an OPEN socket registers', () => {
    const hub = newHub();
    hub.register(new FakeSocket(WebSocket.OPEN).asReal());
    expect(hub.hasOpenClient()).toBe(true);
  });

  it('ignores sockets that are not OPEN', () => {
    const hub = newHub();
    hub.register(new FakeSocket(WebSocket.CONNECTING).asReal());
    hub.register(new FakeSocket(WebSocket.CLOSING).asReal());
    hub.register(new FakeSocket(WebSocket.CLOSED).asReal());
    expect(hub.hasOpenClient()).toBe(false);
  });

  it('returns to false when the OPEN socket closes (register evicts on close)', () => {
    const hub = newHub();
    const socket = new FakeSocket(WebSocket.OPEN);
    hub.register(socket.asReal());
    socket.fire('close');
    expect(hub.hasOpenClient()).toBe(false);
  });

  it('returns to false when the OPEN socket errors (register evicts on error)', () => {
    const hub = newHub();
    const socket = new FakeSocket(WebSocket.OPEN);
    hub.register(socket.asReal());
    socket.fire('error');
    expect(hub.hasOpenClient()).toBe(false);
  });

  it('stays true while any socket remains OPEN after another closes', () => {
    const hub = newHub();
    const dying = new FakeSocket(WebSocket.OPEN);
    const alive = new FakeSocket(WebSocket.OPEN);
    hub.register(dying.asReal());
    hub.register(alive.asReal());
    dying.fire('close');
    expect(hub.hasOpenClient()).toBe(true);
  });
});
