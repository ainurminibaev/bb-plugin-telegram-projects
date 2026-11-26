import {execFile} from "node:child_process";
import {join} from "node:path";
import type {Conversation} from "./archive-access";
import type {Store} from "./model";
import type {GroupTopicPolicy} from "./ingress";
import {isSharedOwnerPolicy} from "./group-binding";
import {groupTopics} from "./send-command";
import {forumName} from "./forum-defaults";
import {isTopicPaused} from "./topic-lifecycle";
import {writeJsonAtomic} from "./json-file";
import {agentText} from "./outbound-message";
import {decideChoice} from "./turn-feedback";

export interface WaitingConfig {
  waitingMarkEnabled:boolean; waitingMarkChatId:string; waitingMarkExcludedTopics:string;
  waitingNotifyCommand:string; decideCommand:string; companionDir:string;
}
type Reason="ask"|"interaction"|"reply";
type RecordState={chatId:number;topicId:number;waiting:boolean;reason?:Reason;messageId?:number;
  activitySeq:number;updatedAt:number;notifiedWaiting?:boolean;interactionIds?:string[]};
type Change={version:1;botId:number;chatId:number;topicId:number;name:string;waiting:boolean;reason?:Reason;messageId?:number;changedAt:number};
const key=(bot:number,chat:number,topic:number)=>`waiting:topic:${bot}:${chat}:${topic}`;
const exclusions=(bot:number,chat:number)=>`waiting:excluded:${bot}:${chat}`;

export async function checkReplyWaitsOwner(input:string,choose:ReturnType<typeof decideChoice>) {
  try {return await choose(input,"Ждёт ли последнее сообщение ответа, решения или подтверждения владельца?",
    [{value:"yes",description:"Ждёт ответа"},{value:"no",description:"Отчёт или справка без вопроса"}])==="yes";}
  catch {return false;}
}

export function createWaitingNotifier(send:(change:Change)=>Promise<void>,success:(change:Change)=>void,
  log:()=>void,active:(change:Change)=>boolean) {
  type Slot={change:Change;failures:number;last:number;busy:boolean;timer?:NodeJS.Timeout};
  const slots=new Map<string,Slot>();
  function schedule(s:Slot,delay:number) {
    clearTimeout(s.timer);
    s.timer=setTimeout(async ()=>{
      const c=s.change;
      const id=key(c.botId,c.chatId,c.topicId);
      if (!active(c)) {slots.delete(id);return;}
      s.busy=true;s.last=Date.now();
      let failed=false;
      try {await send(c);success(c);} catch {failed=true;}
      s.busy=false;
      if (s.change!==c) schedule(s,Math.max(0,2500+s.last-Date.now()));
      else if (failed && ++s.failures<10) schedule(s,[5000,30000,120000][s.failures-1] ?? 600000);
      else {
        if (failed) log();
        s.timer=setTimeout(()=>slots.delete(id),Math.max(0,2500+s.last-Date.now())).unref();
      }
    },delay).unref();
  }
  return (change:Change)=>{
    const id=key(change.botId,change.chatId,change.topicId);
    const s=slots.get(id) ?? {change,failures:0,last:0,busy:false};
    s.change=change;s.failures=0;slots.set(id,s);
    if (!s.busy) schedule(s,Math.max(0,2500+s.last-Date.now()));
  };
}

