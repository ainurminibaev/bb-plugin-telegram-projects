import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, stat, writeFile, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ownFolderProject,guardReachesFolders,conversationFolderName,ensureConversationFolder,ensureConversationProject,conversationProjectKey,moveConversation,restoreConversation,movedKey} from "../conversation-folder";
import {bindGroupTopic} from "../group-worker";
import {groupThreadMatches} from "../group-binding";

const OWNER=7, BOT=5;
function memoryStore(){
  const rows=new Map<string,any>();
  return {rows,get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},del:(k:string)=>{rows.delete(k)},
    list:<T>(prefix:string)=>[...rows].filter(([k])=>k.startsWith(prefix)).map(([key,v])=>({key,value:v as T})),atomic:(fn:()=>void)=>fn()};
}

test("С76: one folder per group (its topics share it) and one per person, closed to others",async()=>{
  assert.equal(conversationFolderName("group",-1001234),"group-1001234");
  assert.equal(conversationFolderName("person",42),"person-42");
  assert.throws(()=>conversationFolderName("group",NaN));
  const root=join(await mkdtemp(join(tmpdir(),"c76-")),"conversations");
  const path=await ensureConversationFolder(root,"group",-1001234,"Команда\nпродаж","/srv/org/employees/alpha/AGENTS.md");
  assert.equal(path,await realpath(join(root,"group-1001234")));
  assert.equal((await stat(path)).mode & 0o777,0o700);
  for (const dir of ["outputs","local"]) assert.ok((await stat(join(path,dir))).isDirectory());
  const rules=await readFile(join(path,"AGENTS.md"),"utf8");
  assert.match(rules,/Разговор группы «Команда продаж»/);
  assert.match(rules,/Правила роли — \/srv\/org\/employees\/alpha\/AGENTS\.md/);
  assert.match(rules,/личк. владельца .*недоступны/);
  assert.equal(await readFile(join(path,"CLAUDE.md"),"utf8"),"@AGENTS.md\n@/srv/org/employees/alpha/AGENTS.md\n");
  // the folder's own rules, once written, are kept: the agent and the owner may change them
  await writeFile(join(path,"AGENTS.md"),"свои правила\n");
  assert.equal(await ensureConversationFolder(root,"group",-1001234,"Другое имя"),path);
  assert.equal(await readFile(join(path,"AGENTS.md"),"utf8"),"свои правила\n");
  // the organization's connections and skills come by links from the owner's folder; its notes and results do not
  const owner=await mkdtemp(join(tmpdir(),"c76-owner-"));
  for (const d of [".claude/skills/report",".agents/skills/report",".codex","local","outputs"]) await (await import("node:fs/promises")).mkdir(join(owner,d),{recursive:true});
  await writeFile(join(owner,".mcp.json"),"{}");
  await writeFile(join(owner,".codex","config.toml"),"");
  const linked=await ensureConversationFolder(root,"group",-555,"Связи","/r/AGENTS.md",owner);
  const {lstat,readlink}=await import("node:fs/promises");
  for (const rel of [".mcp.json",".codex/config.toml",".claude/skills",".agents/skills"]) {
    assert.ok((await lstat(join(linked,rel))).isSymbolicLink(),rel);
    assert.equal(await readlink(join(linked,rel)),join(owner,rel));
  }
  await assert.rejects(stat(join(linked,"local","notes-of-owner")),"local/ is the folder's own");
  assert.equal((await lstat(join(linked,"local"))).isSymbolicLink(),false);
  assert.equal(await readFile(join(linked,"CLAUDE.md"),"utf8"),"@AGENTS.md\n@/r/AGENTS.md\n");
  const person=await ensureConversationFolder(root,"person",42,"Алиса");
  assert.notEqual(person,path);
  assert.match(await readFile(join(person,"AGENTS.md"),"utf8"),/лички человека/);
  await assert.rejects(ensureConversationFolder("relative/root","group",1,"x"),/conversation_root_invalid/);
});

test("С76: the folder's BB project is created once, then found again",async()=>{
  const store=memoryStore();
  const created:any[]=[];
  const projects=new Map<string,any>();
  const api={
    get:async({projectId}:{projectId:string})=>{const p=projects.get(projectId); if (!p) throw Error("not_found"); return p;},
    list:async()=>[...projects.values()],
    create:async(a:any)=>{created.push(a);const p={id:"proj_"+created.length,sources:[{hostId:a.source.hostId,path:a.source.path}]};
      projects.set(p.id,p);return {id:p.id};},
  };
  const id=await ensureConversationProject(store as any,api,"host_1","/srv/c/group-1","Группа: Продажи");
  assert.equal(id,"proj_1");
  assert.deepEqual(created[0],{name:"Группа: Продажи",source:{type:"local_path",hostId:"host_1",path:"/srv/c/group-1"}});
  assert.equal(await ensureConversationProject(store as any,api,"host_1","/srv/c/group-1","x"),"proj_1");
  assert.equal(created.length,1,"remembered");
  store.del(conversationProjectKey("/srv/c/group-1"));
  assert.equal(await ensureConversationProject(store as any,api,"host_1","/srv/c/group-1","x"),"proj_1");
  assert.equal(created.length,1,"found by its path");
  projects.clear();
  assert.equal(await ensureConversationProject(store as any,api,"host_1","/srv/c/group-1","x"),"proj_2","a deleted project is made again");
});

