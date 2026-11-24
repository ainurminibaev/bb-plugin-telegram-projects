import test from "node:test";
import assert from "node:assert/strict";
import {ReplyRoutes} from "../reply-routing";
import type {Store} from "../model";
function fixture() {
  const data = new Map<string, unknown>();
  const store: Store = {
    get: k => structuredClone(data.get(k)) as any,
    put: (k,v) => {data.set(k, structuredClone(v));},
    del: k => {data.delete(k);},
    list: p => [...data].filter(([k]) => k.startsWith(p)).map(([key,value]) => ({key,value: structuredClone(value) as any})),
    atomic: fn => fn(),
  };
  return {store, routes: new ReplyRoutes(store)};
}
const tg = {kind: "telegram" as const, chatId: 10, topicId: 20, updateId: 30};
test("setup failure with explicitly absent turn identity cannot consume an older Telegram failure", () => {
  const {routes} = fixture();
  routes.record("child", "old-request", tg);
  routes.accept("child", "old-turn", "old-request");
  routes.complete("child", "old-turn", "failed");
  assert.equal(routes.inheritOutcomes("parent", "setup-failure", [{threadId:"child",status:"failed",turnId:null}]), false);
  routes.accept("parent", "setup-reply", "setup-failure");
  assert.equal(routes.destination("parent", "setup-reply"), undefined);
  assert.equal(routes.inheritOutcomes("parent", "correct-notice", [{threadId:"child",status:"failed",turnId:"old-turn"}]), true);
  routes.accept("parent", "correct-reply", "correct-notice");
  assert.deepEqual(routes.destination("parent", "correct-reply"), tg);
});
test("exact native outcome identity distinguishes a Telegram failure from old BB failures after restart", () => {
  const {store, routes} = fixture();
  for (let i = 0; i < 6; i++) {
    routes.record("child", `bb-${i}`, {kind: "bb"});
    routes.accept("child", `old-${i}`, `bb-${i}`);
    routes.complete("child", `old-${i}`, "failed");
  }
  routes.record("child", "tg", tg);
  routes.accept("child", "new", "tg");
  routes.complete("child", "new", "failed");
  const restored = new ReplyRoutes(store);
  assert.equal(restored.inheritOutcomes("parent", "legacy", [{threadId:"child", status:"failed"}]), false);
  const outcome = [{threadId:"child", status:"failed", turnId:"new"}];
  assert.equal(restored.inheritOutcomes("parent", "notice", outcome), true);
  assert.equal(restored.inheritOutcomes("parent", "notice", outcome), true);
  restored.accept("parent", "reply", "notice");
  assert.deepEqual(restored.destination("parent", "reply"), tg);
  assert.equal(restored.inheritOutcomes("parent", "duplicate", outcome), false);
  assert.equal(restored.inheritOutcomes("parent", "missing", [{...outcome[0],turnId:"unknown"}]), false);
  assert.equal(restored.inheritOutcomes("parent", "old-notice", [{threadId:"child",status:"failed",turnId:"old-0"}]), true);
  restored.accept("parent", "bb-reply", "old-notice");
  assert.deepEqual(restored.destination("parent", "bb-reply"), {kind:"bb"});
});
test("BB request stays in BB while queued Telegram request retains its destination", () => {
  const {routes} = fixture();
  routes.record("thread", "tg-request", tg);
  routes.record("thread", "bb-request", {kind:"bb"});
  routes.accept("thread", "bb-turn", "bb-request");
  routes.accept("thread", "tg-turn", "tg-request");
  assert.deepEqual(routes.destination("thread", "bb-turn"), {kind:"bb"});
  assert.deepEqual(routes.destination("thread", "tg-turn"), tg);
});
test("retry preserves original task route after restart and a newer BB request", () => {
  const {store,routes} = fixture(); routes.record("thread","original",tg);
  routes.record("thread","newer",{kind:"bb"});
  const resumed = new ReplyRoutes(store);
  assert.equal(resumed.retry("thread","retry","original"),true);
  resumed.accept("thread","retry-turn","retry");
  assert.deepEqual(resumed.destination("thread","retry-turn"),tg);
});
test("a BB message steered into a Telegram task adds to it; unknown requests fail closed", () => {
  const {routes} = fixture(); routes.record("thread","tg",tg);
  routes.record("thread","bb",{kind:"bb"});
  routes.accept("thread","mixed","tg");routes.accept("thread","mixed","bb");
  // 0.9.66: the task keeps its destination (before, the turn turned ambiguous and the task was submitted again).
  assert.deepEqual(routes.destination("thread","mixed"),tg);
  routes.record("thread","tg2",{...tg,updateId:31});
  routes.accept("thread","two","tg");routes.accept("thread","two","tg2");
  assert.equal(routes.destination("thread","two"),undefined,"two Telegram tasks in one turn stay ambiguous");
  routes.accept("thread","unknown","missing");
  assert.equal(routes.destination("thread","unknown"),undefined);
  assert.equal(routes.retry("thread","retry","missing"),false);
});
test("identities are thread scoped and a route cannot be reassigned", () => {
  const {routes} = fixture();routes.record("a","id",tg);
  routes.record("b","id",{kind:"bb"});routes.accept("b","turn","id");
  assert.deepEqual(routes.destination("b","turn"),{kind:"bb"});
  assert.throws(()=>routes.record("a","id",{kind:"bb"}),/conflict/);
});