export class WaitingMarks {
  constructor(private store:Store,private config:()=>WaitingConfig|undefined,
    private identity:()=>{bot?:number;owner?:number},private choose?:ReturnType<typeof decideChoice>,
    private recent?:(bot:number,chat:number,topic:number,before:number)=>string[]|undefined) {}
  private generation=0;
  reset() {
    this.generation++;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
  private pending=new Map<string,{chat:number;topic:number;seq:number;text:string;id:number;turn:string;timer:NodeJS.Timeout}>();
  private writing=Promise.resolve();
  private notify=createWaitingNotifier(c=>new Promise<void>((resolve,reject)=>{
    const child=execFile(this.config()!.waitingNotifyCommand,[],{timeout:10000,killSignal:"SIGKILL"},err=>err?reject(err):resolve());
    child.stdin?.on("error",reject);child.stdin?.end(JSON.stringify(c)+"\n");
  }),c=>{
    const k=key(c.botId,c.chatId,c.topicId),r=this.store.get<RecordState>(k);
    if (r) this.store.put(k,{...r,notifiedWaiting:c.waiting});
  },()=>console.warn("waiting: внешняя команда не сработала после 10 попыток"),
  c=>!!this.config()?.waitingMarkEnabled && this.identity().bot===c.botId);
  private forum() {
    const cfg=this.config(),{bot,owner}=this.identity();
    if (!cfg?.waitingMarkEnabled || !bot || !owner) return null;
    const policies=this.store.list<GroupTopicPolicy>("group:policy:").map(row=>row.value);
    return policies.find(p=>p.botId===bot && p.ownerId===owner && isSharedOwnerPolicy(p) &&
      (!cfg.waitingMarkChatId || Number(cfg.waitingMarkChatId)===p.chatId))?.chatId ?? null;
  }
  own(chat:number,topic:number) {
    return this.forum()===chat && this.topicAllowed(chat,topic);
  }
  private topicAllowed(chat:number,topic:number) {
    const p=this.store.get<GroupTopicPolicy>(`group:policy:${chat}:${topic}`);
    if (!p) return topic>=2 && !!forumName(this.store,this.identity().bot!,chat,topic);
    const {bot,owner}=this.identity();
    return p.botId===bot && p.ownerId===owner && isSharedOwnerPolicy(p);
  }
  private excluded(chat:number,topic:number) {
    const bot=this.identity().bot!;
    const names=this.config()!.waitingMarkExcludedTopics.split(",").map(x=>x.trim()).filter(Boolean);
    return names.includes(String(topic)) || names.includes(forumName(this.store,bot,chat,topic) ?? "") ||
      !!this.store.get<number[]>(exclusions(bot,chat))?.includes(topic);
  }
  eligible(chat:number,topic:number) {
    return topic>=2 && this.own(chat,topic) && !this.excluded(chat,topic) && !isTopicPaused(this.store,this.identity().bot!,chat,topic);
  }
  private read(chat:number,topic:number) {
    return this.store.get<RecordState>(key(this.identity().bot!,chat,topic));
  }
  seq(chat:number,topic:number) {return this.read(chat,topic)?.activitySeq ?? 0;}
  private update(chat:number,topic:number,waiting:boolean,reason?:Reason,messageId?:number,interactionIds?:string[]) {
    const bot=this.identity().bot!,old=this.read(chat,topic),now=Date.now();
    this.store.put(key(bot,chat,topic),{chatId:chat,topicId:topic,waiting,reason,messageId,
      interactionIds:interactionIds ?? old?.interactionIds,activitySeq:(old?.activitySeq ?? 0)+1,
      updatedAt:now,notifiedWaiting:old?.notifiedWaiting} satisfies RecordState);
    if (waiting===!!old?.waiting) {
      if (waiting && (reason!==old?.reason || messageId!==old?.messageId)) this.publish();
      return;
    }
    if (this.config()?.waitingNotifyCommand) this.notify({version:1,botId:bot,chatId:chat,topicId:topic,
      name:forumName(this.store,bot,chat,topic) ?? String(topic),waiting,reason,messageId,changedAt:now});
    this.publish();
  }
  publish() {
    const dir=this.config()?.companionDir;
    if (dir) this.writing=this.writing.then(async ()=>{
      if (this.config()?.waitingMarkEnabled) await writeJsonAtomic(join(dir,"telegram-waiting.json"),this.snapshot());
    }).catch(()=>console.warn("waiting: запись снимка не удалась"));
  }
  clear(chat:number,topic:number) {
    if (topic>=2 && this.own(chat,topic)) this.update(chat,topic,false);
  }
  mark(chat:number,topic:number,reason:Reason,id?:number) {
    if (this.eligible(chat,topic)) this.update(chat,topic,true,reason,id);
  }
  interactions(chat:number,topic:number,ids:string[],seq:number) {
    if (!this.eligible(chat,topic)) return;
    const old=this.read(chat,topic),previous=old?.interactionIds ?? [];
    if (this.seq(chat,topic)===seq && ids.some(id=>!previous.includes(id))) this.update(chat,topic,true,"interaction",undefined,ids);
    else if (old && (previous.length!==ids.length || ids.some(id=>!previous.includes(id)))) this.store.put(key(this.identity().bot!,chat,topic),{...old,interactionIds:ids});
  }
  delivered(chat:number,topic:number,id:number|undefined,text:string,thread?:string,turn?:string) {
    if (!id || !this.eligible(chat,topic)) return;
    const old=this.read(chat,topic);
    this.update(chat,topic,!!old?.waiting,old?.reason,old?.messageId);
    const seq=this.seq(chat,topic);
    if (thread && turn) {
      clearTimeout(this.pending.get(thread)?.timer);
      this.pending.set(thread,{chat,topic,id,text:text.slice(-2000),seq,turn,
        timer:setTimeout(()=>this.pending.delete(thread),6*3600_000).unref()});
    } else this.evaluate(chat,topic,id,text,seq);
  }
  completed(thread:string,turn:string,use:boolean) {
    const p=this.pending.get(thread);
    if (!p || p.turn!==turn) return;
    clearTimeout(p.timer);this.pending.delete(thread);
    if (use && this.eligible(p.chat,p.topic) && this.seq(p.chat,p.topic)===p.seq) this.evaluate(p.chat,p.topic,p.id,p.text,p.seq);
  }
  private evaluate(chat:number,topic:number,id:number,text:string,seq:number) {
    if (!text.trim() || text.trim()==="NO_REPLY") return;
    const bot=this.identity().bot!,generation=this.generation;
    const current=()=>generation===this.generation && bot===this.identity().bot &&
      this.eligible(chat,topic) && this.seq(chat,topic)===seq;
    void Promise.resolve().then(async()=>{
      if (!current()) return;
      const clean=agentText(text.replace(/<!--[^]*?-->/g,"")).plain;
      if (!clean.trim()) return;
      const recent=this.recent?.(bot,chat,topic,id) ??
        this.store.get<{text:string}[]>(`group:context:${chat}:${topic}`)?.map(r=>r.text) ?? [];
      const input=[...recent.slice(-3).map(r=>r.slice(-250)),clean.slice(-2000)].join("\n").slice(-2000);
      if (await checkReplyWaitsOwner(input,this.choose ?? decideChoice(this.config()!.decideCommand || "vallis-decide",5000)) && current())
        this.mark(chat,topic,"reply",id);
    }).catch(()=>{});
  }
  exclude(chat:number,topic:number,exclude:boolean) {
    if (!this.own(chat,topic) || topic<2) return;
    const k=exclusions(this.identity().bot!,chat),ids=new Set(this.store.get<number[]>(k));
    if (exclude) {ids.add(topic);this.clear(chat,topic);} else ids.delete(topic);
    this.store.put(k,[...ids]);this.publish();
  }
  command(caller:Conversation|"local"|undefined,argv:string[]) {
    if (caller!=="local" && caller?.kind!=="owner" && !(caller?.kind==="group" && this.store.get(`group:policy:${caller.chat}:${caller.topic ?? 0}`) && this.own(caller.chat,caller.topic ?? 0)))
      return {exitCode:1,stderr:"waiting_unavailable_in_this_conversation"};
    const snap=this.snapshot();
    if (argv.length===1 || (argv.length===2 && argv[1]==="--json")) return {exitCode:0,stdout:JSON.stringify(snap)};
    const [action,flag,value]=argv.slice(1);
    if (argv.length!==4 || flag!=="--topic" || !["clear","exclude","include"].includes(action))
      return {exitCode:2,stderr:"usage: waiting clear|exclude|include --topic <id|name>"};
    const matches=snap.topics.filter(t=>String(t.topicId)===value || t.name===value);
    if (!snap.chatId || matches.length!==1) return {exitCode:1,stderr:"waiting_topic_unavailable"};
    if (action==="clear") this.clear(snap.chatId,matches[0].topicId);
    else this.exclude(snap.chatId,matches[0].topicId,action==="exclude");
    return {exitCode:0,stdout:JSON.stringify(this.snapshot())};
  }
  snapshot() {
    const cfg=this.config(),bot=this.identity().bot!;
    const chatId=this.forum();
    const topics=(chatId===null ? [] : groupTopics(this.store,bot,chatId)).filter(t=>t.topic>=2 && this.topicAllowed(chatId!,t.topic)).map(t=>{
      const topicId=t.topic,p=this.store.get<GroupTopicPolicy>(`group:policy:${chatId}:${topicId}`);
      const r=this.read(chatId!,topicId),excluded=this.excluded(chatId!,topicId);
      const waiting=!!r?.waiting && !excluded && !isTopicPaused(this.store,bot,chatId!,topicId);
      return {topicId,name:t.name || String(topicId),threadId:p?.threadId || null,
        excluded,waiting,...(waiting && {reason:r.reason,messageId:r.messageId}),updatedAt:r?.updatedAt ?? 0};
    });
    return {enabled:!!cfg?.waitingMarkEnabled,chatId,updatedAt:Math.max(0,...topics.map(t=>t.updatedAt)),topics};
  }
}
