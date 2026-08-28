// purpose: one half of the deliberate circular dependency (emitter -> state -> emitter); also hit by index.ts as a side-effect import
import { recordState } from '../store/state';

export interface GraphEventLike {
  kind: string;
  mode?: string;
}

const listeners: Array<(event: GraphEventLike) => void> = [];

export function onEvent(event: GraphEventLike): void {
  recordState(event.kind);
  for (const listener of listeners) listener(event);
}

export function subscribe(listener: (event: GraphEventLike) => void): void {
  listeners.push(listener);
}
