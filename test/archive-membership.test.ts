import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { openArchive } from "../archive";
import {
  createMembershipCache,
  isActiveGroupMember,
  resolveReadableChats,
  type ArchiveMemberLookup,
} from "../archive-access";

const OWNER = 1001;
const ALICE = 2002;
const BOB = 2003;
const BOT = 9001;
const GROUP_A = -1005001;
const GROUP_B = -1005002;

function memStore() {
  const rows = new Map<string, any>();
  return {
    get: <T>(k: string) => rows.get(k) as T,
    put: (k: string, v: unknown) => { rows.set(k, v); },
    del: (k: string) => { rows.delete(k); },
    list: <T>(prefix: string) => [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: v as T })),
    atomic: (fn: () => void) => fn(),
  };
}

const mkMsg = (chat: number, id: number, sender: number, name: string, text: string, extra: Record<string, unknown> = {}) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1795300000 + id,
    chat: { id: chat, type: chat < 0 ? "supergroup" : "private", title: chat === GROUP_A ? "Alpha Group" : "Beta Group" },
    from: { id: sender, is_bot: false, first_name: name },
    text,
    ...extra,
  },
});

test("archive-membership: isActiveGroupMember handles all Telegram statuses", () => {
  assert.equal(isActiveGroupMember({ status: "creator" }), true);
  assert.equal(isActiveGroupMember({ status: "administrator" }), true);
  assert.equal(isActiveGroupMember({ status: "member" }), true);
  assert.equal(isActiveGroupMember({ status: "restricted", is_member: true }), true);
  assert.equal(isActiveGroupMember({ status: "restricted", is_member: false }), false);
  assert.equal(isActiveGroupMember({ status: "restricted" }), false);
  assert.equal(isActiveGroupMember({ status: "left" }), false);
  assert.equal(isActiveGroupMember({ status: "kicked" }), false);
  assert.equal(isActiveGroupMember(undefined), false);
});

test("archive-membership: silent member sees separate-memory group across search, exact message ID and file paths", async () => {
  const store = memStore();
  store.put("rights:install-kind", "employee");
  store.put(`visibility:${BOT}:group:${GROUP_A}`, { chat: GROUP_A, title: "Alpha Group", administrator: true, event: 1 });
  store.put(`visibility:${BOT}:group:${GROUP_B}`, { chat: GROUP_B, title: "Beta Group", administrator: true, event: 2 });

  const archive = openArchive(new Database(":memory:") as any);
  // Owner wrote in GROUP_A (with a file) and GROUP_B and owner DM; ALICE has 0 messages in GROUP_A
  archive.record(BOT, mkMsg(GROUP_A, 10, OWNER, "Owner", "секретный план альфа", {
    document: { file_id: "F1", file_name: "plan.pdf", mime_type: "application/pdf", file_size: 123 },
  }));
  archive.record(BOT, mkMsg(GROUP_B, 20, OWNER, "Owner", "чужой план бета"));
  archive.record(BOT, mkMsg(OWNER, 30, OWNER, "Owner", "личная заметка владельца"));
  archive.record(BOT, mkMsg(ALICE, 40, ALICE, "Alice", "моя личка"));

  const lookup: ArchiveMemberLookup = async (chat, person) => {
    assert.equal(person, ALICE);
    if (chat === GROUP_A) return { status: "member" };
    return { status: "left" };
  };

  // 1) Search path (no singleChat filter)
  const readable = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup);
  assert.equal(readable(GROUP_A), true);
  assert.equal(readable(GROUP_B), false);
  assert.equal(readable(OWNER), false);
  assert.equal(readable(BOB), false);
  assert.equal(readable(ALICE), true);
  const found = archive.find(BOT, readable, { words: "план" }, "UTC");
  assert.equal(found.length, 1);
  assert.equal(found[0].chat, GROUP_A);

  // 2) Exact message ID path (onlyChats=[GROUP_A] vs [GROUP_B] vs [OWNER])
  const readMsgA = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, undefined, [GROUP_A]);
  assert.equal(readMsgA(GROUP_A), true);
  assert.ok(archive.message(BOT, GROUP_A, 10));
  const readMsgB = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, undefined, [GROUP_B]);
  assert.equal(readMsgB(GROUP_B), false);
  const readOwnerDm = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, undefined, [OWNER]);
  assert.equal(readOwnerDm(OWNER), false);

  // 3) Attachment download path
  const readFileA = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, undefined, [GROUP_A]);
  assert.equal(readFileA(GROUP_A), true);
  assert.equal(archive.file(BOT, GROUP_A, 10)?.file_id, "F1");
});