test("hidden ingress identity survives queue persistence and resolves native request", () => {
  const {routes,store} = fixture();
  const marker = routes.ingress("thread",tg);
  assert.equal(marker.visibility,"agent-only");
  const restored = new ReplyRoutes(store);
  assert.equal(restored.requested("thread", {requestId:"native",originPluginId:"telegram-projects",input:[{type:"text",text:"hello"},marker]}),true);
  restored.accept("thread","turn","native");
  assert.deepEqual(restored.destination("thread","turn"),tg);
});
test("copied marker in BB, foreign thread or a second request cannot redirect delivery", () => {
  const {routes} = fixture(); const marker = routes.ingress("thread",tg);
  routes.requested("thread",{requestId:"bb",input:[marker]});
  routes.accept("thread","bb-turn","bb");
  assert.deepEqual(routes.destination("thread","bb-turn"),{kind:"bb"});
  assert.equal(routes.requested("foreign",{requestId:"x",originPluginId:"telegram-projects",input:[marker]}),false);
  assert.equal(routes.requested("thread",{requestId:"tg",originPluginId:"telegram-projects",input:[marker]}),true);
  assert.equal(routes.requested("thread",{requestId:"replay",originPluginId:"telegram-projects",input:[marker]}),false);
  assert.equal(routes.requested("thread",{requestId:"retry",retryOfRequestId:"tg"}),true);
});
test("grouped Telegram inputs require explicit attribution, not the last marker", () => {
  const {routes} = fixture();
  const a=routes.ingress("thread",tg), b=routes.ingress("thread",{...tg,topicId:99,updateId:31});
  assert.equal(routes.requested("thread",{requestId:"mixed",originPluginId:"telegram-projects",input:[a,b]}),false);
});

test("delegation carries the exact accepted task through a reused worker and restart", () => {
  const {store,routes} = fixture();
  const marker = routes.ingress("parent",tg);
  const token = marker.text.match(/route:([^\]]+)/)![1];
  assert.throws(()=>routes.delegatedIngress("parent",token,"child"),/unproven/);
  routes.requested("parent",{requestId:"original",originPluginId:"telegram-projects",input:[marker]});
  assert.throws(()=>routes.delegatedIngress("other",token,"child"),/unproven/);
  const forwarded = routes.delegatedIngress("parent",token,"child");
  routes.requested("child",{requestId:"work",originPluginId:"telegram-projects",input:[forwarded]});
  routes.accept("child","work-turn","work");
  routes.complete("child","work-turn","completed");
  const restored = new ReplyRoutes(store);
  assert.equal(restored.inheritOutcomes("parent","notice",[{threadId:"child",status:"completed",turnId:"work-turn"}]),true);
  restored.accept("parent","continued-turn","notice");
  assert.deepEqual(restored.destination("parent","continued-turn"),tg);
  assert.equal(restored.inheritOutcomes("parent","notice",[{threadId:"child",status:"completed",turnId:"work-turn"}]),true);
  assert.equal(restored.inheritOutcomes("parent","duplicate",[{threadId:"child",status:"completed"}]),false);
});

