/** Keep both setup and terminal output; never blindly keep only a giant prefix. */
export function excerptText(text: string, limit: number): { text: string; truncated: boolean } {
  const cap = Math.max(0, Math.floor(limit));
  if (text.length <= cap) return { text, truncated: false };
  if (cap < 80) return { text: text.slice(0, Math.ceil(cap * 0.6)) + text.slice(-Math.floor(cap * 0.4)), truncated: true };
  const marker = `\n… [中段已摘要，原文 ${text.length} 字符] …\n`;
  const head = Math.ceil((cap - marker.length) * 0.55);
  return { text: text.slice(0, head) + marker + text.slice(-(cap - marker.length - head)), truncated: true };
}
