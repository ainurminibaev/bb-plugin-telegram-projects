// С76: every group and every person's private chat of an agent lives in its own folder and BB project, apart from
// the owner's chat. The owner's folder (its local/, outputs/, notes) is then outside the conversation's working
// directory: the agent of a group works and sends files only from its own folder, and gets its own rules.
import {mkdir, writeFile, access, chmod, realpath, symlink, lstat} from "node:fs/promises";
import {join, isAbsolute, resolve, dirname} from "node:path";
import type {Store} from "./model";

export type ConversationKind="group"|"person";
export const conversationProjectKey=(path:string)=>"conversation:project:"+path;

/** The folder name of one conversation: one per group (its topics share it) and one per person. */
export function conversationFolderName(kind:ConversationKind,chatId:number) {
  if (!Number.isSafeInteger(chatId)) throw Error("conversation_chat_invalid");
  return `${kind}-${Math.abs(chatId)}`;
}

/** Rules of the folder: the agent's role comes from one file named by the installer, never the owner's folder. */
export function conversationRules(kind:ConversationKind,title:string,rulesFile:string) {
  const place=kind==="group" ? "группы" : "лички человека";
  return [
    `# Разговор ${place} «${title.replace(/[\r\n]/g," ").slice(0,120)}»`,
    "",
    "Это своя папка этого разговора (С76): работай и храни файлы только здесь.",
    ...(rulesFile ? [`- Правила роли — ${rulesFile}: прочитай их в начале работы и следуй им.`] : []),
    "- Свои заметки и договорённости этого разговора — `local/notes.md`; файлы для отправки в чат — `outputs/`.",
    "- Папка лички владельца и её файлы этому разговору недоступны: не ищи их и не пересылай отсюда.",
    "",
  ].join("\n");
}

const exists=(path:string)=>access(path).then(()=>true,()=>false);

/**
 * С76: a conversation folder is used only when the guest thread guard reaches it — registered for the account
 * (Codex $CODEX_HOME/hooks.json and Claude ~/.claude/settings.json), as setup.py does for own folders. A hook of a new
 * folder would wait for Codex's approval, so the account-level one is required instead.
 */
export async function guardReachesFolders(home:string,codexHome?:string) {
  const {readFile}=await import("node:fs/promises");
  const has=async(path:string)=>(await readFile(path,"utf8").catch(()=>"")).includes("guest-thread-guard.py");
  return await has(join(codexHome || join(home,".codex"),"hooks.json")) && await has(join(home,".claude","settings.json"));
}

/**
 * What a conversation folder takes from the owner's folder by a link, so the agent there keeps the organization's
 * connections and skills (MCP settings hold no values; skills are the organization's): never local/, outputs/ or notes.
 */
export const SHARED_LINKS=[".mcp.json",".codex/config.toml",".claude/skills",".agents/skills"];

/** Creates (or keeps) the folder with outputs/ and local/, and writes its rules once; returns its real path. */
export async function ensureConversationFolder(root:string,kind:ConversationKind,chatId:number,title:string,rulesFile="",
  linkFrom="") {
  if (!root || !isAbsolute(root)) throw Error("conversation_root_invalid");
  const path=join(resolve(root),conversationFolderName(kind,chatId));
  for (const dir of [root,path,join(path,"outputs"),join(path,"local")]) {
    await mkdir(dir,{recursive:true,mode:0o700});
  }
  await chmod(path,0o700);
  const rules=join(path,"AGENTS.md");
  if (!await exists(rules)) await writeFile(rules,conversationRules(kind,title,rulesFile),{mode:0o600,flag:"wx"}).catch(error=>{
    if (error?.code!=="EEXIST") throw error;
  });
  const claude=join(path,"CLAUDE.md");
  // Claude Code reads the role itself through an import; Codex is told to read it in AGENTS.md.
  if (!await exists(claude)) await writeFile(claude,"@AGENTS.md\n"+(rulesFile ? "@"+rulesFile+"\n" : ""),{mode:0o600,flag:"wx"}).catch(error=>{
    if (error?.code!=="EEXIST") throw error;
  });
  if (linkFrom && isAbsolute(linkFrom)) for (const rel of SHARED_LINKS) {
    const source=join(linkFrom,rel), target=join(path,rel);
    if (!await exists(source) || await lstat(target).then(()=>true,()=>false)) continue;
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await symlink(source,target).catch(error=>{ if (error?.code!=="EEXIST") throw error; });
  }
  return realpath(path);
}

type Projects={
  get:(a:{projectId:string})=>Promise<{id:string;sources?:{hostId:string;path:string}[]}>;
  list:(a?:any)=>Promise<{id:string;sources?:{hostId:string;path:string}[]}[]>;
  create:(a:{name:string;source:{type:"local_path";hostId:string;path:string}})=>Promise<{id:string}>;
};

/** The BB project of a folder: remembered, found by its path, or created once. */
export async function ensureConversationProject(store:Store,projects:Projects,hostId:string,path:string,name:string) {
  const key=conversationProjectKey(path);
  const known=store.get<string>(key);
  if (known) {
    const project=await projects.get({projectId:known}).catch(()=>undefined);
    if (project?.sources?.some(s=>s.path===path)) return known;
  }
  const found=(await projects.list()).find(p=>p.sources?.some(s=>s.hostId===hostId && s.path===path));
  const id=found?.id ?? (await projects.create({name:name.slice(0,80) || "Разговор",source:{type:"local_path",hostId,path}})).id;
  if (!id) throw Error("conversation_project_unconfirmed");
  store.put(key,id);
  return id;
}

