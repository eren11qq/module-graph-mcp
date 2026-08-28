// purpose: third layer of the chain reached dynamically from index.ts; also imports the logger leaf
import { log } from '../utils/logger';

export function appendHistory(entry: string): void {
  log(`history:${entry}`);
}
