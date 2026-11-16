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
test("mixed and unknown requests fail closed instead of leaking to Telegram", () => {
  const {routes} = fixture(); routes.record("thread","tg",tg);
  routes.record("thread","bb",{kind:"bb"});
  routes.accept("thread","mixed","tg");routes.accept("thread","mixed","bb");
  assert.equal(routes.destination("thread","mixed"),undefined);
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
  assert.equal(restored.inheritOutcomes("parent","notice",[{threadId:"child",status:"completed"}]),true);
  restored.accept("parent","continued-turn","notice");
  assert.deepEqual(restored.destination("parent","continued-turn"),tg);
  assert.equal(restored.inheritOutcomes("parent","notice",[{threadId:"child",status:"completed"}]),true);
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
