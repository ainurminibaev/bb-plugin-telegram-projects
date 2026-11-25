import test from "node:test";
import assert from "node:assert/strict";
import { acceptGroupUpdate, groupExample, skipExcludedForumUpdate, routeUpdate as route } from "../ingress";
import {maxImageBytes} from "../group-attachments";
import {MAX_INCOMING_BYTES} from "../telegram-files";
const routeUpdate = (u: unknown) => route(u, OWNER_ID);
const OWNER_ID = 259034221;
const chat = { id: OWNER_ID, type: "private" };
const from = { id: OWNER_ID };
test("owner text in a topic becomes a chat input", () => {
  const r = routeUpdate({
    update_id: 7,
    message: {
      message_id: 3,
      chat,
      from,
      message_thread_id: 42,
      text: "привет",
    },
  });
  assert.equal(r.kind, "chat");
  assert.deepEqual(r.kind === "chat" && r.input, {
    updateId: 7,
    ownerId: OWNER_ID,
    chatId: OWNER_ID,
    topicId: 42,
    messageId: 3,
    text: "привет",
    originalText: true,
    callback: undefined,
    replyTo: undefined,
    voice: undefined,
    attachment: undefined,
  });
});
test("other users, groups and foreign callbacks are ignored", () => {
  const other = { message_id: 1, chat, from: { id: 1 }, text: "x" };
  assert.equal(routeUpdate({ update_id: 1, message: other }).kind, "ignore");
  const group = {
    message_id: 1,
    chat: { id: OWNER_ID, type: "group" },
    from,
    text: "x",
  };
  assert.equal(routeUpdate({ update_id: 1, message: group }).kind, "ignore");
  const cb = routeUpdate({
    update_id: 2,
    callback_query: {
      id: "9",
      from,
      data: "sms:copy",
      message: { message_id: 1, chat },
    },
  });
  assert.deepEqual(cb, { kind: "ignore", callbackId: "9" });
});
test("/tasks is answered by the plugin; bb: callbacks and new topics reach the bridge", () => {
  assert.deepEqual(
    routeUpdate({
      update_id: 3,
      message: {
        message_id: 1,
        chat,
        from,
        message_thread_id: 5,
        text: "/tasks@aivech_bot",
      },
    }),
    { kind: "tasks", topicId: 5 },
  );
  const cb = routeUpdate({
    update_id: 4,
    callback_query: {
      id: "8",
      from,
      data: "bb:menu",
      message: { message_id: 2, chat, message_thread_id: 5 },
    },
  });
  assert.equal(cb.kind === "chat" && cb.input.callback, "bb:menu");
  assert.equal(cb.kind === "chat" && cb.callbackId, "8");
  const created = routeUpdate({
    update_id: 5,
    message: {
      message_id: 3,
      chat,
      from,
      message_thread_id: 6,
      forum_topic_created: { name: "x" },
    },
  });
  assert.equal(created.kind === "chat" && created.input.text, "/project");
});
test("before pairing only /start with the page code binds the owner", () => {
  const u = (text: string, id = 42) => ({
    update_id: 1,
    message: { message_id: 1, chat: { id, type: "private" }, from: { id }, text },
  });
  assert.deepEqual(route(u("/start 123456"), undefined, "123456"), { kind: "pair", userId: 42 });
  assert.equal(route(u("/start 999999"), undefined, "123456").kind, "ignore");
  assert.equal(route(u("привет"), undefined, "123456").kind, "ignore");
  assert.equal(route(u("/start 123456"), undefined, undefined).kind, "ignore");
  assert.equal(route(u("/start 123456", 7), 42, "123456").kind, "ignore");
});

