// purpose: second leaf module; only referenced (imported by store/history.ts) and never imports anything itself
export function log(line: string): void {
  process.stderr.write(`[sample-app] ${line}\n`);
}
