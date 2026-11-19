import { sourcesVisible } from "./source-access";
import {
  proposalInput,
  selectedItems,
  verifiedCompletionLinks,
} from "./owner-selection";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { TelegramFailure, type Store, type Telegram } from "./model";

const id = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const user = z.number().int().positive().safe();
const socket = z.string().refine(isAbsolute);
const ids = z.array(user).max(100);
const catalog = z.array(id).max(100);
const operation = z
  .object({
    id,
    resource: id,
    connection: id,
    socket,
    approval: z.boolean(),
    resultHost: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .optional(),
    sources: catalog,
  })
  .strict();
export const employeeProfile = z
  .object({
    schema: z.literal(1),
    owner: user,
    settingsTitle: z.string().min(1).max(64).default("Настройки сотрудника"),
    alternateRoles: catalog.default([]),
    botId: user,
    username: z.string().regex(/^[a-zA-Z0-9_]{5,32}$/),
    role: id,
    admins: ids.min(1),
    members: ids,
    approvers: ids,
    sources: catalog,
    connections: catalog,
    operations: z.array(operation).max(100),
    events: z.array(z.enum(["member_joined", "topic_created"])).max(2),
    conversationSocket: socket,
    personalAccess: z
      .object({ subjects: ids, conversationSocket: socket })
      .strict()
      .optional(),
    personalGrants: z
      .array(
        z
          .object({
            subject: user,
            operations: catalog.min(1),
            conversationSocket: socket,
            allowHere: z.boolean().default(false),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const lists = [
      [p.role, ...p.alternateRoles],
      p.admins,
      p.members,
      p.approvers,
      p.sources,
      p.connections,
      p.events,
      p.operations.map((o) => o.id),
      [
        ...(p.personalAccess?.subjects ?? []),
        ...p.personalGrants.map((g) => g.subject),
      ],
    ];
    if (
      lists.some((v) => new Set<string | number>(v).size !== v.length) ||
      p.personalGrants.some(
        (g) =>
          !p.members.includes(g.subject) ||
          new Set(g.operations).size !== g.operations.length ||
          g.operations.some(
            (id) =>
              !p.operations.some(
                (o) => o.id === id && o.sources.length && o.resultHost,
              ),
          ),
      ) ||
      p.operations.some(
        (o) =>
          !p.connections.includes(o.connection) ||
          o.sources.some((s) => !p.sources.includes(s)),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate or unknown catalog reference",
      });
  });
type Profile = z.infer<typeof employeeProfile>;
type Field =
  | "topics"
  | "members"
  | "sources"
  | "operations"
  | "approvers"
  | "requireApproval"
  | "triggers"
  | "events";
type Rules = Record<Field, string[]>;
type Saved = { version: number; rules: Rules; note: string };
type Draft = Saved & {
  actor: number;
  chat: number;
  topic: number;
  profileHash: string;
  page: number;
  catalog: Rules;
  awaitNote?: boolean;
};
type Ticket = {
  chat: number;
  topic: number;
  message: number;
  sender: number;
  destination?: "here" | "dm";
  personalSources?: string[];
  direct?: boolean;
  version: number;
  profileHash: string;
  operation: string;
  input: string;
  items?: string[];
  revision: number;
  taskId: string;
  draftHash: string;
  selected?: number[];
  state: "pending" | "started" | "done";
  actor?: number;
};
type Destination = "here" | "dm";
function directDestination(m: any): Destination | undefined {
  if (
    typeof m.text !== "string" ||
    m.forward_origin ||
    m.is_automatic_forward ||
    m.via_bot ||
    m.quote ||
    m.external_reply ||
    m.edit_date ||
    /[«»“”"\n>]/u.test(m.text) ||
    m.entities?.some((e: any) =>
      ["blockquote", "expandable_blockquote", "pre", "code"].includes(e.type),
    )
  )
    return;
  const matches = [
    ...m.text.matchAll(
      /(?:ответь|пришли|отправь|скинь|сообщи)\s+(?:результат\s+)?(сюда|в эту группу|в эту тему|мне в личку|в личку)(?=$|[.,!;?\s])/giu,
    ),
  ];
  if (matches.length !== 1) return;
  return /личку/iu.test(matches[0][1]) ? "dm" : "here";
}
function personalScope(
  s: Store,
  p: Profile,
  subject: number,
  chat: number,
  topic: number,
  destination: Destination,
  required: string[] = [],
) {
  const full = p.personalAccess?.subjects.includes(subject)
    ? p.personalAccess
    : undefined;
  const grant = p.personalGrants.find((g) => g.subject === subject);
  if (
    (!full && (!grant || !p.members.includes(subject))) ||
    !s.get("employee:" + p.botId + ":dm:" + subject) ||
    (chat === subject
      ? !full || topic !== 0 || destination !== "dm"
      : !s.get("employee:" + p.botId + ":directory:" + chat) ||
        !saved(s, p, chat).rules.topics.includes(String(topic)))
  )
    return;
  const operations = p.operations.filter(
    (o) =>
      !!full ||
      (!!grant &&
        grant.operations.includes(o.id) &&
        (destination === "dm" ||
          (grant.allowHere &&
            sourcesVisible(o.sources, p.botId, chat, topic)))),
  );
  const sources = full
    ? p.sources
    : [...new Set(operations.flatMap((o) => o.sources))];
  if (
    (!full && !operations.length) ||
    !required.every((id) => sources.includes(id))
  )
    return;
  return {
    conversationSocket: (full ?? grant)!.conversationSocket,
    operations,
    sources,
  };
}
type Send = (chat: number) => Telegram;
type Call = (
  socket: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;
const fields: Field[] = [
  "topics",
  "members",
  "sources",
  "operations",
  "approvers",
  "requireApproval",
  "triggers",
  "events",
];
const labels: Record<Field, string> = {
  topics: "Темы",
  members: "Участники",
  sources: "Материалы",
  operations: "Действия",
  approvers: "Согласующие",
  requireApproval: "Требовать подтверждение",
  triggers: "Отвечать",
  events: "Писать первым",
};
const empty = (): Saved => ({
  version: 0,
  rules: {
    topics: [],
    members: [],
    sources: [],
    operations: [],
    approvers: [],
    requireApproval: [],
    triggers: [],
    events: [],
  },
  note: "",
});
const hash = (p: Profile) =>
  createHash("sha256")
    .update(
      JSON.stringify(p, (k, v) =>
        k === "personalGrants" && Array.isArray(v) && !v.length ? undefined : v,
      ),
    )
    .digest("hex");
const key = (p: Profile, chat: number) => `employee:${p.botId}:group:${chat}`;
const saved = (s: Store, p: Profile, chat: number) =>
  s.get<Saved>(key(p, chat)) ?? empty();
const ticketKey = (p: Profile, t: string) => `employee:${p.botId}:ticket:${t}`;
const draftKey = (p: Profile, actor: number) =>
  `employee:${p.botId}:draft:${actor}`;
const topicsKey = (p: Profile, chat: number) => key(p, chat) + ":topics";
const options = (p: Profile, topics: number[]): Rules => ({
  topics: topics.map(String),
  members: p.members.map(String),
  sources: p.sources,
  operations: p.operations.map((o) => o.id),
  approvers: p.approvers.map(String),
  requireApproval: p.operations.map((o) => o.id),
  triggers: ["mention", "reply"],
  events: p.events,
});
function valid(r: Rules, bounds: Rules) {
  return fields.every((f) => r[f].every((v) => bounds[f].includes(v)));
}
function applicable(r: Rules, bounds: Rules): Rules {
  return Object.fromEntries(
    fields.map((f) => [f, r[f].filter((x) => bounds[f].includes(x))]),
  ) as Rules;
}
function opFor(p: Profile, r: Rules, name: string) {
  return p.operations.find(
    (o) =>
      o.id === name &&
      r.operations.includes(name) &&
      o.sources.every((s) => r.sources.includes(s)),
  );
}
const generation = (s: Store, p: Profile, chat: number) =>
  saved(s, p, chat).version;
type ProfileReader = () => Profile;
const realCall: Call = (path, payload) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        method: "POST",
        socketPath: path,
        path: "/",
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("error", reject);
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 65536) req.destroy(Error("adapter response too large"));
          else chunks.push(b);
        });
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw Error("adapter failed");
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(30000, () => req.destroy(Error("adapter timeout")));
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
export function readEmployeeProfile(path: string) {
  if (!isAbsolute(path)) throw Error("absolute employee profile required");
  return employeeProfile.parse(JSON.parse(readFileSync(path, "utf8")));
}
function card(s: Store, p: Profile, d: Draft, token: string) {
  const bounds = d.catalog;
  const choices = fields.flatMap((field) =>
    bounds[field].map((value) => ({ field, value })),
  );
  const perPage = 8,
    pages = Math.max(1, Math.ceil(choices.length / perPage));
  d.page = Math.min(Math.max(0, d.page), pages - 1);
  const button = (text: string, action: string) => ({
    text,
    callback_data: `ep:${token}:${action}`,
  });
  const rows = choices
    .slice(d.page * perPage, (d.page + 1) * perPage)
    .map(({ field, value }, i) => {
      const op =
        field === "operations"
          ? p.operations.find((o) => o.id === value)
          : undefined;
      return [
        button(
          `${d.rules[field].includes(value) ? "☑" : "☐"} ${labels[field]} · ${value}${op ? " / " + op.resource : ""}`,
          "t" + (d.page * perPage + i),
        ),
      ];
    });
  if (pages > 1) rows.push([button("Назад", "prev"), button("Дальше", "next")]);
  rows.push([button("Заметка", "note"), button("Сохранить", "save")]);
  return {
    text:
      `Правила группы ${d.chat} · версия ${d.version} · ${d.page + 1}/${pages}\n` +
      (d.awaitNote
        ? "Следующим сообщением пришлите заметку."
        : `Заметка: ${d.note || "—"}`),
    reply_markup: { inline_keyboard: rows },
  };
}
const response = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("answer"), text: z.string().min(1).max(3800) })
    .strict(),
  z
    .object({
      kind: z.literal("proposal"),
      operation: id,
      input: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("direct"),
      operation: id,
      revision: z.number().int().positive().safe(),
      item: proposalInput.shape.items.element,
    })
    .strict(),
  z
    .object({
      kind: z.literal("selection"),
      operation: id,
      revision: z.number().int().positive().safe(),
      items: proposalInput.shape.items,
    })
    .strict(),
]);
type Limits = {
  role: string;
  admins: string[];
  members: string[];
  sources: string[];
  connections: string[];
  operations: string[];
  approvers: string[];
  events: string[];
  personal: string[];
  confirm: string[];
};
const limitFields = [
  "admins",
  "members",
  "sources",
  "connections",
  "operations",
  "approvers",
  "events",
  "personal",
  "confirm",
] as const;
const limitLabels = {
  admins: "Администраторы",
  members: "Участники",
  sources: "Знания",
  connections: "Подключения",
  operations: "Действия",
  approvers: "Согласующие",
  events: "События",
  personal: "Личный доступ",
  confirm: "Всегда согласовывать",
};
const globalKey = (p: Profile) => `employee:${p.botId}:limits`;
function defaults(p: Profile): Limits {
  return {
    role: p.role,
    admins: p.admins.map(String),
    members: p.members.map(String),
    sources: p.sources,
    connections: p.connections,
    operations: p.operations.map((o) => o.id),
    approvers: p.approvers.map(String),
    events: p.events,
    personal: (p.personalAccess?.subjects ?? []).map(String),
    confirm: p.operations.filter((o) => o.approval).map((o) => o.id),
  };
}
export function employeeHome(store: Store, profile: Profile) {
  const applied = effective(store, profile);
  const local = store.get<{ revision: number }>(globalKey(profile));
  const missing: string[] = [];
  if (!applied.members.length)
    missing.push("назначить участников для подключения групп");
  if (applied.operations.some((op) => op.approval) && !applied.approvers.length)
    missing.push("назначить согласующего для действий с подтверждением");
  const text = [
    local
      ? "Действуют локальные назначения · версия " + local.revision
      : "Действуют назначения из комплекта сотрудника.",
    "Роль: " + applied.role,
    "Источники: " + (applied.sources.join(", ") || "—"),
    "Действия: " +
      (applied.operations.map((op) => op.id + " / " + op.resource).join(", ") ||
        "—"),
    "Согласующие: " + (applied.approvers.join(", ") || "—"),
    ...(missing.length
      ? ["Требует настройки: " + missing.join(", ")]
      : ["Обязательные назначения заполнены."]),
  ];
  return {
    text: text.join("\n").slice(0, 4000),
    reply_markup: {
      keyboard: [[profile.settingsTitle, "Мои группы"]],
      resize_keyboard: true,
    },
  };
}
type GlobalDraft = {
  token: string;
  base: number;
  bounds: string;
  page: number;
  selected: Limits;
};
function effective(s: Store, p: Profile) {
  const row = s.get<{ revision: number; selected: Limits }>(globalKey(p)),
    selection = row?.selected ?? defaults(p);
  const filter = (field: (typeof limitFields)[number], values: string[]) =>
    values.filter((x) => selection[field].includes(x));
  const sources = filter("sources", p.sources),
    connections = filter("connections", p.connections);
  return {
    ...p,
    personalAccess: p.personalAccess && {
      ...p.personalAccess,
      subjects: p.personalAccess.subjects.filter((x) =>
        selection.personal?.includes(String(x)),
      ),
    },
    policyRevision: row?.revision ?? 0,
    role: [p.role, ...p.alternateRoles].includes(selection.role)
      ? selection.role
      : p.role,
    admins: [
      ...new Set([
        p.owner,
        ...filter("admins", p.admins.map(String)).map(Number),
      ]),
    ],
    members: filter("members", p.members.map(String)).map(Number),
    approvers: filter("approvers", p.approvers.map(String)).map(Number),
    events: p.events.filter((x) => selection.events.includes(x)),
    sources,
    connections,
    operations: p.operations
      .filter(
        (o) =>
          selection.operations.includes(o.id) &&
          connections.includes(o.connection) &&
          o.sources.every((x) => sources.includes(x)),
      )
      .map((o) => ({
        ...o,
        approval: o.approval || selection.confirm.includes(o.id),
      })),
  };
}
function limitOptions(p: Profile) {
  const all = defaults(p);
  all.confirm = p.operations.map((o) => o.id);
  return [
    ...[p.role, ...p.alternateRoles].map((v) => ({ f: "role" as const, v })),
    ...limitFields.flatMap((f) => all[f].map((v) => ({ f, v }))),
  ];
}
function limitsCard(p: Profile, d: GlobalDraft) {
  const all = limitOptions(p),
    pages = Math.ceil(all.length / 8);
  d.page = Math.min(Math.max(0, d.page), pages - 1);
  const button = (text: string, a: string) => ({
    text,
    callback_data: "el:" + d.token + ":" + a,
  });
  const rows = all.slice(d.page * 8, d.page * 8 + 8).map(({ f, v }, i) => {
    const active =
      f === "role" ? d.selected.role === v : d.selected[f].includes(v);
    const op =
      f === "operations" ? p.operations.find((o) => o.id === v) : undefined;
    return [
      button(
        `${active ? "☑" : "☐"} ${f === "role" ? "Роль" : limitLabels[f]} · ${v}${op ? " / " + op.resource : ""}`,
        "t" + (d.page * 8 + i),
      ),
    ];
  });
  if (pages > 1) rows.push([button("Назад", "prev"), button("Дальше", "next")]);
  rows.push([button("Сохранить", "save")]);
  const summary = [
    "Роль: " + d.selected.role,
    ...limitFields.map(
      (f) => limitLabels[f] + ": " + (d.selected[f].join(", ") || "—"),
    ),
  ];
  return {
    text: (
      p.settingsTitle +
      " · версия " +
      d.base +
      " · " +
      (d.page + 1) +
      "/" +
      pages +
      "\n" +
      summary.join("\n")
    ).slice(0, 4000),
    reply_markup: { inline_keyboard: rows },
  };
}
async function configureLimits(
  s: Store,
  read: ProfileReader,
  m: any,
  cb: any,
  send: Send,
) {
  const p = read(),
    k = globalKey(p),
    dk = k + ":draft",
    row = s.get<{ revision: number; selected: Limits }>(k);
  if (!cb || cb.data === "emp:settings") {
    const d: GlobalDraft = {
      token: randomUUID().slice(0, 18),
      base: row?.revision ?? 0,
      bounds: hash(p),
      page: 0,
      selected: structuredClone(
        row
          ? { ...row.selected, personal: row.selected.personal ?? [] }
          : defaults(p),
      ),
    };
    s.put(dk, d);
    await send(p.owner)("sendMessage", limitsCard(p, d));
    return;
  }
  const d = s.get<GlobalDraft>(dk);
  if (!d || !cb.data.startsWith("el:" + d.token + ":")) return;
  if (
    !Array.isArray(d.selected.personal) ||
    d.bounds !== hash(p) ||
    d.base !== (row?.revision ?? 0)
  ) {
    s.del(dk);
    await send(p.owner)("sendMessage", {
      text: "Настройки изменились. Откройте карточку заново.",
    });
    return;
  }
  const action = cb.data.split(":")[2];
  if (action === "save") {
    s.atomic(() => {
      if (
        hash(read()) !== d.bounds ||
        (s.get<{ revision: number }>(k)?.revision ?? 0) !== d.base
      )
        throw Error("stale employee profile");
      const all = defaults(p);
      all.confirm = p.operations.map((o) => o.id);
      if (
        ![p.role, ...p.alternateRoles].includes(d.selected.role) ||
        limitFields.some((f) => d.selected[f].some((v) => !all[f].includes(v)))
      )
        throw Error("outside employee limits");
      s.put(k, { revision: d.base + 1, selected: d.selected, actor: p.owner });
      s.del(dk);
    });
    await send(p.owner)("sendMessage", {
      text: "Настройки сотрудника сохранены · версия " + (d.base + 1),
    });
    return;
  }
  if (action === "prev" || action === "next")
    d.page += action === "prev" ? -1 : 1;
  else if (/^t\d+$/.test(action)) {
    const item = limitOptions(p)[Number(action.slice(1))];
    if (!item) return;
    const { f, v } = item;
    if (f === "role") d.selected.role = v;
    else if (f === "confirm" && p.operations.find((o) => o.id === v)?.approval)
      return;
    else
      d.selected[f] = d.selected[f].includes(v)
        ? d.selected[f].filter((x) => x !== v)
        : [...d.selected[f], v];
  } else return;
  d.token = randomUUID().slice(0, 18);
  const contents = limitsCard(p, d);
  s.put(dk, d);
  await send(p.owner)("editMessageText", {
    message_id: m.message_id,
    ...contents,
  });
}
// Reserve the management interface in private chats; ordinary paired conversations keep their existing route.
export function isEmployeeUpdate(
  s: Store,
  bot: number,
  update: any,
  owner?: number,
  settingsTitle?: string,
  personalSubjects: readonly number[] = [],
  fullSubjects: readonly number[] = [],
) {
  const cb = update.callback_query,
    m = cb?.message ?? update.message ?? update.edited_message;
  if (m?.chat?.type !== "private") {
    // Previously bound groups have a separate executor and pending work. Do not adopt them implicitly.
    const chat =
      m?.chat ?? update.guest_message?.chat ?? update.my_chat_member?.chat;
    if (
      chat &&
      !s.get("employee:" + bot + ":directory:" + chat.id) &&
      s.list("group:policy:" + chat.id + ":").length
    )
      return false;
    return true;
  }
  if (
    m.reply_to_message &&
    s.get(
      `employee:${bot}:selection:${m.chat.id}:${m.reply_to_message.message_id}`,
    )
  )
    return true;
  if (cb) return /^(emp:|ep:|ea:|el:)/.test(cb.data ?? "");
  if (
    owner &&
    m.chat.id === owner &&
    ["/start", "/employee", "Настройки сотрудника", settingsTitle]
      .filter(Boolean)
      .includes(m.text)
  )
    return true;
  if (owner && fullSubjects.includes(m.chat.id)) return true;
  if (m.text === "/start" && personalSubjects.includes(m.chat.id) && owner)
    return true;
  if (["/groups", "Мои группы"].includes(m.text)) return true;
  return !!s.get<{ d: Draft }>(`employee:${bot}:draft:${m.chat.id}`)?.d
    .awaitNote;
}
export async function employeeUpdate(
  s: Store,
  boundary: ProfileReader,
  update: any,
  send: Send,
  call: Call = realCall,
) {
  const read = () => effective(s, boundary());
  const p = read(),
    cb = update.callback_query;
  const directory = "employee:" + p.botId + ":directory:";
  const change = update.my_chat_member;
  if (
    change &&
    ["group", "supergroup"].includes(change.chat?.type) &&
    change.new_chat_member?.user?.id === p.botId
  ) {
    const k = directory + change.chat.id;
    if (["member", "administrator"].includes(change.new_chat_member.status)) {
      s.put(k, {
        chat: change.chat.id,
        title: String(change.chat.title ?? change.chat.id),
      });
      if (!change.chat.is_forum) s.put(topicsKey(p, change.chat.id), [0]);
      if (!["member", "administrator"].includes(change.old_chat_member?.status))
        for (const admin of p.admins) {
          try {
            await send(admin)("sendMessage", {
              text: "Сотрудник добавлен в группу.",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Мои группы", callback_data: "emp:list" }],
                ],
              },
            });
          } catch (e) {
            if (!(e instanceof TelegramFailure && !e.ambiguous)) throw e;
          }
        }
    } else {
      s.del(k);
      s.del(topicsKey(p, change.chat.id));
      s.put(key(p, change.chat.id), {
        ...empty(),
        version: generation(s, p, change.chat.id) + 1,
      });
    }
    return;
  }
  const m = cb?.message ?? update.message;
  if (!m) return;
  const actor = (cb?.from ?? m?.from)?.id,
    chat = m?.chat?.id;
  if (
    !Number.isSafeInteger(actor) ||
    !Number.isSafeInteger(chat) ||
    (cb?.from ?? m.from)?.is_bot ||
    m.sender_chat
  )
    return;
  const privateChat = m.chat.type === "private" && chat === actor;
  if (cb && m.from?.id !== p.botId) return;
  const sendText = (target: number, text: string, extra = {}) =>
    send(target)("sendMessage", { text, ...extra });
  if (
    privateChat &&
    !cb &&
    m.text === "/start" &&
    !m.forward_origin &&
    !m.via_bot &&
    (p.personalAccess?.subjects.includes(actor) ||
      p.personalGrants.some((g) => g.subject === actor))
  ) {
    s.put("employee:" + p.botId + ":dm:" + actor, true);
    if (actor !== p.owner) {
      await sendText(actor, "Личка подключена для ваших поручений.");
      return;
    }
  }
  if (privateChat && actor === p.owner) {
    if (!cb && m.text === "/start") {
      await send(actor)("sendMessage", employeeHome(s, boundary()));
      return;
    }
    if (
      (!cb &&
        ["/employee", "Настройки сотрудника", p.settingsTitle].includes(
          m.text,
        )) ||
      cb?.data === "emp:settings" ||
      cb?.data?.startsWith("el:")
    ) {
      await configureLimits(s, boundary, m, cb, send);
      return;
    }
  }
  const dk = draftKey(p, actor);

  if (
    !privateChat &&
    !cb &&
    ["group", "supergroup"].includes(m.chat.type) &&
    p.admins.includes(actor) &&
    !m.forward_origin &&
    ["/setup", "/setup@" + p.username].includes(m.text)
  )
    s.put(directory + chat, { chat, title: String(m.chat.title ?? chat) });
  if (
    !privateChat &&
    !cb &&
    ["group", "supergroup"].includes(m.chat.type) &&
    s.get(directory + chat)
  ) {
    const topics = s.get<number[]>(topicsKey(p, chat)) ?? [],
      topic = m.message_thread_id ?? 0;
    if (Number.isSafeInteger(topic) && topic >= 0 && !topics.includes(topic))
      s.put(topicsKey(p, chat), [...topics, topic]);
  }
  if (
    privateChat &&
    p.admins.includes(actor) &&
    ((["/groups", "Мои группы"].includes(m.text) && !cb) ||
      cb?.data === "emp:list" ||
      /^emp:list:[0-9]+$/.test(cb?.data ?? ""))
  ) {
    const groups = s
      .list<{ chat: number; title: string }>(directory)
      .sort((a, b) => a.key.localeCompare(b.key));
    const legacy =
      actor === p.owner
        ? s
            .list<{
              botId: number;
              ownerId?: number;
              chatId: number;
              topicId: number;
            }>("group:policy:")
            .filter(
              ({ value: v, key }) =>
                v.botId === p.botId &&
                (v.ownerId === undefined || v.ownerId === actor) &&
                Number.isSafeInteger(v.chatId) &&
                Number.isSafeInteger(v.topicId) &&
                key === `group:policy:${v.chatId}:${v.topicId}`,
            )
            .sort(
              (a, b) =>
                a.value.chatId - b.value.chatId ||
                a.value.topicId - b.value.topicId,
            )
        : [];
    const count = groups.length + legacy.length;
    const page = Number(cb?.data?.split(":")[2] ?? 0);
    const offset = page * 8;
    const rows = groups
      .slice(offset, offset + 8)
      .map(({ value }) => [
        { text: value.title, callback_data: "emp:open:" + value.chat },
      ]);
    const lines = legacy
      .slice(
        Math.max(0, offset - groups.length),
        Math.max(0, offset + 8 - groups.length),
      )
      .map(({ value }) => {
        const title =
          groups.find((g) => g.value.chat === value.chatId)?.value.title ??
          value.chatId;
        return `${title} · тема ${value.topicId} (только просмотр)`;
      });
    if (page > 0)
      rows.push([{ text: "Назад", callback_data: "emp:list:" + (page - 1) }]);
    if (offset + 8 < count)
      rows.push([{ text: "Дальше", callback_data: "emp:list:" + (page + 1) }]);
    await sendText(
      actor,
      count ? ["Мои группы", ...lines].join("\n") : "Группы пока не добавлены.",
      rows.length ? { reply_markup: { inline_keyboard: rows } } : {},
    );
    return;
  }
  if (
    privateChat &&
    p.admins.includes(actor) &&
    /^emp:open:-[0-9]+$/.test(cb?.data ?? "")
  ) {
    const target = Number(cb.data.slice(9)),
      info = s.get(directory + target);
    if (!info) return;
    const token = randomUUID().slice(0, 18);
    const d: Draft = {
      ...structuredClone(saved(s, p, target)),
      actor,
      chat: target,
      topic: 0,
      page: 0,
      profileHash: hash(p),
      catalog: options(p, s.get<number[]>(topicsKey(p, target)) ?? []),
    };
    for (const f of fields)
      d.rules[f] = d.rules[f].filter((v) => d.catalog[f].includes(v));
    s.put(dk, { d, token });
    await send(actor)("sendMessage", card(s, p, d, token));
    return;
  }
  if (privateChat && p.admins.includes(actor)) {
    const entry = s.get<{ d: Draft; token: string }>(dk);
    if (
      entry &&
      (cb?.data?.startsWith("ep:" + entry.token + ":") ||
        (!cb && entry.d.awaitNote && typeof m.text === "string"))
    ) {
      const { d, token } = entry;
      if (
        !s.get(directory + d.chat) ||
        hash(p) !== d.profileHash ||
        generation(s, p, d.chat) !== d.version
      ) {
        s.del(dk);
        await sendText(actor, "Правила изменились. Откройте карточку заново.");
        return;
      }
      const bounds = options(p, s.get<number[]>(topicsKey(p, d.chat)) ?? []);
      const action = cb?.data.split(":")[2];
      if (!cb) {
        d.note = m.text.slice(0, 500);
        d.awaitNote = false;
      } else if (action === "save") {
        if (!valid(d.rules, bounds)) throw Error("outside employee limits");
        s.atomic(() => {
          const current = read();
          if (
            !current.admins.includes(actor) ||
            hash(current) !== d.profileHash ||
            generation(s, current, d.chat) !== d.version
          )
            throw Error("stale policy");
          s.put(key(current, d.chat), {
            version: d.version + 1,
            rules: d.rules,
            note: d.note,
            actor,
          });
          s.del(dk);
        });
        await sendText(
          actor,
          `Правила группы ${d.chat} сохранены · версия ${d.version + 1}`,
        );
        return;
      } else if (action === "note") d.awaitNote = true;
      else if (action === "prev" || action === "next")
        d.page += action === "prev" ? -1 : 1;
      else if (/^t\d+$/.test(action)) {
        const option = fields.flatMap((f) =>
          d.catalog[f].map((v) => ({ f, v })),
        )[Number(action.slice(1))];
        if (!option) return;
        const { f, v } = option;
        d.rules[f] = d.rules[f].includes(v)
          ? d.rules[f].filter((x) => x !== v)
          : [...d.rules[f], v];
      } else return;
      const nextToken = randomUUID().slice(0, 18);
      const contents = card(s, p, d, nextToken);
      s.put(dk, { d, token: nextToken });
      if (cb)
        await send(actor)("editMessageText", {
          message_id: m.message_id,
          ...contents,
        });
      else await send(actor)("sendMessage", contents);
      return;
    }
  }
  const execute = async (
    t: Ticket,
    token: string,
    approver?: number,
    selected = [1],
  ) => {
    const current = read(),
      group = saved(s, current, t.chat),
      rules = group.rules,
      scope =
        t.destination &&
        personalScope(
          s,
          current,
          t.sender,
          t.chat,
          t.topic,
          t.destination,
          t.personalSources,
        ),
      op = t.destination
        ? scope?.operations.find((o) => o.id === t.operation)
        : opFor(current, rules, t.operation);
    if (
      hash(current) !== t.profileHash ||
      group.version !== t.version ||
      !op ||
      (!scope && !rules.topics.includes(String(t.topic))) ||
      op.id !== t.operation ||
      (!t.destination && !rules.members.includes(String(t.sender))) ||
      ((t.destination
        ? !isDirect(t, op)
        : t.items || op.approval || rules.requireApproval.includes(op.id)) &&
        (!approver ||
          !current.approvers.includes(approver) ||
          (t.destination
            ? approver !== t.sender
            : !rules.approvers.includes(String(approver)))))
    )
      return;
    const k = ticketKey(current, token);
    if (s.get<Ticket>(k)?.state !== "pending") return;
    const choice = {
      actor: approver ?? t.sender,
      taskId: t.taskId,
      revision: t.revision,
      draftHash: t.draftHash,
      selected,
    };
    s.put(k, { ...t, state: "started", actor: choice.actor, selected }); // Ambiguous external writes must never replay automatically.
    const completion = await call(op.socket, {
      kind: "execute",
      idempotencyKey: token,
      operation: op.id,
      resource: op.resource,
      connection: op.connection,
      ...(t.items
        ? {
            choice,
            items: t.items,
            selectedItems: selected.map((n) => t.items![n - 1]),
          }
        : { input: t.input }),
      actor: approver ?? t.sender,
      ...(t.destination
        ? { principal: t.sender, destination: t.destination, scope: "personal" }
        : {}),
      chat: t.chat,
      topic: t.topic,
    });
    let resultText = "Действие выполнено.";
    if (t.items) {
      const verified = z
        .object({
          actor: user,
          taskId: z.string().uuid(),
          revision: z.number(),
          draftHash: z.string(),
        })
        .parse(completion);
      if (
        !op.resultHost ||
        verified.actor !== choice.actor ||
        verified.taskId !== choice.taskId ||
        verified.revision !== choice.revision ||
        verified.draftHash !== choice.draftHash
      )
        throw Error("unexpected_completion");
      resultText = verifiedCompletionLinks(completion, selected, op.resultHost);
    }
    s.put(k, {
      ...t,
      state: "done",
      actor: choice.actor,
      selected,
      resultText,
    });
    if (
      hash(read()) === t.profileHash &&
      generation(s, current, t.chat) === t.version &&
      (!t.destination ||
        personalScope(
          s,
          read(),
          t.sender,
          t.chat,
          t.topic,
          t.destination,
          t.personalSources,
        ))
    )
      await sendText(
        t.destination === "dm" ? t.sender : t.chat,
        resultText,
        t.destination === "dm"
          ? {}
          : {
              message_thread_id: t.topic || undefined,
              reply_parameters: { message_id: t.message },
            },
      );
  };
  if (
    !cb &&
    privateChat &&
    m.reply_to_message?.from?.id === p.botId &&
    m.reply_to_message?.chat?.id === actor &&
    !m.forward_origin &&
    !m.via_bot &&
    !m.is_automatic_forward &&
    typeof m.text === "string"
  ) {
    const token = s.get<string>(
      `employee:${p.botId}:selection:${actor}:${m.reply_to_message.message_id}`,
    );
    const t = token && s.get<Ticket>(ticketKey(p, token));
    if (token && t && t.items && t.state === "pending") {
      const selected = selectedItems(m.text, t.items.length);
      if (selected) await execute(t, token, actor, selected);
      else
        await sendText(
          actor,
          "Ответьте номерами или словами на исходный список.",
        );
    }
    if (token) return;
  }
  if (cb) {
    if (privateChat && /^ea:[a-f0-9]{32}$/.test(cb.data ?? "")) {
      const token = cb.data.slice(3),
        t = s.get<Ticket>(ticketKey(p, token));
      if (t?.state === "pending" && !t.items) await execute(t, token, actor);
    }
    return;
  }
  if (
    (privateChat
      ? !p.personalAccess?.subjects.includes(actor)
      : !["supergroup", "group"].includes(m.chat.type) ||
        !s.get(directory + chat)) ||
    m.forward_origin ||
    m.via_bot ||
    m.is_automatic_forward
  )
    return;
  const event = m.forum_topic_created
    ? "topic_created"
    : m.new_chat_members?.length
      ? "member_joined"
      : undefined;
  if (typeof m.text !== "string" && !event) return;
  const group = saved(s, p, chat),
    r = applicable(
      group.rules,
      options(p, s.get<number[]>(topicsKey(p, chat)) ?? []),
    ),
    topic = m.message_thread_id ?? 0;
  if (!privateChat && !r.topics.includes(String(topic))) return;
  const mentioned =
    typeof m.text === "string" &&
    m.entities?.some(
      (e: any) =>
        e.type === "mention" &&
        m.text.slice(e.offset, e.offset + e.length).toLowerCase() ===
          "@" + p.username.toLowerCase(),
    );
  const reply = m.reply_to_message;
  const addressed =
    (r.triggers.includes("mention") && mentioned) ||
    (r.triggers.includes("reply") &&
      reply?.from?.id === p.botId &&
      reply.chat?.id === chat &&
      (reply.message_thread_id ?? 0) === topic);

  const requested = privateChat
    ? "dm"
    : mentioned && !event
      ? directDestination(m)
      : undefined;
  const hasPersonal =
    p.personalAccess?.subjects.includes(actor) ||
    p.personalGrants.some((g) => g.subject === actor);
  if (requested === "dm" && !hasPersonal) return;
  const destination = hasPersonal && requested ? requested : undefined;
  const personal =
    destination && personalScope(s, p, actor, chat, topic, destination);
  if (destination && !personal) return;
  if (!personal && !addressed && !(event && r.events.includes(event))) return;
  if (!personal && !r.members.includes(String(actor))) return;
  const permitted = (
    personal
      ? personal.operations
      : p.operations.filter((o) => opFor(p, r, o.id))
  ).map((o) => ({ id: o.id, resource: o.resource }));
  const decision = response.parse(
    await call(personal ? personal.conversationSocket : p.conversationSocket, {
      kind: "conversation",
      role: p.role,
      chat,
      topic,
      actor,
      text: m.text ?? "",
      event,
      ...(personal ? { principal: actor, destination, scope: "personal" } : {}),
      sources: personal ? personal.sources : r.sources,
      operations: permitted,
    }),
  );
  if (decision.kind === "direct" && !personal) return;
  const result =
    decision.kind === "direct"
      ? { ...decision, kind: "selection" as const, items: [decision.item] }
      : decision;
  if (hash(read()) !== hash(p) || generation(s, p, chat) !== group.version)
    return;
  if (
    destination &&
    personal &&
    !personalScope(s, read(), actor, chat, topic, destination, personal.sources)
  )
    return;
  if (result.kind === "answer") {
    await sendText(
      destination === "dm" ? actor : chat,
      result.text,
      destination === "dm"
        ? {}
        : {
            message_thread_id: topic || undefined,
            reply_parameters: { message_id: m.message_id },
          },
    );
    return;
  }
  if (personal && result.kind !== "selection") return;
  const op = personal
    ? personal.operations.find((o) => o.id === result.operation)
    : opFor(p, r, result.operation);
  if (!op || (result.kind === "selection" && !op.resultHost)) return;
  const direct = decision.kind === "direct" && !op.approval;
  if (personal && !direct && !p.approvers.includes(actor)) return;
  const token = createHash("sha256")
    .update([p.botId, chat, topic, m.message_id].join(":"))
    .digest("hex")
    .slice(0, 32);
  if (s.get(ticketKey(p, token))) return;
  const t: Ticket = {
    chat,
    topic,
    message: m.message_id,
    sender: actor,
    destination,
    direct: direct || undefined,
    personalSources: personal ? personal.sources : undefined,
    version: group.version,
    profileHash: hash(p),
    operation: op.id,
    taskId: randomUUID(),
    revision: result.kind === "selection" ? result.revision : 1,
    draftHash: createHash("sha256")
      .update(
        JSON.stringify(
          result.kind === "selection" ? result.items : [result.input],
        ),
      )
      .digest("hex"),
    items: result.kind === "selection" ? result.items : undefined,
    input: result.kind === "selection" ? "" : result.input,
    state: "pending",
  };
  s.put(ticketKey(p, token), t);
  if (direct) {
    await execute(t, token);
    return;
  }
  if (t.items) {
    const text = [
      `Группа ${chat}, тема ${topic} · ${op.id} / ${op.resource}`,
      ...(destination
        ? [
            "Получатель результата: " +
              (destination === "dm" ? "ваша личка" : "эта группа и тема"),
          ]
        : []),
      `Поручение: ${t.taskId} (версия ${t.revision})`,
      ...t.items.map((item, i) => `${i + 1}. ${item}`),
      "Ответьте на это сообщение, например «первый и третий».",
    ].join("\n");
    for (const actor of destination ? [t.sender] : r.approvers) {
      const delivered = await sendText(Number(actor), text, {
        reply_markup: { force_reply: true },
      });
      if (
        !Number.isSafeInteger(delivered?.message_id) ||
        delivered.message_id <= 0
      )
        throw Error("proposal_delivery_unknown");
      s.put(
        `employee:${p.botId}:selection:${actor}:${delivered.message_id}`,
        token,
      );
    }
    return;
  }
  if (!op.approval && !r.requireApproval.includes(op.id)) {
    await execute(t, token);
    return;
  }
  for (const target of r.approvers)
    await sendText(
      Number(target),
      `Группа ${chat}, тема ${topic}\n${op.id} / ${op.resource}\n${t.input}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Подтвердить", callback_data: "ea:" + token }],
          ],
        },
      },
    );
}

function isDirect(
  ticket: Ticket,
  operation: { approval: boolean } | undefined,
) {
  return (
    !!ticket.destination &&
    ticket.direct === true &&
    ticket.items?.length === 1 &&
    operation?.approval === false
  );
}

// Read-only recheck for a trusted adapter just before each delayed external write.
export const employeeWriteCheck = z
  .object({
    idempotencyKey: z.string().regex(/^[a-f0-9]{32}$/),
    actor: user,
    taskId: z.string().uuid(),
    revision: z.number().int().positive(),
    draftHash: z.string().regex(/^[a-f0-9]{64}$/),
    selected: z.array(z.number().int().positive().max(10)).min(1).max(10),
    item: z.number().int().positive().max(10),
    operation: id,
    resource: id,
    connection: id,
  })
  .strict();
export function employeeWriteAllowed(
  s: Store,
  p: Profile,
  check: z.infer<typeof employeeWriteCheck>,
) {
  const current = effective(s, p),
    t = s.get<Ticket>(ticketKey(p, check.idempotencyKey));
  if (
    !t?.items ||
    t.state !== "started" ||
    t.profileHash !== hash(current) ||
    t.actor !== check.actor ||
    t.taskId !== check.taskId ||
    t.draftHash !== check.draftHash ||
    t.revision !== check.revision ||
    t.operation !== check.operation ||
    !check.selected.includes(check.item) ||
    JSON.stringify(t.selected) !== JSON.stringify(check.selected)
  )
    return false;
  const group = saved(s, p, t.chat),
    scope =
      t.destination &&
      personalScope(
        s,
        current,
        t.sender,
        t.chat,
        t.topic,
        t.destination,
        t.personalSources,
      ),
    op = t.destination
      ? scope?.operations.find((o) => o.id === t.operation)
      : opFor(current, group.rules, t.operation);
  return (
    group.version === t.version &&
    (t.destination
      ? t.sender === check.actor
      : group.rules.approvers.includes(String(check.actor))) &&
    (isDirect(t, op) || current.approvers.includes(check.actor)) &&
    (t.destination
      ? !!scope
      : group.rules.members.includes(String(t.sender))) &&
    (!!scope || group.rules.topics.includes(String(t.topic))) &&
    op?.resource === check.resource &&
    op.connection === check.connection
  );
}
