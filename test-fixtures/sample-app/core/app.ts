// purpose: second layer of the demo chain; fan-out hub importing the emitter and the utils leaf
import { onEvent } from './emitter';
import { formatLabel } from '../utils/format.js';

export interface AppOptions {
  mode: string;
}

export function runApp(options: AppOptions): string {
  onEvent({ kind: 'start', mode: options.mode });
  return formatLabel(`app:${options.mode}`);
}