test("large documents retain caption and metadata without content", () => {
  const r = routeUpdate({update_id: 10, message: {message_id: 11, chat, from,
    caption: "Разбери видео", document: {file_id: "large", file_name: "video.mp4", file_size: 2_000_000_000, mime_type: "video/mp4"}}});
  assert.equal(r.kind, "chat");
  if (r.kind !== "chat") return;
  assert.equal(r.input.text, "Разбери видео");
  assert.equal(r.input.attachment?.size, 2_000_000_000);
  assert.equal(r.input.attachment?.fileId, "large");
  assert.equal(r.input.voice, undefined);
});
test("only short voice notes are transcribed; audio and long voice are files", () => {
  for (const [field, size, duration, transcribe] of [
    ["voice", 2000, 5, true], ["voice", 16_000_000, 5, false],
    ["voice", 2000, 601, false], ["audio", 2000, 5, false],
  ] as const) {
    const r = routeUpdate({update_id: 12, message: {message_id: 12, chat, from,
      [field]: {file_id: "a", file_size: size, duration}}});
    assert.equal(r.kind, "chat");
    if (r.kind !== "chat") continue;
    assert.equal(Boolean(r.input.voice), transcribe);
    assert.equal(Boolean(r.input.attachment), !transcribe);
  }
});
test("photo chooses largest variant, foreign owners cannot submit files", () => {
  const message = {message_id: 13, chat, from, photo: [
    {file_id: "medium", width: 120, height: 80, file_size: 700},
    {file_id: "large", width: 170, height: 110, file_size: 600},
    {file_id: "thumbnail", width: 90, height: 58, file_size: 900},
  ]};
  const r = routeUpdate({update_id: 13, message});
  assert.equal(r.kind === "chat" && r.input.attachment?.fileId, "large");
  assert.equal(groupExample(message)?.fileId, "large");
  assert.equal(routeUpdate({update_id: 13, message: {...message, from: {id: 99}}}).kind, "ignore");
});

test("photo selection respects each existing route limit", () => {
  const thumbnail = {file_id: "thumbnail", width: 90, height: 60};
  const groupCap = {file_id: "group-cap", width: 200, height: 140, file_size: maxImageBytes};
  const privateCap = {file_id: "private-cap", width: 300, height: 210, file_size: MAX_INCOMING_BYTES};
  const oversized = {file_id: "oversized", width: 400, height: 280, file_size: MAX_INCOMING_BYTES + 1};
  const message = {message_id: 14, chat, from, photo: [groupCap, privateCap, thumbnail, oversized]};
  const paired = routeUpdate({update_id: 14, message});
  assert.equal(paired.kind === "chat" && paired.input.attachment?.fileId, "private-cap");
  assert.equal(groupExample(message)?.fileId, "group-cap");

  const allOversized = {...message, photo: [oversized]};
  const rejected = routeUpdate({update_id: 15, message: allOversized});
  assert.equal(rejected.kind === "chat" && rejected.input.attachment?.size, MAX_INCOMING_BYTES + 1);
  assert.equal(groupExample(allOversized)?.size, MAX_INCOMING_BYTES + 1);
});

test("group policy binds a specific chat and topic and keeps the real sender", () => {
  const policy = {chatId:-10011, topicId:3, threadId:"group-worker", botId:70, botUsername:"test_bot", ownerOnly:true, requireMention:true};
  for (const ownerOnly of [true,false]) for (const requireMention of [true,false])
    for (const sender of [10,11]) for (const chat of [-10011,-10022]) for (const topic of [2,3])
      for (const kind of ["plain","mention","reply","other","command"]) {
        const text = kind === "mention" ? "О @TeSt_Bot" : kind === "command" ? "/ask@test_bot" : kind === "other" ? "@another" : "hello";
        const msg = {message_id:8, chat:{type:"supergroup", id:chat}, from:{id:sender}, text, message_thread_id:topic,
          entities:kind === "command" ? [{type:"bot_command",offset:0,length:text.length}] : [{type:"mention",offset:kind==="mention"?2:0,length:9}],
          reply_to_message:kind === "reply" ? {from:{id:70}} : undefined};
        const result=route({update_id:9,message:msg},10,undefined,{...policy,ownerOnly,requireMention});
        const accept=chat===policy.chatId && topic===policy.topicId && (!ownerOnly || sender===10) &&
          (!requireMention || ["mention","reply","command"].includes(kind));
        // 0.9.75: a message the agent answers without a mention carries its arrival time (it may join a forward's window).
        const {arrivedAt,...rest}=result as any;
        if (accept) {
          assert.deepEqual(rest,{kind:"group",...(sender===10 && {ownerTopicText:text}),chatId:chat,topicId:topic,threadId:"group-worker",senderId:sender,messageId:8,updateId:9,text});
          assert.equal(arrivedAt!==undefined,!requireMention);
        }
        else assert.equal(result.kind,"ignore");
      }
});

