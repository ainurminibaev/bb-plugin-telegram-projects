import { stripTelegramMarkers } from "./reply-routing";

const THREAD_REF = String.raw`@thread:thr_[a-zA-Z0-9]+(?:#msg=\d+)?|\bthr_[a-zA-Z0-9]+\b`;
const STATE_VERBS = String.raw`лежит|лежат|находится|находятся|описан[оаы]?|записан[оаы]?|сохранён[оаы]?|сохранен[оаы]?|собран[оаы]?`;
const LINK_WORDS = /^(?:(?:см|тред|треды|треде|треда|подтред|подтреды|подтреде|подтреда|сессия|ссылка|ссылки|thread|threads|подробности|детали|итог|в|во|и)\s*)*$/i;

/**
 * С102: a person in Telegram needs no links to BB threads. A line of nothing but such links (with a label like «Тред:»)
 * goes away; a link inside a sentence becomes words that keep it readable («в рабочем треде»), no dangling words.
 */
export function dropThreadLinks(text: string): string {
  const any = new RegExp(THREAD_REF);
  const lines = text.split("\n").flatMap((line) => {
    if (!any.test(line)) return [line];
    const rest = line.replace(new RegExp(THREAD_REF, "g"), " ").replace(/[\s,;·•*_()\[\]./#>|:—–-]+/g, " ").trim();
    if (LINK_WORDS.test(rest)) return [];
    const r = (body: string, flags = "gi") => new RegExp(body, flags);
    return [line
      .replace(r(String.raw`\[([^\]]+)\]\((?:${THREAD_REF})\)`), "$1")
      .replace(r(String.raw`\s*\((?:см\.?\s*)?(?:${THREAD_REF})(?:\s*[,;]\s*(?:${THREAD_REF}))*\)`), "")
      .replace(r(String.raw`\s*[,—–:-]?\s*см\.?\s+(?:${THREAD_REF})(?:\s*[,;]\s*(?:${THREAD_REF}))*`), "")
      // Words only where the case is certain: a state verb + «в» («лежит в рабочем треде»); otherwise the
      // preposition goes away with the link — shorter rather than wrong («передал задачу, итог ниже»).
      .replace(r(String.raw`(${STATE_VERBS})\s+в\s+(?:(?:под)?тред[еа]?\s+)?(?:${THREAD_REF})`), "$1 в рабочем треде")
      .replace(r(String.raw`\s*(?:(?<=^|[\s(«"])(?:во?|из|про|на|к|по)\s+)?(?:(?:под)?тред[аеуы]?\s+)?(?:${THREAD_REF})`), "")
      .replace(/[ \t]{2,}/g, " ").replace(/\s+([,.;:!?])/g, "$1").replace(/[\s:—–-]+$/u, "").replace(/\(\s*\)/g, "")
      // A link at the start of the line took its words with it: no dash or colon left hanging in front.
      .replace(/^(\s*(?:[-*•]\s+)?)[—–:-]\s*/u, (all, lead: string) => new RegExp(`^\\s*(?:[-*•]\\s+)?(?:${THREAD_REF})`).test(line) ? lead.replace(/^\s+/, "") : all)];
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

/** Only public assistant text enters this formatter; never feed reasoning items. */
export function cleanAssistantText(text: string): string {
  return dropThreadLinks(stripTelegramMarkers(text)
    .replace(/\[([^\[\]\r\n]+)\]\((?:\/|file:\/\/)[^\s()]+\)/g, "$1"))
    .replace(/(?:\/srv\/projects\/|\/root\/|\/Users\/)[^\s<>`"')\]]+/g, (path) => path.split("/").filter(Boolean).pop() || "файл проекта");
}

export function publicActivity(type: string): string {
  const labels: Record<string, string> = {
    commandExecution: "Выполняю шаг задачи…",
    mcpToolCall: "Получаю данные…",
    toolCall: "Работаю с инструментами…",
    fileChange: "Обновляю файлы проекта…",
    webSearch: "Ищу информацию…",
  };
  return labels[type] || "Работаю над задачей…";
}

import { markdownExcerpt } from "./events";

/** Resolve local artifacts before sanitizing visible text. */
/** File types a private chat answer may deliver as Telegram media or documents. */
export const ARTIFACT_EXTENSIONS = /\.(pdf|png|jpe?g|webp|gif|mp4|mov|txt|md|csv|xlsx|docx|pptx|html|json|zip)$/i;
export function localArtifacts(text: string, options: {relative?: boolean} = {}): {markdown: string; path: string; label: string; asDocument?: boolean; relative?: boolean}[] {
  const found: {markdown: string; path: string; label: string; asDocument?: boolean; relative?: boolean}[] = [];
  // Empty labels allow a file without a caption. Relative paths are an
  // opt-in; the caller resolves them inside the permitted workspace.
  const pattern = /!?\[([^\[\]\r\n]*)\]\((<[^>\r\n]+>|[^\r\n)]+)\)/g;
  for (const m of text.matchAll(pattern)) {
    const titled = m[2].match(/^(.*?)\s+"telegram:document"$/);
    let path = (titled ? titled[1] : m[2]).replace(/^<|>$/g, "").replace(/^file:\/\//, "");
    try { path = decodeURIComponent(path); } catch { continue; }
    // A link to a line of a file (path:44, path:44:3, path#L44) still sends the file itself.
    path = path.replace(/(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/, "");
    const relative = !path.startsWith("/");
    if (relative && !(options.relative && !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("#") &&
        !path.split("/").includes("..") && ARTIFACT_EXTENSIONS.test(path))) continue;
    found.push({markdown: m[0], path, label: m[1], ...(titled ? {asDocument: true} : {}), ...(relative ? {relative: true} : {})});
  }
  return found;
}

/** Split rendered HTML, preserving complete entities, links and balanced tags. */
export function renderTelegramParts(markdown: string): string[] {
  // An anchor whose address alone exceeds a message cannot be reopened there.
  // Keep its label and address as visible text so the URL can span messages.
  const html = markdownExcerpt(markdown, markdown.length + 1).replace(
    /<a href="([^"]+)">([^\n]*?)<\/a>/g,
    (link, href:string, label:string) => href.length + 64 > 4096 ? (label===href ? href : label+" ("+href+")") : link,
  );
  const limit = 4096;
  if (html.length <= limit) return html ? [html] : [];
  const units = html.match(/<[^>]+>|&(?:#\d+|#x[\da-f]+|\w+);|./gsu) ?? [];
  type Tag = {open:string; close:string};
  type Boundary = {end:number; tags:Tag[]};
  let start = 0;
  let carried:Tag[] = [];
  const parts:string[] = [];
  while (start < units.length) {
    let tags = carried;
    const opening = carried.map(t=>t.open).join("");
    let length = opening.length;
    let best:Boundary|undefined;
    let priority = -1;
    let end = start;
    for (; end < units.length; end++) {
      const unit = units[end];
      let next = tags;
      if (unit.startsWith("</")) next = tags.slice(0,-1);
      else if (unit.startsWith("<")) next = [...tags,{open:unit,close:"</"+unit.match(/^<(\w+)/)![1]+">"}];
      const reserved = next.reduce((sum,t)=>sum+t.close.length,0);
      if (length+unit.length+reserved > limit) break;
      tags = next;
      length += unit.length;
      // Prefer semantic boundaries in the final third. Earlier ones leave a short message.
      if (length < limit*2/3 || unit.startsWith("<") || tags.some(t=>t.close==="</a>")) continue;
      const previous = units[end-1];
      const rank = unit==="\n" ? (previous==="\n" ? 4 : 3)
        : /\s/u.test(unit) ? (/[.!?…]$/u.test(previous ?? "") ? 2 : 1) : 0;
      if (rank >= priority) { priority=rank; best={end:end+1,tags}; }
    }
    const cut = end===units.length || !best ? {end,tags} : best;
    if (cut.end===start) throw Error("telegram_markup_too_long");
    parts.push(opening+units.slice(start,cut.end).join("")+cut.tags.map(t=>t.close).reverse().join(""));
    start=cut.end;
    carried=cut.tags;
  }
  return parts;
}
