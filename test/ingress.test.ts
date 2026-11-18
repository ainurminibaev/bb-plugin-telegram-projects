import test from "node:test";
import assert from "node:assert/strict";
import { acceptGroupUpdate, routeUpdate as route } from "../ingress";
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
  const message = {message_id: 13, chat, from, photo: [{file_id: "small", file_size: 5}, {file_id: "big", file_size: 50}]};
  const r = routeUpdate({update_id: 13, message});
  assert.equal(r.kind === "chat" && r.input.attachment?.fileId, "big");
  assert.equal(routeUpdate({update_id: 13, message: {...message, from: {id: 99}}}).kind, "ignore");
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
        if (accept) assert.deepEqual(result,{kind:"group",chatId:chat,topicId:topic,threadId:"group-worker",senderId:sender,messageId:8,updateId:9,text});
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