test("С76: a conversation bound in its own folder belongs to that project, not to the owner's",()=>{
  const store=memoryStore();
  const policy={chatId:-100,topicId:0,threadId:"thr_group",inOwnerProject:true as const,ownFolder:true as const,
    ownerOnly:false,requireMention:true,includeTopicContext:true,searchableHistory:true,retainFullHistory:true,
    botId:BOT,botUsername:"acme_bot",ownerId:OWNER,revision:"r1"};
  bindGroupTopic(store as any,policy,"proj_group");
  const bound=store.get<any>("group:policy:-100:0");
  assert.equal(bound.projectId,"proj_group");
  assert.equal(bound.ownFolder,true);
  assert.equal(groupThreadMatches(store as any,bound,"proj_group"),true);
  assert.equal(groupThreadMatches(store as any,bound,"proj_owner"),false,"the owner's project does not own this conversation");
  assert.equal(store.get("group:project:proj_owner"),undefined);
});

test("С76: an existing group moves to its own folder with every topic, and can be restored",async()=>{
  const store=memoryStore();
  const base={ownerOnly:false,requireMention:true,includeTopicContext:true,searchableHistory:true,retainFullHistory:true,
    botId:BOT,botUsername:"acme_bot",ownerId:OWNER};
  for (const [topic,thread] of [[0,"thr_general"],[5,"thr_topic5"]] as const)
    bindGroupTopic(store as any,{...base,chatId:-100,topicId:topic,threadId:thread,inOwnerProject:true,revision:"r"},"proj_owner");
  bindGroupTopic(store as any,{...base,chatId:-100,topicId:7,threadId:"thr_busy",inOwnerProject:true,revision:"r"},"proj_owner");
  const spawned:any[]=[], notices:string[]=[];
  const d={store:store as any,owner:OWNER,bot:BOT,ownerProjectId:"proj_owner",title:"Продажи",
    busy:(t:number)=>t===7,
    ensureProject:async()=>"proj_group",projectPath:async()=>"/srv/c/group-100",
    thread:async(id:string)=>({title:"Тема "+id,providerId:"codex"}),
    spawn:async(a:any)=>{spawned.push(a);return {id:"thr_new"+spawned.length,projectId:a.projectId};},
    bind:(policy:any,projectId:string)=>bindGroupTopic(store as any,policy,projectId),
    notice:(from:string,to:string,_t:number,sch:any,label?:string)=>{notices.push(from+">"+to+(sch?.moved?.length ? " s:"+sch.moved.join(",") : ""));labels.push(label);},
    openChildren:async(id:string)=>id==="thr_topic5" ? openKids : 0,
    moveSchedules:async(from:string)=>from==="thr_general" ? {moved:["auto_1"],left:[]} : {moved:[],left:[]}};
  let openKids=1;
  const labels:(string|undefined)[]=[];
  const dry=await moveConversation(d,-100,true);
  assert.deepEqual(dry.moved.map(m=>m.topicId),[0],"a topic with open subthreads waits");
  assert.match(dry.skipped.join(),/topic 5: 1 subthread\(s\) still open/);
  openKids=0;
  assert.deepEqual((await moveConversation(d,-100,true)).moved.map(m=>m.topicId),[0,5]);
  assert.equal(spawned.length,0,"a dry run changes nothing");
  assert.match(dry.skipped.join(),/topic 7: a turn is running/);
  const done=await moveConversation(d,-100);
  assert.equal(done.projectId,"proj_group");
  assert.deepEqual(done.moved.map(m=>[m.topicId,m.from,m.to]),[[0,"thr_general","thr_new1"],[5,"thr_topic5","thr_new2"]]);
  assert.deepEqual(done.moved[0].schedules,{moved:["auto_1"],left:[]},"the schedules follow the conversation");
  assert.equal(spawned[0].environment.type,"project-default");
  assert.equal(spawned[0].providerId,"codex");
  for (const topic of [0,5]) {
    const p=store.get<any>(`group:policy:-100:${topic}`);
    assert.equal(p.projectId,"proj_group"); assert.equal(p.ownFolder,true);
    assert.equal(groupThreadMatches(store as any,p,"proj_group"),true);
  }
  assert.deepEqual(notices,["thr_general>thr_new1 s:auto_1","thr_topic5>thr_new2"],"the previous threads are told whom to hand work to");
  assert.equal(store.get<any>("group:policy:-100:7").threadId,"thr_busy","a running topic stays for later");
  assert.equal(labels[0],"Тема thr_general","the notice names the place by the thread's own title");
  assert.match((await moveConversation(d,-100)).skipped.join(),/already in its own folder/);
  // a schedule that cannot follow keeps the topic where it is
  bindGroupTopic(store as any,{...base,chatId:-100,topicId:9,threadId:"thr_sched",inOwnerProject:true,revision:"r"},"proj_owner");
  const returned:string[]=[];
  const strict={...d,moveSchedules:async(from:string,to:string)=>{ if (from==="thr_sched") return {moved:["auto_a"],left:["auto_b"]}; returned.push(from+">"+to); return {moved:[],left:[]}; }};
  const res=await moveConversation(strict,-100);
  assert.match(res.skipped.join(),/topic 9: schedules auto_b could not be moved — the topic stays/);
  assert.equal(store.get<any>("group:policy:-100:9").threadId,"thr_sched");
  assert.equal(returned.length,1,"the schedule that moved goes back");
  const back=restoreConversation({store:store as any,bind:d.bind,notice:d.notice},-100);
  assert.deepEqual(back.restored.map(r=>r.threadId).sort(),["thr_general","thr_topic5"]);
  const p0=store.get<any>("group:policy:-100:0");
  assert.equal(p0.threadId,"thr_general"); assert.equal(p0.projectId,"proj_owner"); assert.equal(p0.ownFolder,undefined);
  assert.equal(store.get(movedKey(-100,0)),undefined);
  assert.ok(notices.includes("thr_new1>thr_general"));
});

