// purpose: pure leaf module that imports nobody; proves leaf nodes survive the graph scan untouched
export function formatLabel(raw: string): string {
  return raw.trim().toLowerCase();
}
