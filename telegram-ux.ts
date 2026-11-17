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
export function localArtifacts(text: string): {markdown: string; path: string; asDocument?: boolean}[] {
  const found: {markdown: string; path: string; asDocument?: boolean}[] = [];
  for (const m of text.matchAll(/\[[^\]]+\]\((<[^>]+>|[^\n)]+)\)/g)) {
    const titled = m[1].match(/^(.*?)\s+"telegram:document"$/);
    let path = (titled ? titled[1] : m[1]).replace(/^<|>$/g, "").replace(/^file:\/\//, "");
    try { path = decodeURIComponent(path); } catch { continue; }
    if (!path.startsWith("/")) continue;
    found.push({markdown: m[0], path, ...(titled ? {asDocument: true} : {})});
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