test("accepted group input keeps its first binding and offset on replay", () => {
  const rows = new Map<string, any>();
  const store = {get:<T>(k:string)=>rows.get(k) as T, put:(k:string,v:unknown)=>{rows.set(k,v)},
    atomic:(fn:()=>void)=>fn(), del:(k:string)=>{rows.delete(k)}, list:()=>[]};
  const policy={chatId:-1001,topicId:3,botId:55,botUsername:"test_bot",ownerOnly:true,requireMention:false,threadId:"thread-A"};
  const update={update_id:10,message:{message_id:8,chat:{id:-1001,type:"supergroup"},from:{id:123},message_thread_id:3,text:"hello"}};
  assert.equal(acceptGroupUpdate(store,update,123,55),false);
  store.put("group:policy:-1001:3",policy);
  assert.equal(acceptGroupUpdate(store,update,123,56),false);
  assert.equal(acceptGroupUpdate(store,update,111,55),false);
  assert.equal(acceptGroupUpdate(store,update,123,55),true);
  assert.equal(rows.get("ingress:offset"),11);
  store.put("group:policy:-1001:3",{...policy,threadId:"thread-B"});
  store.put("ingress:offset",13);
  assert.equal(acceptGroupUpdate(store,update,123,55),true);
  assert.equal(rows.get("ingress:offset"),13);
  assert.equal(rows.get("group:in:55:10").route.threadId,"thread-A");
  assert.equal([...rows.keys()].filter(k=>k.startsWith("group:in:")).length,1);
});

test("only a PDF reply tied to this task, sender and binding satisfies its reminder",()=>{
  const rows=new Map<string,unknown>();
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v)},
    atomic:(fn:()=>void)=>fn(),del:(k:string)=>{rows.delete(k)},list:()=>[]};
  const policy={chatId:-1001,topicId:3,botId:55,botUsername:"test_bot",ownerOnly:true,requireMention:true,threadId:"thread-A",revision:"v1"};
  store.put("group:policy:-1001:3",policy);
  store.put("group:task-message:55:-1001:3:12","task");
  store.put("group:origin:task",{owner:123,sender:123,revision:"v1"});
  const message={message_id:20,chat:{id:-1001,type:"supergroup"},from:{id:123},message_thread_id:3,
    reply_to_message:{message_id:12},document:{file_id:"fixture",mime_type:"application/pdf",file_name:"report.pdf"}};
  for (const [i,payload] of [{...message,from:{id:999}},{...message,message_thread_id:4},
      {...message,reply_to_message:{message_id:13}},message].entries()) {
    acceptGroupUpdate(store,{update_id:100+i,message:payload},123,55);
    assert.equal(store.get("group:completed-pdf:task"),i===3?20:undefined);
  }
});

test("a forum root supplies no reply content to a command", () => {
  const forum = {id:-1001,type:"supergroup"};
  const policy = {chatId:forum.id,topicId:3,threadId:"t",ownerOnly:true,
    allowedSenderIds:[7],requireMention:true,botId:8,botUsername:"bot"};
  const command = "/ask@bot title";
  const message = {message_thread_id:3,message_id:4,chat:forum,from:{id:7},text:command,
    entities:[{type:"bot_command",offset:0,length:8}]};
  for (const replyId of [3,2]) {
    const reply_to_message = {chat:forum,message_thread_id:3,message_id:replyId,text:"quoted"};
    const result = route({update_id:9,message:{...message,reply_to_message}},9,undefined,policy);
    assert.equal(result.kind,"group");
    if (result.kind === "group") {
      assert.equal(result.text === command, replyId === 3);
      assert.equal(result.text.includes("quoted"), false, "С81: no quote text, only the message number");
      assert.equal(result.text.includes("№ 2"), replyId !== 3);
    }
  }
});

