import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, statSync, appendFileSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StateTransfer} from "../state-transfer";
import type {Store} from "../model";
import {routeUpdate} from "../ingress";

function store(): Store {
  const rows = new Map<string,unknown>();
  return {get: k => structuredClone(rows.get(k)) as any,
    put:(k,v) => {rows.set(k, structuredClone(v));}, del:k => {rows.delete(k);},
    list:p => [...rows].filter(([k]) => k.startsWith(p)).map(([key,value]) => ({key,value:structuredClone(value) as any})),
    atomic:fn => fn()};
}
test("private snapshot restores settings and exact state without returning credentials", async () => {
  const root = mkdtempSync(join(tmpdir(),"tg-transfer-"));
  try {
    const source = store(); source.put("owner:id",123); source.put("chat:out:x",{sentId:45,text:"test"});
    const settings = {enabled:false,chatEnabled:false,botToken:"fixture-secret"};
    const receipt = new StateTransfer(source,root).export(settings);
    assert.equal(JSON.stringify(receipt).includes("fixture-secret"),false);
    assert.equal(statSync(join(root,"telegram-projects",receipt.id+".json")).mode & 0o777,0o600);
    const target = store();
    // BB can retain its plugin database while removing settings and secrets.
    for (const row of source.list("")) target.put(row.key,row.value);
    const transfer = new StateTransfer(target,root);
    let restored:any;
    await transfer.restore(receipt.id,receipt.sha256,async s => {restored=s;});
    assert.deepEqual(restored,{...settings,managedChannels:""});
    for (const row of source.list("")) assert.deepEqual(target.get(row.key),row.value);
    await transfer.restore(receipt.id,receipt.sha256,async () => {});
    target.put("chat:out:x",{sentId:99});
    await assert.rejects(transfer.restore(receipt.id,receipt.sha256,async () => {}),/state_has_changed/);
    const nextBackup=transfer.export(settings);
    assert.notEqual(nextBackup.sha256,receipt.sha256);
    await transfer.restore(nextBackup.id,nextBackup.sha256,async () => {});
    assert.deepEqual(target.get("chat:out:x"),{sentId:99});
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("identity replacement preserves owner before first input and removes the other bot's receipts; rollback restores all", async () => {
  const root = mkdtempSync(join(tmpdir(),"tg-transition-"));
  try {
    const old = store();
    old.put("owner:id",123); old.put("bot:id",100);
    old.put("ingress:offset",9000); old.put("chat:out:old",{text:"old bot reply"});
    old.put("reply:watch:old",{threadId:"thr_old"});
    let settings = {enabled:false,chatEnabled:false,botToken:"old-fixture"};
    const transfer = new StateTransfer(old,root);
    const checkpoint = transfer.export(settings);
    const target = store();
    target.put("owner:id",123); target.put("bot:id",200);
    target.put("chat:binding:0",{topicId:0,projectId:"proj_new",threadId:"thr_same",revision:"new",ready:true,cursor:80});
    const candidate = new StateTransfer(target,root).export({...settings,botToken:"new-fixture"});
    const receipt = await transfer.replace(candidate.id,candidate.sha256,checkpoint.sha256,settings,async s => { settings=s as typeof settings; });
    assert.equal(settings.enabled,false); assert.equal(settings.chatEnabled,false);
    assert.equal(old.get("bot:id"),200);
    assert.equal(old.get("ingress:offset"),undefined);
    assert.equal(old.get("chat:out:old"),undefined);
    assert.equal(old.get("reply:watch:old"),undefined);
    const routed = routeUpdate({update_id:2,message:{message_id:3,text:"pending before migration",chat:{id:123,type:"private"},from:{id:123}}},old.get("owner:id"));
    assert.equal(routed.kind,"chat");
    assert.equal((old.get("chat:binding:0") as any).threadId,"thr_same");
    const after = transfer.export(settings);
    await transfer.replace(receipt.rollback.id,receipt.rollback.sha256,after.sha256,settings,async s => {settings=s as typeof settings;});
    assert.equal(old.get("bot:id"),100);
    assert.equal(old.get("ingress:offset"),9000);
    assert.deepEqual(old.get("chat:out:old"),{text:"old bot reply"});
    assert.equal(settings.botToken,"old-fixture");
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("replacement rejects stale checkpoints and settings failure without clearing state", async () => {
  const root = mkdtempSync(join(tmpdir(),"tg-transition-"));
  try {
    const rows = store(); rows.put("owner:id",123);
    const transfer = new StateTransfer(rows,root);
    const settings = {enabled:false,chatEnabled:false};
    const checkpoint = transfer.export(settings);
    const candidate = new StateTransfer(store(),root).export(settings);
    rows.put("new-receipt",1);
    let writes=0;
    await assert.rejects(transfer.replace(candidate.id,candidate.sha256,checkpoint.sha256,settings,async()=>{writes++;}),/current_state_changed/);
    assert.equal(writes,0); assert.equal(rows.get("new-receipt"),1);
    const current=transfer.export(settings);
    await assert.rejects(transfer.replace(candidate.id,candidate.sha256,current.sha256,settings,async()=>{throw Error("settings unavailable");}),/settings unavailable/);
    assert.equal(rows.get("owner:id"),123);
    await assert.rejects(transfer.replace(candidate.id,candidate.sha256,current.sha256,settings,async()=>{rows.put("concurrent",2);}),/current_state_changed/);
    assert.equal(rows.get("owner:id"),123); assert.equal(rows.get("concurrent"),2);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("restore refuses live settings, conflicting state and corrupted or public backups", async () => {
  const root = mkdtempSync(join(tmpdir(),"tg-transfer-"));
  try {
    const source=store(); const transfer=new StateTransfer(source,root);
    assert.throws(()=>transfer.export({enabled:true}),/disable_receivers/);
    const receipt=transfer.export({enabled:false,chatEnabled:false});
    source.put("existing",true);
    await assert.rejects(transfer.restore(receipt.id,receipt.sha256,async () => {}),/empty_state/);
    source.del("existing");
    const path=join(root,"telegram-projects",receipt.id+".json");
    chmodSync(path,0o644);
    await assert.rejects(transfer.restore(receipt.id,receipt.sha256,async () => {}),/not_private/);
    chmodSync(path,0o600); appendFileSync(path," ");
    await assert.rejects(transfer.restore(receipt.id,receipt.sha256,async () => {}),/checksum/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test("personal.15 recovery preserves the KV image and respects a subsequent revocation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"tg-rollback-"));
  try {
    const source=store(), transfer=new StateTransfer(source,root);
    const settings={enabled:false,chatEnabled:false,managedChannels:"2:3:-4"};
    const backup=transfer.export(settings,"personal.15");
    const inert="migration:personal15:managedChannels";
    assert.equal(source.get(inert),settings.managedChannels);
    await transfer.restore(backup.id,backup.sha256,async s=>{assert.equal(s.managedChannels,"2:3:-4");});
    const cleared=transfer.export({...settings,managedChannels:""});
    await transfer.restore(cleared.id,cleared.sha256,async s=>{assert.equal(s.managedChannels,"");});
    const rollback=transfer.export({...settings,managedChannels:""},"personal.15");
    assert.equal(source.get(inert),"");
    await transfer.restore(rollback.id,rollback.sha256,async s=>{assert.equal(s.managedChannels,"");});
  } finally {rmSync(root,{recursive:true,force:true});}
});
