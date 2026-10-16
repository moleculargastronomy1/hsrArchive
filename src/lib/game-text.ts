export type GameTextPart = { text: string; ruby?: string };

export function parseGameText(text: string): GameTextPart[] {
  const parts: GameTextPart[] = [];
  const pattern = /\{RUBY_B#((?:[^{}]|\{[^{}]*\})*)\}([\s\S]*?)\{RUBY_E#\}/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > offset) parts.push({ text: text.slice(offset, match.index) });
    // Some annotations contain unresolved game substitutions (e.g. TEXTJOIN).
    // Keep their official base text visible without inventing the annotation.
    parts.push({ text: match[2].trim(), ...(!/[{}]/.test(match[1]) && { ruby: match[1].trim() }) });
    offset = match.index! + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}

export function searchableGameText(text: string): string {
  const parts = parseGameText(text);
  return [parts.map((part) => part.text).join(''), ...parts.map((part) => part.ruby ?? '')]
    .join(' ')
    .trim();
}
