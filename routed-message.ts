import {formattedCaption} from "./outbound-message";
import {groupImagePath} from "./group-pdf";
import {localArtifacts} from "./telegram-ux";

type ArtifactLink=ReturnType<typeof localArtifacts>[number];

export function routedArtifactKind(link:ArtifactLink) {
  if (link.asDocument || link.path.startsWith("/telegram-input/")) return "document";
  if (/\.pdf$/i.test(link.path)) return "pdf";
  if (groupImagePath.test(link.path)) return "image";
  return "document";
}

export function routedCaption(text:string,links:ArtifactLink[]) {
  if (new Set(links.map(link=>link.path)).size!==1) return;
  const caption=links.reduce((body,link)=>body.replace(link.markdown,""),text).trim();
  // Telegram HTML of the agent's Markdown (bold, lists, links): sent with parse_mode HTML, plain words if rejected.
  if (caption) return formattedCaption(caption);
}
