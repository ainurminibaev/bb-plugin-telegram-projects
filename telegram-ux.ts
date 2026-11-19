/** Only public assistant text enters this formatter; never feed reasoning items. */
export function cleanAssistantText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:\/|file:\/\/)[^)]+\)/g, "$1")
    .replace(/@thread:thr_[a-zA-Z0-9]+(?:#msg=\d+)?/g, "рабочая сессия")
    .replace(/\bthr_[a-zA-Z0-9]+\b/g, "рабочая сессия")
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
  // With options.relative an empty label (![](shot.jpg)) and a relative file
  // name with a known artifact extension also count; the caller resolves them.
  const pattern = options.relative ? /!?\[([^\]]*)\]\((<[^>]+>|[^\n)]+)\)/g : /!?\[([^\]]+)\]\((<[^>]+>|[^\n)]+)\)/g;
  for (const m of text.matchAll(pattern)) {
    const titled = m[2].match(/^(.*?)\s+"telegram:document"$/);
    let path = (titled ? titled[1] : m[2]).replace(/^<|>$/g, "").replace(/^file:\/\//, "");
    try { path = decodeURIComponent(path); } catch { continue; }
    const relative = !path.startsWith("/");
    if (relative && !(options.relative && !/^[a-z][a-z0-9+.-]*:/i.test(path) && !path.startsWith("#") &&
        !path.split("/").includes("..") && ARTIFACT_EXTENSIONS.test(path))) continue;
    found.push({markdown: m[0], path, label: m[1], ...(titled ? {asDocument: true} : {}), ...(relative ? {relative: true} : {})});
  }
  return found;
}

/** Split rendered HTML, preserving complete entities, links and balanced tags. */
export function renderTelegramParts(markdown: string): string[] {
  const html = markdownExcerpt(markdown, markdown.length + 1);
  const parts: string[] = [];
  const stack: {open: string; close: string}[] = [];
  let part = "";
  const close = () => stack.slice().reverse().map(t => t.close).join("");
  for (const token of html.match(/<[^>]*>|&(?:#\d+|#x[\da-f]+|\w+);|[^<&]+|[<&]/gi) || []) {
    const chunks = token.startsWith("<") || token.startsWith("&") ? [token] : Array.from(token);
    for (const unit of chunks) {
      if (part.length + unit.length + close().length > 3500 && part) {
        parts.push(part + close()); part = stack.map(t => t.open).join("");
      }
      part += unit;
      const opening = unit.match(/^<(b|i|code|pre|a)(?:\s[^>]*)?>$/);
      if (opening) stack.push({open: unit, close: `</${opening[1]}>`});
      else if (/^<\//.test(unit)) stack.pop();
    }
  }
  if (part) parts.push(part + close());
  return parts;
}