test("С76: own folders only where the guest guard reaches them for the account", async()=>{
  const home=await mkdtemp(join(tmpdir(),"c76-home-"));
  assert.equal(await guardReachesFolders(home),false);
  const {mkdir}=await import("node:fs/promises");
  await mkdir(join(home,".codex"),{recursive:true}); await mkdir(join(home,".claude"),{recursive:true});
  const hook=JSON.stringify({hooks:{PreToolUse:[{matcher:"*",hooks:[{type:"command",command:"python3 /w/.bb/hooks/guest-thread-guard.py"}]}]}});
  await writeFile(join(home,".codex","hooks.json"),hook);
  assert.equal(await guardReachesFolders(home),false,"Claude too");
  await writeFile(join(home,".claude","settings.json"),hook);
  assert.equal(await guardReachesFolders(home),true);
  const codex=await mkdtemp(join(tmpdir(),"c76-codex-"));
  assert.equal(await guardReachesFolders(home,codex),false,"CODEX_HOME is where Codex reads hooks");
});

test("С76: a folder the bridge makes on a working installation is guarded before its first turn; without the guard nothing is made", async()=>{
  const {mkdir,readdir}=await import("node:fs/promises");
  const base=await mkdtemp(join(tmpdir(),"c76-run-"));
  const home=join(base,"home"), owner=join(base,"employees","alpha"), root=join(base,"conversations");
  await mkdir(owner,{recursive:true});
  await writeFile(join(owner,"AGENTS.md"),"# role\n");
  const store=memoryStore();
  const made:any[]=[];
  const projects={
    get:async({projectId}:{projectId:string})=>projectId==="proj_owner" ? {id:"proj_owner",sources:[{hostId:"host_1",path:owner}]}
      : {id:projectId,sources:made.filter(m=>m.id===projectId).map(m=>m.source)},
    list:async()=>made.map(m=>({id:m.id,sources:[m.source]})),
    create:async(a:any)=>{const p={id:"proj_g"+(made.length+1),source:a.source,name:a.name};made.push(p);return {id:p.id};},
  };
  const d={root,rulesFile:join(owner,"AGENTS.md"),home,store:store as any,projects,ownerProjectId:"proj_owner"};
  // the installation is running, the guard is not registered for the account: no folder, no project, no binding
  await assert.rejects(ownFolderProject(d,{chatId:-100777,title:"Новая группа"}),/conversation_guard_missing/);
  assert.equal(made.length,0);
  assert.equal(await readdir(root).then(x=>x.length,()=>0),0,"no folder before the guard");
  // the installer registered the guard for the account: the folder and its project are made, with the marker
  await mkdir(join(home,".codex"),{recursive:true}); await mkdir(join(home,".claude"),{recursive:true});
  const hook=JSON.stringify({hooks:{PreToolUse:[{matcher:"*",hooks:[{type:"command",command:"python3 "+owner+"/.bb/hooks/guest-thread-guard.py"}]}]}});
  await writeFile(join(home,".codex","hooks.json"),hook); await writeFile(join(home,".claude","settings.json"),hook);
  const id=await ownFolderProject(d,{chatId:-100777,title:"Новая группа"});
  assert.equal(id,"proj_g1");
  const folder=made[0].source.path;
  assert.deepEqual(JSON.parse(await readFile(join(folder,".vallis-conversation.json"),"utf8")),{installation:owner},
    "the platform takes the organization's rules and the role from the installation");
  assert.equal(made[0].name,"Группа: Новая группа");
  // own folders off: the conversation stays where it was
  assert.equal(await ownFolderProject({...d,root:""},{chatId:-1,title:"x"}),undefined);
});
