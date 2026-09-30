export interface SharePayload {
  text?: string;
  paths: string[];
}

export function normalizeShareItems(input: { text?: string; files?: string[] }): SharePayload {
  const text = input.text?.trim();
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of input.files ?? []) {
    const path = candidate.trim();
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return text && text.length > 0 ? { text, paths } : { paths };
}