test("mixed or ambiguous child completions cannot redirect a coordinator response", () => {
  const {routes} = fixture();
  for (const [id,route] of [["tg",tg],["bb",{kind:"bb"}]] as const) {
    routes.record("child",id,route); routes.accept("child",id,id); routes.complete("child",id,"completed");
  }
  assert.equal(routes.inheritOutcomes("parent","notice",[{threadId:"child",status:"completed"}]),false);
  routes.record("other","request",{kind:"bb"});routes.accept("other","turn","request");routes.complete("other","turn","failed");
  assert.equal(routes.inheritOutcomes("parent","missing",[{threadId:"other",status:"completed"}]),false);
});

test("same-task child notice can join its parent turn without changing the destination", () => {
  const {routes} = fixture();
  routes.record("parent","original",tg);routes.record("parent","child-notice",{...tg});
  routes.accept("parent","turn","original");routes.accept("parent","turn","child-notice");
  assert.deepEqual(routes.destination("parent","turn"),tg);
  routes.record("parent","other-task",{...tg,updateId:999});routes.accept("parent","turn","other-task");
  assert.equal(routes.destination("parent","turn"),undefined);
});

test("late stock notice cannot claim the only remaining run of a reused worker", () => {
  const {routes} = fixture();
  for (const [id, updateId] of [["first", 31], ["second", 32]] as const) {
    routes.record("worker", id, {...tg, updateId});
    routes.accept("worker", id, id);
    routes.complete("worker", id, "interrupted");
  }
  const notice = {threadId:"worker", status:"interrupted"};
  assert.equal(routes.inheritOutcomes("parent","first-done",[{...notice,turnId:"first"}]), true);
  assert.equal(routes.inheritOutcomes("parent","delayed",[notice]), false);
  assert.equal(routes.inheritOutcomes("parent","pre-turn",[{...notice,turnId:null}]), false);
  assert.equal(routes.inheritOutcomes("parent","second-done",[{...notice,turnId:"second"}]), true);
  routes.accept("parent","final","second-done");
  assert.deepEqual(routes.destination("parent","final"), {...tg,updateId:32});
});

test("reverse-order outcomes keep each worker run in its original topic across restart", () => {
  const {store, routes} = fixture();
  const first = {...tg, topicId: 121, updateId: 31};
  const second = {...tg, topicId: 122, updateId: 32};
  for (const [id, route] of [["first", first], ["second", second]] as const) {
    routes.record("worker", id, route);
    routes.accept("worker", id, id);
    routes.complete("worker", id, "completed");
  }

  for (const [id, route] of [["second", second], ["first", first]] as const) {
    const restored = new ReplyRoutes(store);
    const outcome = {threadId: "worker", turnId: id, status: "completed"};
    assert.equal(restored.inheritOutcomes("parent", id, [outcome]), true);
    restored.accept("parent", id, id);
    assert.deepEqual(restored.destination("parent", id), route);
    assert.equal(restored.inheritOutcomes("parent", id + "-duplicate", [outcome]), false);
  }
});