type Policy=import("./ingress").GroupTopicPolicy;
type MoveDeps={
  store:Store; owner:number; bot:number; ownerProjectId:string; title:string;
  busy:(topicId:number)=>boolean;
  ensureProject:(title:string)=>Promise<string|undefined>;
  projectPath:(projectId:string)=>Promise<string|undefined>;
  thread:(threadId:string)=>Promise<{title?:string|null;providerId?:string|null}|undefined>;
  spawn:(a:{projectId:string;title:string;visibility:"visible";permissionMode:"accept-edits";input:any[];
    environment:{type:"project-default"};providerId?:string})=>Promise<{id?:string;projectId?:string|null}>;
  bind:(policy:Policy,projectId:string)=>void;
  notice:(from:string,to:string,topicId:number,schedules:{moved:string[];left:string[]})=>void;
  /** Subthreads of a thread that are not archived yet: open work that still reports to the previous thread. */
  openChildren:(threadId:string)=>Promise<number>;
  /** The schedules aimed at a thread, moved to another one; ids that could not be moved stay in left. */
  moveSchedules:(from:string,to:string)=>Promise<{moved:string[];left:string[]}>;
};
export const movedKey=(chat:number,topic:number)=>`c76:moved:${chat}:${topic}`;

/** С76: every binding of one chat that still lives in the owner's folder moves to the chat's own folder. */
export async function moveConversation(d:MoveDeps,chatId:number,dryRun=false) {
  const skipped:string[]=[];
  const candidates=d.store.list<Policy>(`group:policy:${chatId}:`).map(row=>row.value)
    .filter(p=>p.botId===d.bot && p.ownerId===d.owner).filter(p=>{
      if (p.ownFolder) { skipped.push(`topic ${p.topicId}: already in its own folder`); return false; }
      if (p.projectId!==d.ownerProjectId) { skipped.push(`topic ${p.topicId}: not in the owner's folder`); return false; }
      if (d.busy(p.topicId)) { skipped.push(`topic ${p.topicId}: a turn is running, try later`); return false; }
      return true;
    });
  // Open work in subthreads reports to the previous thread: such a topic waits until it is done (or force).
  const todo:Policy[]=[];
  for (const p of candidates) {
    const open=await d.openChildren(p.threadId).catch(()=>0);
    if (open) skipped.push(`topic ${p.topicId}: ${open} subthread(s) still open — the move waits until they are done`);
    else todo.push(p);
  }
  if (!todo.length || dryRun) return {moved:todo.map(p=>({topicId:p.topicId,from:p.threadId})),skipped};
  const projectId=await d.ensureProject(d.title);
  if (!projectId) throw Error("conversation_folders_root_not_set");
  const moved:{topicId:number;from:string;to:string;schedules:{moved:string[];left:string[]}}[]=[];
  for (const p of todo) {
    const prior=await d.thread(p.threadId);
    const thread=await d.spawn({projectId,title:prior?.title || d.title,visibility:"visible",permissionMode:"accept-edits",
      input:[{type:"text",visibility:"agent-only",mentions:[],
        text:"This thread now leads the Telegram conversation «"+d.title+"» in its own folder. Wait for a request. Reply with NO_REPLY, without using tools."}],
      environment:{type:"project-default"},...(prior?.providerId && {providerId:prior.providerId})});
    if (!thread.id || thread.projectId!==projectId) throw Error("conversation_thread_unconfirmed");
    // Every enabled schedule of the previous thread moves first; if one cannot, the topic is not moved at all.
    const schedules=await d.moveSchedules(p.threadId,thread.id).catch(()=>({moved:[] as string[],left:["?"]}));
    if (schedules.left.length) {
      if (schedules.moved.length) await d.moveSchedules(thread.id,p.threadId).catch(()=>undefined);
      skipped.push(`topic ${p.topicId}: schedules ${schedules.left.join(", ")} could not be moved — the topic stays`);
      continue;
    }
    d.store.put(movedKey(chatId,p.topicId),{policy:p,at:Date.now()});
    d.bind({...p,threadId:thread.id,ownFolder:true,revision:crypto.randomUUID()},projectId);
    d.notice(p.threadId,thread.id,p.topicId,schedules);
    moved.push({topicId:p.topicId,from:p.threadId,to:thread.id,schedules});
  }
  return {path:await d.projectPath(projectId),projectId,moved,skipped};
}

/** The way back: the saved bindings return to their previous threads in the owner's folder. */
export function restoreConversation(d:{store:Store;bind:(policy:Policy,projectId:string)=>void;
  notice:(from:string,to:string,topicId:number,schedules:{moved:string[];left:string[]})=>void},chatId:number) {
  const restored:{topicId:number;threadId:string}[]=[];
  for (const {key,value} of d.store.list<{policy:Policy}>(`c76:moved:${chatId}:`)) {
    const old=value?.policy;
    if (!old?.threadId || !old.projectId) continue;
    const current=d.store.get<Policy>(`group:policy:${chatId}:${old.topicId}`);
    d.bind({...old,revision:crypto.randomUUID()},old.projectId);
    if (current?.threadId && current.threadId!==old.threadId) d.notice(current.threadId,old.threadId,old.topicId,{moved:[],left:[]});
    d.store.del(key);
    restored.push({topicId:old.topicId,threadId:old.threadId});
  }
  return {restored};
}
