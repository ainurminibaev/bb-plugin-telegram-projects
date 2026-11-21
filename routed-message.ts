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
  if (caption && caption.length<=1024) return caption;
}
