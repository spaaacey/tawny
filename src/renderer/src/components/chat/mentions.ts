/** Text with each `@path` file mention (has a `/` or an extension) split out for pill rendering. */
export function mentionParts(text: string) {
  const out: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(/@[^\s@]+/g)) {
    const hit = m[0].replace(/[,.;:)!?]+$/, '');
    if (!(hit.includes('/') || /\.\w+$/.test(hit))) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), mention: false });
    out.push({ text: hit, mention: true });
    last = m.index + hit.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out;
}