test("archive-membership: removed/left member loses access even with old messages in local archive", async () => {
  const store = memStore();
  store.put("rights:install-kind", "employee");
  store.put(`visibility:${BOT}:group:${GROUP_A}`, { chat: GROUP_A, title: "Alpha Group", administrator: true, event: 1 });
  // Even if group had memory: "shared", a left member must NOT retain access
  store.put(`rights:${BOT}:group:${GROUP_A}`, { version: 1, who: "all", reply: "mention", members: "propose", zones: [], note: "", memory: "shared" });

  const archive = openArchive(new Database(":memory:") as any);
  archive.record(BOT, mkMsg(GROUP_A, 11, ALICE, "Alice", "я раньше писала сюда"));
  archive.record(BOT, mkMsg(GROUP_A, 12, OWNER, "Owner", "обновление после удаления"));
  assert.deepEqual(archive.groupsOf(BOT, ALICE), [GROUP_A]);

  for (const st of [{ status: "left" }, { status: "kicked" }, { status: "restricted", is_member: false }]) {
    const readable = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, async () => st);
    assert.equal(readable(GROUP_A), false);
    assert.equal(archive.find(BOT, readable, { words: "обновление" }, "UTC").length, 0);
  }
});

test("archive-membership: API error fails closed and is not cached; confirmed results cache for TTL", async () => {
  const store = memStore();
  store.put(`visibility:${BOT}:group:${GROUP_A}`, { chat: GROUP_A, title: "Alpha Group", administrator: true, event: 1 });
  const archive = openArchive(new Database(":memory:") as any);

  let now = 1_000_000;
  const cache = createMembershipCache(60_000, () => now);
  let calls = 0;
  let mode: "fail" | "member" | "left" = "fail";
  const lookup: ArchiveMemberLookup = async () => {
    calls++;
    if (mode === "fail") throw new Error("telegram_timeout");
    return { status: mode };
  };

  // 1) Transient error -> fail closed, NOT cached
  const rFail = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, cache, [GROUP_A]);
  assert.equal(rFail(GROUP_A), false);
  assert.equal(calls, 1);

  // 2) Next call succeeds -> cached for 60 s
  mode = "member";
  const rOk1 = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, cache, [GROUP_A]);
  assert.equal(rOk1(GROUP_A), true);
  assert.equal(calls, 2);

  // Within TTL: uses cache, no extra API call
  now += 30_000;
  mode = "left";
  const rCached = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, cache, [GROUP_A]);
  assert.equal(rCached(GROUP_A), true);
  assert.equal(calls, 2);

  // After TTL expires: calls API again and revokes access
  now += 31_000;
  const rExpired = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "person", subject: ALICE }, lookup, cache, [GROUP_A]);
  assert.equal(rExpired(GROUP_A), false);
  assert.equal(calls, 3);
});

test("archive-membership: owner and group conversations do not call getChatMember", async () => {
  const store = memStore();
  store.put("rights:install-kind", "employee");
  const archive = openArchive(new Database(":memory:") as any);
  let calls = 0;
  const lookup: ArchiveMemberLookup = async () => { calls++; return { status: "member" }; };

  const ownerRead = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "owner" }, lookup);
  assert.equal(ownerRead(GROUP_A), true);
  assert.equal(ownerRead(ALICE), false);
  const groupRead = await resolveReadableChats(store as any, archive, BOT, OWNER, { kind: "group", chat: GROUP_A }, lookup);
  assert.equal(groupRead(GROUP_A), true);
  assert.equal(groupRead(GROUP_B), false);
  assert.equal(calls, 0);
});