test("stock child receipt survives restart and never adopts a BB run or a different coordinator", () => {
  const {store,routes} = fixture();
  const origin = routes.ingress("parent",tg);
  routes.requested("parent",{requestId:"p",originPluginId:"telegram-projects",input:[origin]});
  const token = origin.text.match(/route:([^\]]+)/)![1];
  const worker = routes.delegatedIngress("parent",token,"child");
  routes.requested("child",{requestId:"w",originPluginId:"telegram-projects",input:[worker]});
  routes.accept("child","target","w");
  routes.complete("child","target","completed");
  routes.requested("child",{requestId:"bb"});
  routes.accept("child","newer","bb");
  routes.complete("child","newer","completed");
  assert.deepEqual(routes.reserveChildReports("other",tg.chatId,tg.topicId),[]);
  assert.deepEqual(routes.reserveChildReports("parent",tg.chatId,0),[]);
  const reports = routes.reserveChildReports("parent",tg.chatId,tg.topicId);
  assert.deepEqual(reports.map(r=>r.value.turnId),["target"]);
  const resumed = new ReplyRoutes(store);
  assert.deepEqual(resumed.reserveChildReports("parent",tg.chatId,tg.topicId),reports);
  assert.equal(resumed.inheritOutcomes("parent","late-stock",[{threadId:"child",status:"completed"}]),false);
  assert.equal(resumed.inheritOutcomes("parent","late-patched",[{threadId:"child",turnId:"target",status:"completed"}]),false);
});

// 18.11.2026: a delegated worker spawned its own helpers; their stock
// completion notices were steered into its running Telegram turn, which was
// then marked ambiguous and its final result never returned to Telegram.
test("worker's own child notices and coordinator messages keep a delegated turn routed", () => {
  const {routes,store} = fixture();
  const parentMarker = routes.ingress("parent",tg);
  const token = parentMarker.text.match(/route:([^\]]+)/)![1];
  routes.requested("parent",{requestId:"original",originPluginId:"telegram-projects",input:[parentMarker]});
  const forwarded = routes.delegatedIngress("parent",token,"child");
  routes.requested("child",{requestId:"work",originPluginId:"telegram-projects",input:[forwarded]});
  routes.accept("child","t7","work");
  for (const id of ["grandchild-1","grandchild-2","grandchild-3"]) {
    routes.requested("child",{requestId:id,initiator:"system",systemMessageKind:"child-completed",senderThreadId:null});
    routes.accept("child","t7",id);
  }
  routes.requested("child",{requestId:"coordinator",initiator:"agent",senderThreadId:"parent"});
  routes.accept("child","t7","coordinator");
  assert.deepEqual(routes.destination("child","t7"),tg);
  routes.complete("child","t7","completed");
  const reports = routes.reserveChildReports("parent",tg.chatId,tg.topicId);
  assert.equal(reports.length,1);
  assert.equal(reports[0].value.turnId,"t7");
  assert.equal(reports[0].value.mixed,undefined);
  assert.deepEqual(reports[0].value.route,tg);
  // С48: a message from an unrelated thread joins as a service message; the Telegram task keeps its destination.
  const other = fixture();
  other.routes.record("w","tg",tg); other.routes.accept("w","t","tg");
  other.routes.requested("w",{requestId:"stranger",initiator:"agent",senderThreadId:"elsewhere"});
  other.routes.accept("w","t","stranger");
  assert.deepEqual(other.routes.destination("w","t"),tg);
  void store;
});

