import {readFileSync} from "node:fs";
import {isAbsolute} from "node:path";

// Only the trusted administrator writes this file. Telegram and model inputs
// cannot choose its path, the destination or the binding's source list.
export function sourcesVisible(sources:readonly string[] | undefined,bot:number,chat:number,topic:number) {
  if (!sources?.length) return true;
  const path=process.env.BB_TELEGRAM_SOURCE_GRANTS;
  if (!path || !isAbsolute(path)) return false;
  try {
    const grants:unknown=JSON.parse(readFileSync(path,"utf8"))[`${bot}:${chat}:${topic}`];
    return Array.isArray(grants) && sources.every(id=>grants.includes(id));
  } catch {return false;}
}
