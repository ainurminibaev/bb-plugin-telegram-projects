import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, rmSync, statSync, appendFileSync, chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StateTransfer} from "../state-transfer";
import type {Store} from "../model";

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
    const target = store(); const transfer = new StateTransfer(target,root);
    let restored:any;
    await transfer.restore(receipt.id,receipt.sha256,async s => {restored=s;});
    assert.deepEqual(restored,settings);
    for (const row of source.list("")) assert.deepEqual(target.get(row.key),row.value);
    await transfer.restore(receipt.id,receipt.sha256,async () => {});
    target.put("chat:out:x",{sentId:99});
    await assert.rejects(transfer.restore(receipt.id,receipt.sha256,async () => {}),/state_has_changed/);
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
