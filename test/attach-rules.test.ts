import test from "node:test";
import assert from "node:assert/strict";
import {ownerMayAttach} from "../attach-rules";

test("С84: the owner's conversation attaches files of other projects but never places of secrets",()=>{
  assert.deepEqual(ownerMayAttach("/srv/projects/other/outputs/report.pdf"),{ok:true});
  for (const p of ["/home/u/.secrets/api.txt","/home/u/.local/share/vallis/store.db","/home/u/.config/vallis/x","/home/u/.codex/auth.json",
    "/srv/app/.env","/srv/app/.env.local","/srv/app/auth.json","/srv/app/id_ed25519","/srv/app/server.key","/srv/app/bot-token.txt"])
    assert.equal(ownerMayAttach(p).ok,false,p);
});
