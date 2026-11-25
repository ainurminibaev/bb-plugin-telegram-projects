/**
 * The form of a message with its formatting and links, as Markdown common to channels (agreed for the split):
 * [text](https://…), **bold**, *italic*, `code`, ```block```, > quote. Underline, spoiler and strikethrough stay plain
 * text; a mention of a person (text_mention) is the name as text — a tg:// link means something only in Telegram.
 * No entities that matter — undefined (the plain text is the whole message).
 */
type Entity = { type: string; offset: number; length: number; url?: string; language?: string };

const KEEP = new Set(["text_link", "bold", "italic", "code", "pre", "blockquote", "expandable_blockquote"]);

export function entitiesToMarkdown(text: string, entities: readonly Entity[] | undefined): string | undefined {
  const used = (entities ?? []).filter(e => KEEP.has(e.type) && e.length > 0 &&
    !(e.type === "text_link" && !/^https?:\/\//i.test(e.url ?? "")));
  if (!used.length) return undefined;
  // Insertions at UTF-16 positions (Telegram offsets are UTF-16, as JavaScript strings): closers before openers at one place.
  const at: { pos: number; text: string; order: number }[] = [];
  for (const e of used) {
    const start = e.offset, end = e.offset + e.length;
    if (e.type === "text_link") { at.push({ pos: start, text: "[", order: 1 }, { pos: end, text: `](${e.url})`, order: 0 }); }
    else if (e.type === "bold") { at.push({ pos: start, text: "**", order: 1 }, { pos: end, text: "**", order: 0 }); }
    else if (e.type === "italic") { at.push({ pos: start, text: "*", order: 1 }, { pos: end, text: "*", order: 0 }); }
    else if (e.type === "code") { at.push({ pos: start, text: "`", order: 1 }, { pos: end, text: "`", order: 0 }); }
    else if (e.type === "pre") { at.push({ pos: start, text: "```" + (e.language ?? "") + "\n", order: 1 }, { pos: end, text: "\n```", order: 0 }); }
    else {
      // A quote: every line of the range starts with «> ».
      at.push({ pos: start, text: "> ", order: 1 });
      for (let i = start; i < end; i++) if (text[i] === "\n") at.push({ pos: i + 1, text: "> ", order: 1 });
    }
  }
  at.sort((a, b) => b.pos - a.pos || b.order - a.order);
  let out = text;
  for (const x of at) out = out.slice(0, x.pos) + x.text + out.slice(x.pos);
  return out === text ? undefined : out;
}

/** Links of a Markdown text, for «the edit dropped these links». */
export function markdownLinks(markdown: string) {
  return [...markdown.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)].map(m => ({ title: m[1], url: m[2] }));
}
