/**
 * Light Markdown for agent replies, shared by the result views: headings, paragraphs, block quotes, (nested) bullet and
 * numbered lists, and inline `code`, **bold** and http(s) links. Pure functions, so they are unit-tested without React.
 */
export type ProseBlock = { kind: "heading"; level: number; text: string } | { kind: "paragraph"; text: string } | { kind: "quote"; text: string }
  | { kind: "list"; items: Array<{ marker: string; depth: number; text: string }> };
export type ProseToken = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "bold"; text: string } | { kind: "link"; text: string; url: string };

// Agent replies are untrusted text: every pattern here is linear in the line or bounded (no nested or overlapping
// quantifiers that can backtrack over a long run of spaces, brackets or hashes).
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+([^\n]*)$/;
const QUOTE = /^\s{0,3}>\s?([^\n]*)$/;
/** `## Title ##` → level 2, "Title". A closing run of `#` needs a space before it (`## C#` keeps its `#`). */
function headingOf(line: string): { level: number; text: string } | null {
  const marks = /^#{1,6}/.exec(line)?.[0].length ?? 0;
  if (!marks || !/\s/.test(line[marks] ?? "")) return null;
  let text = line.slice(marks).trim();
  const closing = /(?:^|\s)#+$/.exec(text);
  if (closing) text = text.slice(0, closing.index).trimEnd();
  return text ? { level: marks, text } : null;
}
/**
 * `code` · [text](https://…) · bare https://… · **bold**. A bare link ends at whitespace, brackets, quotes and any CJK or full-width
 * character (replies often run Chinese text straight after a URL); trailing ASCII punctuation stays outside it. Link text cannot
 * contain `[` and is at most 500 characters, so a run of unclosed brackets is scanned once.
 */
// i18n-ignore: Literal Chinese syntax is matched against provider or user content.
const URL_CHAR = "[^\\s<>()（）\\[\\]\"'`\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]";
const INLINE = new RegExp(`(\`[^\`\\n]+\`)|\\[([^\\[\\]\\n]{1,500})\\]\\((https?:\\/\\/[^\\s)]{1,2000})\\)|(https?:\\/\\/${URL_CHAR}*(?:(?![.,;:!?])${URL_CHAR}))|(\\*\\*[^*\\n]+\\*\\*)`, "g");

export function proseBlocks(chunk: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  let paragraph: string[] = [], quote: string[] = [];
  let list: Extract<ProseBlock, { kind: "list" }> | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    if (quote.length) blocks.push({ kind: "quote", text: quote.join("\n") });
    if (list) blocks.push(list);
    paragraph = []; quote = []; list = null;
  };
  for (const raw of chunk.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.trim()) { flush(); continue; }
    const heading = headingOf(line), item = LIST_ITEM.exec(line), quoted = QUOTE.exec(line);
    if (heading) { flush(); blocks.push({ kind: "heading", ...heading }); continue; }
    if (item) {
      if (paragraph.length || quote.length) flush();
      list ??= { kind: "list", items: [] };
      list.items.push({ marker: /\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•", depth: Math.min(3, Math.floor(item[1]!.replace(/\t/g, "  ").length / 2)), text: item[3]! });
      continue;
    }
    if (quoted) { if (paragraph.length || list) flush(); quote.push(quoted[1]!); continue; }
    // A wrapped line continues the last list item.
    if (list) { const items = (list as Extract<ProseBlock, { kind: "list" }>).items; items[items.length - 1]!.text += `\n${line.trim()}`; continue; }
    if (quote.length) flush();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

export function proseTokens(text: string): ProseToken[] {
  const tokens: ProseToken[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ kind: "text", text: text.slice(last, at) });
    const url = match[3] ?? match[4];
    if (match[1]) tokens.push({ kind: "code", text: match[1].slice(1, -1) });
    else if (url) tokens.push({ kind: "link", text: match[2] ?? url, url });
    else if (match[5]) tokens.push({ kind: "bold", text: match[5].slice(2, -2) });
    last = at + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}
