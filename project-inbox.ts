import {isAbsolute} from "node:path";

/**
 * Received files go to the inbox of the project whose thread gets the message; a project without its own
 * inbox uses the shared one. Setting format: "proj_a=/home/ag1/inbox,proj_b=/srv/b/inbox".
 * The path is the one the project's agent sees; the bridge writes there through the folder's group.
 */
export function projectInboxes(setting:string|undefined) {
  const map=new Map<string,string>();
  for (const part of (setting??"").split(",")) {
    const at=part.indexOf("=");
    if (at<1) continue;
    const project=part.slice(0,at).trim(),path=part.slice(at+1).trim();
    if (/^[\w-]+$/.test(project) && isAbsolute(path) && !path.split("/").includes("..")) map.set(project,path.replace(/\/+$/,""));
  }
  return map;
}

export function inboxFor(setting:string|undefined,shared:string|undefined,projectId:string|undefined) {
  return (projectId && projectInboxes(setting).get(projectId)) || shared || "";
}

export function allInboxes(setting:string|undefined,shared:string|undefined) {
  return [...new Set([shared,...projectInboxes(setting).values()].filter((x):x is string=>!!x))];
}