test("a message typed in BB into a delegated Telegram task keeps the task routed (С48)", () => {
  const {routes} = fixture();
  const parentMarker = routes.ingress("parent",tg);
  const token = parentMarker.text.match(/route:([^\]]+)/)![1];
  routes.requested("parent",{requestId:"original",originPluginId:"telegram-projects",input:[parentMarker]});
  const first = routes.delegatedIngress("parent",token,"child");
  routes.requested("child",{requestId:"work",originPluginId:"telegram-projects",input:[first]});
  routes.accept("child","turn","work");
  routes.requested("child",{requestId:"owner-in-bb",initiator:"user",input:[{type:"text",text:"also do this"}]});
  routes.accept("child","turn","owner-in-bb");
  // С48: a message typed in BB into a busy Telegram task is a service message; the task keeps its destination.
  assert.deepEqual(routes.destination("child","turn"),tg);
  routes.complete("child","turn","completed");
  const [report] = routes.reserveChildReports("parent",tg.chatId,tg.topicId);
  assert.equal(report.value.mixed,undefined);
  assert.deepEqual(report.value.route,tg);
  // Cancelled tasks stay silent.
  const c = fixture();
  const m = c.routes.ingress("parent",tg); const tk = m.text.match(/route:([^\]]+)/)![1];
  c.routes.requested("parent",{requestId:"original",originPluginId:"telegram-projects",input:[m]});
  const f2 = c.routes.delegatedIngress("parent",tk,"child");
  c.routes.requested("child",{requestId:"work",originPluginId:"telegram-projects",input:[f2]});
  c.routes.accept("child","turn","work"); c.routes.record("child","bb",{kind:"bb"}); c.routes.accept("child","turn","bb");
  c.routes.cancel(tg); c.routes.complete("child","turn","completed");
  assert.equal(c.routes.reserveChildReports("parent",tg.chatId,tg.topicId).length,0);
});

test("a worker turn waiting for the owner's answer is not its result; the turn after the answer is", () => {
  const {store,routes} = fixture();
  const marker = routes.ingress("parent",tg);
  const token = marker.text.match(/route:([^\]]+)/)![1];
  routes.requested("parent",{requestId:"original",originPluginId:"telegram-projects",input:[marker]});
  const forwarded = routes.delegatedIngress("parent",token,"child");
  routes.requested("child",{requestId:"work",originPluginId:"telegram-projects",input:[forwarded]});
  routes.accept("child","ask-turn","work");
  routes.questionAsked("child","ask-turn");
  routes.questionAnswered("child","ask-turn");
  routes.complete("child","ask-turn","completed");
  const pending = () => store.list<{turnId: string}>("reply:pending-child:").map(r => r.value.turnId);
  assert.deepEqual(pending(),[],"the asking turn ends without the answer: no report");
  routes.requested("child",{requestId:"answer",originPluginId:"provider-codex",initiator:"user",input:[{type:"text",text:"> Создать?\n\nда"}]});
  routes.accept("child","answer-turn","answer");
  assert.deepEqual(routes.destination("child","answer-turn"),tg);
  routes.complete("child","answer-turn","completed");
  assert.deepEqual(pending(),["answer-turn"]);
  routes.requested("child",{requestId:"later",originPluginId:"provider-codex",initiator:"user",input:[{type:"text",text:"x"}]});
  routes.accept("child","later-turn","later");
  assert.deepEqual(routes.destination("child","later-turn"),{kind:"bb"},"only the one answer continues the task");
});

test("0.9.66: a plugin's notice or a schedule steered into a Telegram task keeps the task's destination", () => {
  const {routes} = fixture();
  const marker = routes.ingress("topic",tg);
  routes.requested("topic",{requestId:"voice",originPluginId:"telegram-projects",input:[marker]});
  routes.accept("topic","t1","voice");
  // The limit guard: a plugin's message, initiator user, no sender thread.
  routes.requested("topic",{requestId:"guard",originPluginId:"limit-guard",initiator:"user",senderThreadId:null});
  routes.accept("topic","t1","guard");
  // A schedule's run, from the automations plugin.
  routes.requested("topic",{requestId:"schedule",originPluginId:"automations",initiator:"system",senderThreadId:null});
  routes.accept("topic","t1","schedule");
  assert.deepEqual(routes.destination("topic","t1"),tg);
  // A plain BB turn is not taken over by a later Telegram message's route either.
  routes.requested("bbthread",{requestId:"work",initiator:"user",senderThreadId:null});
  routes.accept("bbthread","t2","work");
  routes.requested("bbthread",{requestId:"guard2",originPluginId:"limit-guard",initiator:"user",senderThreadId:null});
  routes.accept("bbthread","t2","guard2");
  assert.deepEqual(routes.destination("bbthread","t2"),{kind:"bb"});
});
