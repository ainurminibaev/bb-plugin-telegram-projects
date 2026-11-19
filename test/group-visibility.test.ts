import test from "node:test";
import assert from "node:assert/strict";
import {
  privacyKey,
  rememberMembership,
  sendVisibilityUpdates,
} from "../group-visibility";
import { TelegramFailure, type Store, type Telegram } from "../model";
test("actual group administrator receives one notice per visibility change, including across restart", async () => {
  const data = new Map<string, any>(),
    out: any[] = [];
  const store: Store = {
    get: (k) => data.get(k),
    put: (k, v) => {
      data.set(k, v);
    },
    del: (k) => {
      data.delete(k);
    },
    list: (p) =>
      [...data]
        .filter(([k]) => k.startsWith(p))
        .map(([key, value]) => ({ key, value })),
    atomic: (fn) => fn(),
  };
  let fail = false;
  const send =
    (chat: number): Telegram =>
    async (method, body): Promise<any> => {
      if (method === "getChatAdministrators") {
        assert.equal(chat, -7);
        return [{ status: "creator", user: { id: 4 } }];
      }
      assert.equal(method, "sendMessage");
      assert.equal(chat, 4);
      if (fail) throw new TelegramFailure("telegram_403");
      out.push(body.text);
      return { message_id: out.length };
    };
  const event = (id: number, status: string) =>
    rememberMembership(store, 9, {
      update_id: id,
      my_chat_member: {
        from: { id: 30 },
        chat: { id: -7, type: "group", title: "Alpha" },
        new_chat_member: { status, user: { id: 9 } },
      },
    });
  store.put(privacyKey(9), true);
  event(2, "member");
  await sendVisibilityUpdates(store, 9, send);
  event(2, "member");
  await sendVisibilityUpdates({ ...store }, 9, send);
  assert.equal(out.length, 1);
  assert.match(out[0], /ограничивает доставку/);
  event(3, "administrator");
  await sendVisibilityUpdates(store, 9, send);
  assert.match(out[1], /все обычные сообщения/);
  event(4, "member");
  await sendVisibilityUpdates(store, 9, send);
  assert.equal(out.length, 3);
  store.put(privacyKey(9), false);
  await sendVisibilityUpdates(store, 9, send);
  assert.match(out[3], /выключен/);
  event(5, "left");
  event(6, "member");
  fail = true;
  await sendVisibilityUpdates(store, 9, send);
  assert.equal(
    store.list<any>("visibility:9:notice:")[0].value.status,
    "unavailable",
  );
});
