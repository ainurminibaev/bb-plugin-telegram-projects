import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, stat, chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {allInboxes, inboxFor, projectInboxes} from "../project-inbox";
import {saveLocalTelegramFile} from "../telegram-files";

test("a project with its own inbox gets files there; others use the shared one", () => {
  const setting = "proj_vyex2qpdqn=/home/ag1/inbox/, proj_b=/srv/b/inbox,bad=relative,x=/a/../etc,=/nope";
  assert.deepEqual([...projectInboxes(setting)], [["proj_vyex2qpdqn","/home/ag1/inbox"],["proj_b","/srv/b/inbox"]]);
  assert.equal(inboxFor(setting, "/var/lib/bb/inbox", "proj_vyex2qpdqn"), "/home/ag1/inbox");
  assert.equal(inboxFor(setting, "/var/lib/bb/inbox", "proj_other"), "/var/lib/bb/inbox");
  assert.equal(inboxFor("", "/var/lib/bb/inbox", "proj_b"), "/var/lib/bb/inbox");
  assert.equal(inboxFor(setting, "/var/lib/bb/inbox", undefined), "/var/lib/bb/inbox");
  assert.deepEqual(allInboxes(setting, "/var/lib/bb/inbox"), ["/var/lib/bb/inbox","/home/ag1/inbox","/srv/b/inbox"]);
});

test("a file saved into a project inbox is 640 and its folders keep the inbox group bit (2750)", async () => {
  const base = await mkdtemp(join(tmpdir(), "inbox-"));
  const local = join(base, "local"), inbox = join(base, "inbox");
  await mkdir(local); await mkdir(inbox); await chmod(inbox, 0o2770);
  const source = join(local, "doc.txt"); await writeFile(source, "hello");
  // The service runs with umask 0077, and an earlier run left a folder closed: both are opened explicitly.
  const umask = process.umask(0o077);
  await mkdir(join(inbox,"groups"), {mode:0o700});
  const saved = await saveLocalTelegramFile({sourcePath:source, localRoot:local, inboxRoot:join(inbox,"groups","1","2"), inboxBase:inbox,
    threadId:"thr_x", updateId:7, fileId:"f", name:"doc.txt", expectedBytes:5, signal:new AbortController().signal});
  process.umask(umask);
  assert.ok(saved.path.startsWith(inbox + "/"));
  for (const d of ["groups","groups/1","groups/1/2"]) assert.equal((await stat(join(inbox,d))).mode & 0o7777, 0o2750, d);
  assert.equal((await stat(saved.path.replace(/\/[^/]+$/,""))).mode & 0o7777, 0o2750);
  assert.equal((await stat(inbox)).mode & 0o7777, 0o2770);
  assert.equal((await stat(saved.path)).mode & 0o777, 0o640);
  const folder = await stat(join(inbox, "groups"));
  assert.equal(folder.mode & 0o7777, 0o2750);
  assert.equal(folder.gid, (await stat(inbox)).gid);
});