test("guest mentions require the assigned topic and sender; ordinary replay creates no second job",()=>{
  const rows=new Map<string,any>();
  const store={get:<T>(k:string)=>rows.get(k) as T,put:(k:string,v:unknown)=>{rows.set(k,v);},
    del:(k:string)=>{rows.delete(k);},list:()=>[],atomic:(fn:()=>void)=>fn()};
  const policy={chatId:-1001,topicId:3,botId:55,ownerOnly:true,requireMention:true,botUsername:"test_bot",threadId:"team"};
  const message={message_id:42,chat:{type:"supergroup",id:-1001},message_thread_id:3,is_topic_message:true,
    from:{id:7},text:"Привет, @test_bot",entities:[{type:"mention",offset:8,length:9}],guest_query_id:"fixture"};
  store.put("group:policy:-1001:3",policy);
  const prior=process.env.BB_TELEGRAM_GUEST_TOPICS;
  try {
    process.env.BB_TELEGRAM_GUEST_TOPICS="-1001:3";
    for(const change of [{message_thread_id:4},{from:{id:9}},{forward_origin:{}},{entities:[]}])
      assert.equal(acceptGroupUpdate(store,{update_id:5,guest_message:{...message,...change}},7,55),false);
    assert.equal(acceptGroupUpdate(store,{update_id:5,guest_message:message},7,55),true);
    assert.equal(acceptGroupUpdate(store,{update_id:6,message},7,55),true);
    assert.equal([...rows.keys()].filter(k=>k.startsWith("group:in:")).length,1);
  } finally {if (prior===undefined) delete process.env.BB_TELEGRAM_GUEST_TOPICS; else process.env.BB_TELEGRAM_GUEST_TOPICS=prior;}
});

test("forum scope precedes active bindings and guest diagnostics", () => {
  const rows = new Map<string, any>();
  const store = {get:<T>(k:string)=>rows.get(k) as T, put:(k:string,v:unknown)=>{rows.set(k,v);},
    del:(k:string)=>{rows.delete(k);}, list:()=>[], atomic:(fn:()=>void)=>fn()};
  const message = {message_id:42, chat:{type:"supergroup",id:-1001}, message_thread_id:3,
    is_topic_message:true, from:{id:7}, text:"@test_bot check", entities:[{type:"mention",offset:0,length:9}]};
  for (const topicId of [3,20]) {
    store.put("group:policy:-1001:"+topicId,{chatId:-1001,topicId,botId:55,ownerOnly:true,requireMention:true,
      botUsername:"test_bot",threadId:"thread"+topicId});
  }
  const prior = process.env.BB_TELEGRAM_FORUM_TOPIC_SCOPE;
  try {
    process.env.BB_TELEGRAM_FORUM_TOPIC_SCOPE = "-1001:20";
    for (const payload of [{message},{edited_message:message},{guest_message:message},
        {callback_query:{message}},{message:{...message,message_thread_id:undefined}}]) {
      assert.equal(skipExcludedForumUpdate(store,{update_id:10,...payload}),true);
      assert.equal(rows.get("ingress:offset"),11);
      assert.equal(rows.size,3);
    }
    const allowed = {update_id:11,message:{...message,message_thread_id:20}};
    assert.equal(skipExcludedForumUpdate(store,allowed),false);
    assert.equal(acceptGroupUpdate(store,allowed,7,55),true);
    assert.equal(skipExcludedForumUpdate(store,{message:{...message,chat:{type:"supergroup",id:-1002}}}),false);
    delete process.env.BB_TELEGRAM_FORUM_TOPIC_SCOPE;
    assert.equal(skipExcludedForumUpdate(store,{message}),false);
  } finally {
    if (prior === undefined) delete process.env.BB_TELEGRAM_FORUM_TOPIC_SCOPE;
    else process.env.BB_TELEGRAM_FORUM_TOPIC_SCOPE = prior;
  }
});
