// purpose: the other half of the deliberate circular dependency (state -> emitter -> state)
import { subscribe } from '../core/emitter';

const history: string[] = [];

export function recordState(kind: string): void {
  history.push(kind);
}

export function stateSize(): number {
  return history.length;
}

subscribe(() => {
  /* keep the cycle hot even when unused */
});
