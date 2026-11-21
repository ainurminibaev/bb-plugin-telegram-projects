import {sharedGroupThreads,sharedGroupThreadKey,sharedOwnerForum} from "./group-binding";
import {maxImageBytes} from "./group-attachments";
import { ownerPrivateTopicInput, ownerTopicInput, ownerTopicTool } from "./owner-topic";
import { privacyKey, privacySummary, rememberMembership, sendVisibilityUpdates } from "./group-visibility";
import {reconcileEmployeeTicket,employeeHome,employeeUpdate,isEmployeeUpdate,readEmployeeProfile,employeeWriteAllowed,employeeWriteCheck} from "./employee-policy";
import {proposalInput,presentProposal,handleOwnerSelection,collectDecisionResults,presentProjectProposals} from "./owner-selection";
import {groupFollowUpInput,bbReminderInput,isDirectOwnerRequest,resolveGroupMessage,inspectGroupTask,deliverGroupResults,groupResultInput,groupResultStatus,queueGroupResult,groupReminderInput,queueGroupReminder} from "./group-result";
import {groupExecutor} from "./isolated-client";
import {isolatedGroupInput,isolatedGroupResult,submitIsolatedGroup,isolatedLookup,isolatedAnswer,readIsolatedGroup,isolatedPdfInput,isolatedPdfPart,readIsolatedPdf,isolatedImageInput,isolatedImagePart,readIsolatedImage} from "./isolated-group";
import {cleanInbox} from "./inbox-retention";
import {openTopicSearch,historyPrefix,topicPassages} from "./topic-search";
import { transcribeWithVoiceRouter } from "./voice-router";
import { saveLocalTelegramFile, telegramApiRoot as checkedApiRoot } from "./telegram-files";
import { agencyIntegration, agencyDeliverySchema, agencyCapabilitySchema, agencyReceiptSchema } from "./agency-integration";
import { translate } from "./locale";
import {
  preferencesSchema,
  diagnosisSchema,
  diagnose,
} from "./settings";
import {channelPost,channelPostSchema,inspectChannelRights} from "./channel-post";
import { bindGroupTopic, groupCliRestricted, groupTyping, processGroupInputs } from "./group-worker";
import { ChatBridge } from "./chat";
import { handoffDispatch } from "./handoff";
import { StateTransfer } from "./state-transfer";
import { acceptGroupUpdate, contextMediaPrefix, routeUpdate, skipExcludedForumUpdate, type GroupTopicPolicy } from "./ingress";
import { accessList, accessModeKey, installKindKey, groupSettings, hasAccess, migrateLegacyRights, saveGroupSettings, setAccess } from "./rights";
import { handleConsentCallback, watchConsents } from "./consent";
import { handleSetupUpdate, notifyGroupsAdded, welcomeScreen } from "./setup-screens";
import { menuCommands } from "./commands";
import {
  classifyThread,
  eventKind,
  eventsSchema,
  formatThreadCard,
  formatThreadRich,
  summaryPrompt,
  safeTimeZone,
  readEvents,
  route,
  sectionFor,
  taskKindsOn,
  type Events,
} from "./events";
import { makeChatControlPublisher, writeJsonAtomic } from "./json-file";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  watch,
  mkdirSync,
  existsSync,
} from "node:fs";
import {
  telegram,
  transcribeTelegramVoice, downloadGroupImage,
  checkBot,
  runBb,
  readEnvToken,
  trackersSchema,
  readTasks,
} from "./adapters";
import {
  ensureTopic,
  reconcileProjects,
  ingest,
  escapeHtml,
  formatEvent,
  TelegramFailure,
  type Store,
  type Topic,
  type Event,
  type Task,
  type Tracker,
} from "./model";
const statusSchema = z.object({
  chatEnabled: z.boolean(),
  chatBindings: z.array(
    z.object({
      topicId: z.number(),
      projectId: z.string(),
      threadId: z.string().nullable(),
      ready: z.boolean(),
    }),
  ),
  chatQueue: z.number(),
  chatError: z.string().nullable(),
  enabled: z.boolean(),
  bot: z.string(),
  topicsEnabled: z.boolean(),
  lastSync: z.string().nullable(),
  error: z.string().nullable(),
  queue: z.number(),
  ingressError: z.string().nullable(),
  owner: z.number().nullable(),
  menu: z.array(z.object({ command: z.string(), description: z.string() })),
  topics: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      threadId: z.number().nullable(),
      creating: z.boolean(),
    }),
  ),
  tasks: z.number(),
});
const handoffStatusSchema = z.object({id: z.string(), phase: z.string(), sourceThreadId: z.string(), targetThreadId: z.string().nullable(), error: z.string().nullable(), retirement: z.string().nullable(), retirementReason: z.string().nullable()});
const personSchema = z.object({ id: z.number().int().positive().safe(), name: z.string().max(64) });
const groupRightsSchema = z.object({
  version: z.number(), who: z.enum(["access", "all"]), reply: z.enum(["mention", "auto"]),
  members: z.enum(["silent", "read", "propose"]), zones: z.array(z.string().max(64)).max(50), note: z.string().max(500),
});
export const rpcContract = defineRpcContract({
  rightsAccess: { input: z.null(), output: z.array(personSchema) },
  rightsAccessSet: { input: z.object({ people: z.array(personSchema).max(200) }).strict(), output: z.array(personSchema) },
  rightsGroup: { input: z.object({ chatId: z.number().int() }).strict(), output: groupRightsSchema.nullable() },
  rightsGroupSet: {
    input: z.object({ chatId: z.number().int(), who: z.enum(["access", "all"]).optional(), reply: z.enum(["mention", "auto"]).optional(),
      members: z.enum(["silent", "read", "propose"]).optional(), zones: z.array(z.string().max(64)).max(50).optional(),
      note: z.string().max(500).optional() }).strict(),
    output: groupRightsSchema,
  },
  reconcileEmployeeTicket:{input:z.object({idempotencyKey:z.string().regex(/^[a-f0-9]{32}$/)}).strict(),output:z.object({state:z.string(),messageId:z.number().optional()})},
  checkEmployeeWrite:{input:employeeWriteCheck,output:z.object({allowed:z.boolean()})},
  readIsolatedPdf:{input:isolatedPdfInput,output:isolatedPdfPart},
  readIsolatedImage:{input:isolatedImageInput,output:isolatedImagePart},
  readIsolatedGroup:{input:isolatedLookup,output:isolatedAnswer},
  submitIsolatedGroup:{input:isolatedGroupInput,output:isolatedGroupResult},
  inspectChannelRights:{input:z.object({channelId:z.number().int().negative()}).strict(),
    output:z.object({publish:z.boolean(),editOthers:z.boolean(),deleteOthers:z.boolean()})},
  scheduleGroupReminder:{input:groupReminderInput,output:groupResultStatus},
  presentOwnerProposal:{input:proposalInput,output:z.object({messageId:z.number(),draftHash:z.string()})},
  resolveOwnerGroupMessage:{input:groupResultInput.pick({threadId:true,routeToken:true}).extend({link:z.string().max(180)}),
    output:z.object({taskId:z.string().uuid(),projectId:z.string()})},
  inspectGroupTask:{input:groupResultInput.omit({text:true}),output:z.object({
    binding:z.enum(["active","revoked"]),delivery:z.union([groupResultStatus.shape.state,z.literal("unsubmitted")]).optional(),
    messageId:z.number().optional(),
  })},
  returnGroupResult:{input:groupResultInput,output:groupResultStatus},
  channelPost:{input:channelPostSchema,output:z.object({messageId:z.number().int().positive()})},
  bindGroupTopic: {
    input: z.object({confirm:z.literal(true),chatId:z.number().int().negative(),topicId:z.number().int().nonnegative(),
      threadId:z.string().min(1),ownerOnly:z.boolean(),requireMention:z.boolean(),
      ownerSharedProject:z.literal(true).optional(),
      addressName:z.string().trim().min(3).max(40).regex(/^[\p{L}][\p{L}\p{M} -]*[\p{L}\p{M}]$/u).optional(),
      deliverySources:z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(100).optional(),
      allowedSenderIds:z.array(z.number().int().positive().safe()).max(100).optional(),includeTopicContext:z.boolean().optional(),searchableHistory:z.boolean().optional(),retainFullHistory:z.boolean().optional()}).strict(),
    output:z.object({bound:z.literal(true),warning:z.string().optional()}),
  },
  unbindGroupTopic: {
    input:z.object({confirm:z.literal(true),chatId:z.number().int().negative(),topicId:z.number().int().nonnegative()}).strict(),
    output:z.object({removed:z.boolean()}),
  },
  providerHandoffStatus: {
    input: z.object({topicId: z.number().int().nonnegative()}).strict(), output: handoffStatusSchema.nullable(),
  },
  startProviderHandoff: {
    input: z.object({confirm: z.literal(true), topicId: z.number().int().nonnegative(), sourceThreadId: z.string().min(1),
      providerId: z.string().min(1), model: z.string().min(1)}).strict(), output: handoffStatusSchema,
  },
  cancelProviderHandoff: {
    input: z.object({confirm: z.literal(true), topicId: z.number().int().nonnegative(), id: z.string().uuid()}).strict(), output: handoffStatusSchema,
  },
  exportPrivateState: {
    input: z.object({confirm: z.literal(true), targetVersion: z.literal("personal.15").optional()}).strict(),
    output: z.object({id: z.string(), sha256: z.string(), rows: z.number()}),
  },
  restorePrivateState: {
    input: z.object({confirm: z.literal(true), id:z.string().uuid(), sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
    output: z.object({restored: z.literal(true), rows:z.number(), sha256:z.string()}),
  },
  replacePrivateState: {
    input: z.object({confirm: z.literal(true), id:z.string().uuid(),
      sha256:z.string().regex(/^[a-f0-9]{64}$/),
      expectedCurrentSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
    output: z.object({replaced:z.literal(true), rows:z.number(), sha256:z.string(),
      rollback:z.object({id:z.string(),sha256:z.string(),rows:z.number()})}),
  },
  agencyCapabilities: {input:z.null(),output:agencyCapabilitySchema},
  agencyConfigure: {input:z.object({enabled:z.boolean()}).strict(),output:z.object({saved:z.literal(true)})},
  agencyEnqueue: {input:agencyDeliverySchema,output:agencyReceiptSchema},
  agencyDeliveryStatus: {input:z.object({deliveryId:z.string().min(1).max(160)}).strict(),output:agencyReceiptSchema},
  preferences: {
    input: z.null(),
    output: preferencesSchema.extend({
      tokenPresent: z.boolean(),
      tokenSource: z.enum(["manual", "env", "none"]),
      tokenEnv: z.string(),
    }),
  },
  savePreferences: { input: preferencesSchema, output: z.boolean() },
  checkConnection: {
    input: z.object({ token: z.string().max(200).optional() }),
    output: diagnosisSchema,
  },
  saveToken: {
    input: z.object({ token: z.string().max(200) }),
    output: diagnosisSchema,
  },
  telegramDeliveryStatus: {
    input: z.object({deliveryId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/)}),
    output: z.object({state: z.string(), messageId: z.number().nullable(),
      files: z.array(z.object({name: z.string(), state: z.enum(["delivered", "failed", "uncertain"])}))}),
  },
  sendDelegated: {
    input:z.object({parentThreadId:z.string().min(1),routeToken:z.string().uuid(),threadId:z.string().min(1),
      text:z.string().min(1).max(100000),deliveryId:z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/)}).strict(),
    output:z.object({accepted:z.literal(true)}),
  },
  spawnDelegated: {
    input:z.object({parentThreadId:z.string().min(1),routeToken:z.string().uuid(),projectId:z.string().min(1),
      environmentId:z.string().min(1).optional(),projectSource:z.object({hostId:z.string().min(1),path:z.string().min(1)}).strict().optional(),
      text:z.string().min(1).max(100000),title:z.string().min(1).max(200),
      deliveryId:z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),providerId:z.string().min(1).optional(),model:z.string().min(1).optional()}).strict(),
    output:z.object({threadId:z.string()}),
  },
  sendToTelegram: {
    input: z.object({threadId: z.string().min(1), topicId: z.number().int().nonnegative(),
      text: z.string().max(16000).optional(), files: z.array(z.string().min(2).max(4096)).max(20).optional(),
      deliveryId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/), explicit: z.literal(true)})
      .refine(x => Boolean(x.text?.trim()) || Boolean(x.files?.length), "text_or_files_required"),
    output: z.object({queued: z.boolean(), deliveryId: z.string()}),
  },
  prepareLocalApi: {
    input: z.object({ expectedUsername: z.string().min(3).max(64), confirm: z.literal(true) }),
    output: z.object({ loggedOut: z.boolean(), botId: z.number() }),
  },
  useEnvToken: { input: z.null(), output: z.boolean() },
  summaryDefaults: {
    input: z.null(),
    output: z.object({
      providerId: z.string(),
      model: z.string(),
      reasoningLevel: z.string(),
    }),
  },
  syncMenu: { input: z.null(), output: statusSchema },
  eventsGet: {
    input: z.null(),
    output: z.object({
      events: eventsSchema,
      projects: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          hidden: z.boolean(),
          topicId: z.number().nullable(),
        }),
      ),
    }),
  },
  eventsSave: { input: eventsSchema, output: z.boolean() },
  initTopics: { input: z.null(), output: statusSchema },
  pairing: {
    input: z.null(),
    output: z.object({
      owner: z.number().nullable(),
      code: z.string().nullable(),
      link: z.string().nullable(),
    }),
  },
  unpair: { input: z.null(), output: z.boolean() },
  status: { input: z.null(), output: statusSchema },
  sync: { input: z.null(), output: statusSchema },
});
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    isolatedGroupProject:{type:"string",label:"Проект отдельного группового исполнителя",default:""},
    isolatedFileHost:{type:"string",label:"Машина с рабочими файлами группового исполнителя",default:""},
    agencyEnabled: {type:"boolean",label:"Уведомления из Агентства",default:false},
    employeeRole: {
      type: "string",
      label: "Одна строка о роли сотрудника для приветствия (пусто — личный помощник)",
      default: "",
    },
    knowledgeZones: {
      type: "string",
      label: "Темы, которые можно отмечать для групп (по одной в строке)",
      default: "",
    },
    installKind: {
      type: "select",
      label: "Кто это: личный помощник или цифровой сотрудник",
      options: ["assistant", "employee"],
      default: "assistant",
    },
    accessPermissionMode: {
      type: "select",
      label: "Режим хода для тех, кто может поручать (в группах)",
      options: ["auto", "full"],
      default: "auto",
    },
    consentMinutes: {
      type: "number",
      label: "Сколько минут ждать согласия на действие участника без доступа",
      default: 30,
    },
    language: {
      type: "select",
      label: "Language / Язык",
      options: ["ru", "en"],
      default: "ru",
    },
    enabled: {
      type: "boolean",
      label: "Синхронизация с Telegram",
      default: false,
    },
    chatEnabled: {
      type: "boolean",
      label: "Общение с BB из Telegram",
      default: false,
    },
    richReplies: {
      type: "boolean",
      label: "Rich Messages для ответов BB",
      default: true,
    },
    botToken: {
      type: "string",
      label: "Токен бота, заданный вручную",
      secret: true,
    },
    tokenEnv: {
      type: "string",
      label: "Имя токена бота в Env Catalog",
      default: "TELEGRAM_BOT_TOKEN",
    },
    companionDir: {
      type: "string",
      label:
        "Companion folder on the server (optional) / Папка компаньона на сервере (необязательно)",
      default: "",
    },
    smsTopic: {
      type: "boolean",
      label: "SMS topic for a companion service / Тема SMS для компаньона",
      default: false,
    },
    timeZone: {
      type: "string",
      label: "Time zone, e.g. Europe/Madrid (empty: server) / Часовой пояс",
      default: "",
    },
    managedChannels:{type:"string",label:"Managed channels (bot ID:owner ID:channel ID, comma separated)",default:""},
    telegramApiRoot: {
      type: "string", label: "Telegram Bot API URL", default: "https://api.telegram.org",
    },
    telegramLocalRoot: {
      type: "string", label: "Local Bot API data directory", default: "",
    },
    telegramInboxRoot: {
      type: "string", label: "Private received-file directory", default: "",
    },
    voiceRouterPath: {
      type: "string", label: "Local voice router executable (empty: BB transcription)", default: "",
    },
    telegramFileHostId: {
      type: "string", label: "BB machine holding received files", default: "",
    },
    cliPath: {
      type: "string",
      label: "BB CLI на сервере",
      default: process.env.BB_CLI || "bb",
    },
    appUrl: {
      type: "string",
      label: "Публичный адрес BB",
      default: bb.server.experimental_appUrl || "https://vechkasov.getbb.app",
    },
    reportMode: {
      type: "select",
      label: "Что присылать в отчёте агента: полный ответ или саммери",
      options: ["full", "summary"],
      default: "full",
    },
    summaryProvider: {
      type: "string",
      label: "Провайдер для саммери (пусто — по умолчанию BB)",
      default: "",
    },
    summaryModel: {
      type: "string",
      label: "Модель для саммери (пусто — по умолчанию провайдера)",
      default: "",
    },
    summaryReasoning: {
      type: "string",
      label: "Уровень рассуждения для саммери",
      default: "",
    },
    summaryServiceTier: {
      type: "string",
      label: "Тариф для саммери (fast или default)",
      default: "",
    },
    hideWithFolders: {
      type: "boolean",
      label: "Скрывать темы проектов, скрытых в Project Folders",
      default: true,
    },
    deleteTopics: {
      type: "boolean",
      label: "Удалять тему и её историю при удалении проекта BB",
      default: true,
    },
    notifyTasks: { type: "boolean", label: "Уведомления Tasks", default: true },
    notifyWorkerErrors: {
      type: "boolean",
      label: "Ошибки исполнителей, прикреплённых в Tasks",
      default: true,
    },
    soundOnReview: {
      type: "boolean",
      label: "Звук при проверке и ошибках",
      default: true,
    },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  ]);
  let history:ReturnType<typeof openTopicSearch>|undefined;
  try { history=openTopicSearch(db); } catch(error) {
    if (!String(error).includes("no such module: fts5")) throw error;
  }
  const forgetExamples=db.prepare("DELETE FROM state WHERE (key GLOB 'group:recent-files:*' OR key GLOB 'group:context-media:*') AND json_extract(value,'$.expiresAt')<=?");
  const purgeHistory=()=>{history?.prune();forgetExamples.run(Date.now());};
  purgeHistory();
  const historyTimer=setInterval(purgeHistory,3600_000);
  const store: Store = {
    findTopicHistory:history?.find,
    get<T>(key: string) {
      const r = db.prepare("SELECT value FROM state WHERE key=?").get(key) as
        { value: string } | undefined;
      return r ? (JSON.parse(r.value) as T) : undefined;
    },
    put(key, value) {
      db.prepare(
        "INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(key, JSON.stringify(value));
    },
    del(key) {
      db.prepare("DELETE FROM state WHERE key=?").run(key);
    },
    list<T>(prefix: string) {
      // GLOB uses the binary primary-key index for literal prefixes. Escape
      // pattern characters because callers supply an exact prefix, not a glob.
      const pattern = prefix.replace(/[[*?]/g, c => "[" + c + "]") + "*";
      return (
        db.prepare("SELECT key,value FROM state WHERE key GLOB ? ORDER BY key")
          .all(pattern) as { key: string; value: string }[]
      ).map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
    },
    atomic(fn) {
      db.transaction(fn)();
    },
  };
  const lifetime = new AbortController();
  let bridge: ChatBridge | undefined;
  bb.experimental_hooks.on("message.dispatch", ctx =>
    handoffDispatch(store, ctx) ?? bridge?.admitDispatch(ctx) ?? {action: "proceed"});
  let flight: Promise<void> | null = null;
  let lastError: string | null = null;
  let topicsEnabled = false;
  let username = "";
  let lastSync: string | null = null;
  let wake: (() => void) | undefined;
  let ingressError: string | null = null;
  let ingressPolling = false;
  let activeTasks: { task: Task; tracker: Tracker }[] = [];
  let envToken = { name: "", value: "", at: 0 };
  // A manually saved token wins; otherwise the shared Env Catalog entry, re-read every 5 minutes.
  async function tokenSource(): Promise<"manual" | "env" | "none"> {
    const c = await settings.get();
    if (c.botToken?.trim()) return "manual";
    if (envToken.name !== c.tokenEnv || Date.now() - envToken.at > 300_000)
      envToken = {
        name: c.tokenEnv,
        value: await readEnvToken(
          c.cliPath,
          bb.server.loopbackBaseUrl,
          c.tokenEnv,
          lifetime.signal,
        ),
        at: Date.now(),
      };
    return envToken.value ? "env" : "none";
  }
  // Owner and bot are learned at runtime: pairing sets the owner, the first getMe the bot.
  const ownerId = () => store.get<number>("owner:id");
  const botId = () => store.get<number>("bot:id");
  // The former catalog of operations and adapters runs only when explicitly re-enabled.
  const legacyOperations = process.env.BB_TELEGRAM_LEGACY_OPERATIONS === "1";
  const profilePeople = () => {
    const path = process.env.BB_TELEGRAM_EMPLOYEE_PROFILE;
    if (!path) return [];
    try {
      const p = readEmployeeProfile(path);
      return p.botId === botId() && p.owner === ownerId() ? [...p.admins, ...p.members] : [];
    } catch { return []; }
  };
  let consentTtlMs = 30 * 60_000;
  const setupContext = async (signal: AbortSignal) => {
    const cfg = await settings.get();
    return {
      store, sdk: bb.sdk, bot: botId()!, owner: ownerId()!, botUsername: username || store.get<string>("bot:username") || "",
      tg: (chat: number) => telegram(botToken, signal, 15_000, () => chat, apiRoot),
      zones: String(cfg.knowledgeZones ?? "").split(/\n|,/).map((z: string) => z.trim()).filter(Boolean).slice(0, 30),
      role: String(cfg.employeeRole ?? "").trim().slice(0, 300),
    };
  };
  const consentContext = (signal: AbortSignal) => ({
    store, sdk: bb.sdk, bot: botId()!, owner: ownerId()!, ttlMs: consentTtlMs, signal,
    tg: (chat: number) => telegram(botToken, signal, 15_000, () => chat, apiRoot),
  });
  let stateTransferBusy = false;
  let activeTelegramWrites = 0;
  function pairCode() {
    let code = store.get<string>("pair:code");
    if (!code) {
      code = String(randomInt(100000, 1000000));
      store.put("pair:code", code);
    }
    return code;
  }
  let chatWake: (() => void) | undefined;
  bb.agents.registerTool({
    name:"telegram_group_reminder",
    description:"Schedule one conditional reminder for an existing Telegram group task from the owner's direct BB conversation.",
    parameters:bbReminderInput,
    async execute(args,{threadId,projectId,signal}) {
      const owner=ownerId(),bot=botId();
      const binding=()=>store.get<{threadId:string;projectId:string;revision:string}>("chat:binding:0");
      const before=binding();
      if (!owner || !bot || !before?.revision || before.threadId!==threadId || before.projectId!==projectId)
        throw Error("owner_coordinator_required");
      const cfg=await settings.get();
      const [request]=await bb.sdk.threads.events.list({threadId,order:"desc",limit:"1",types:["client/turn/requested"],signal});
      if (request?.type!=="client/turn/requested" || !isDirectOwnerRequest(request.data))
        throw Error("direct_bb_owner_request_required");
      if (signal.aborted || !bridge || stateTransferBusy || !cfg.enabled || !cfg.chatEnabled ||
          ownerId()!==owner || botId()!==bot || binding()?.revision!==before.revision)
        throw Error("bot_unavailable");
      const receipt=queueGroupReminder(store,owner,bot,args);
      chatWake?.();
      return JSON.stringify(receipt);
    },
  });
  // The owner can ask the employee right in the group: "on Friday check X and report here".
  // Only the bound group thread may schedule, only for the task of the owner's current request.
  bb.agents.registerTool({
    name:"telegram_group_followup",
    description:"Schedule one follow-up turn of this employee for the current Telegram group task. At dueAt the employee itself re-reads the topic and its tools and answers under the original message, or stays silent with NO_REPLY. Use only when the owner asked for a later check in this group request.",
    parameters:groupFollowUpInput,
    async execute(args,{threadId}) {
      const owner=ownerId(),bot=botId();
      if (!owner || !bot || !bridge || stateTransferBusy) throw Error("bot_unavailable");
      const policyKey=store.get<string>("group:thread:"+threadId);
      const origin=store.get<{threadId:string;sender:number;owner:number;bot:number}>("group:origin:"+args.taskId);
      if (!policyKey || !origin || origin.threadId!==threadId || origin.owner!==owner || origin.bot!==bot || !hasAccess(store,bot,owner,origin.sender))
        throw Error("owner_group_request_required");
      const active=store.list<{taskId?:string;state:string;ownerId:number;route:{threadId:string;senderId:number}}>(`group:in:${bot}:`)
        .some(({value:j})=>j.taskId===args.taskId && j.state==="submitted" && j.ownerId===owner &&
          j.route.threadId===threadId && j.route.senderId===origin.sender);
      if (!active) throw Error("owner_group_request_required");
      if (args.dueAt<=Date.now()) throw Error("due_time_in_past");
      const receipt=queueGroupReminder(store,owner,bot,{taskId:args.taskId,dueAt:args.dueAt,waitingFor:"agent",text:args.text});
      chatWake?.();
      return JSON.stringify(receipt);
    },
  });
  const createOwnerTopic = ownerTopicTool({
    store,sdk:bb.sdk,
    async identity() {
      const owner=ownerId(), bot=botId();
      const cfg=await settings.get();
      if (!bridge || !owner || !bot || owner!==ownerId() || bot!==botId() ||
          stateTransferBusy || !cfg.enabled || !cfg.chatEnabled) throw Error("bot_unavailable");
      return {owner,bot};
    },
    transport: (chatId,signal) => telegram(botToken,AbortSignal.any([signal,lifetime.signal]),15000,()=>chatId,apiRoot),
    provePrivate:async (threadId,token,owner)=>{
      if (!bridge) throw Error("bot_unavailable");
      return bridge.proveOwnerForumRequest(threadId,token,owner);
    },
  });
  bb.agents.registerTool({
    name:"telegram_create_owner_topic",
    description:"Create a topic in the same private Telegram forum and post its first message. Use only if the paired owner explicitly requested a new topic in this current group task and gave its title. Copy the title from their request. Supply text only if the owner specified the exact first message; otherwise the bridge posts a fixed confirmation. A confirmed receipt may be repeated; do not retry an unconfirmed mutation or send the first message through another tool.",
    parameters:ownerTopicInput,
    async execute(args,ctx) {
      activeTelegramWrites++;
      try { return JSON.stringify(await createOwnerTopic(args,ctx)); }
      finally { activeTelegramWrites--; }
    },
  });
  bb.agents.registerTool({
    name:"telegram_create_private_forum_topic",
    description:"From a current direct Telegram request by the paired owner, create a topic in a configured private owner forum in this project. If several forums are available, the owner must explicitly give the exact forum name or a private forum link, and the forum argument must copy it. Use only for an explicit instruction to create a topic. Copy the exact topic title and any exact first message. Otherwise a fixed confirmation is used. Pass the current Telegram route token.",
    parameters:ownerPrivateTopicInput,
    async execute(args,ctx) {
      activeTelegramWrites++;
      try { return JSON.stringify(await createOwnerTopic(args,ctx)); }
      finally { activeTelegramWrites--; }
    },
  });
  async function events(): Promise<Events> {
    const saved = store.get("events:config");
    if (saved) return readEvents(saved);
    const seeded = readEvents(null, await settings.get());
    store.put("events:config", seeded);
    return seeded;
  }
  const folderSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    name: z.string(),
    path: z.string(),
  });
  type Folder = z.infer<typeof folderSchema>;
  // Project Folders is optional. A failed read keeps the last known state, never "nothing hidden".
  async function folderState(): Promise<{ hidden: string[]; folders: Folder[] }> {
    try {
      const [prefs, list] = await Promise.all([
        bb.sdk.plugins.callRpc({
          pluginId: "project-folders",
          method: "prefs_get",
          input: null,
          outputSchema: z.object({
            items: z.record(z.string(), z.object({ hidden: z.boolean().optional() }).passthrough()),
          }).passthrough(),
        }),
        bb.sdk.plugins.callRpc({
          pluginId: "project-folders",
          method: "list",
          input: null,
          outputSchema: z.object({ folders: z.array(folderSchema.passthrough()) }).passthrough(),
        }),
      ]);
      const state = {
        hidden: Object.entries(prefs.items)
          .filter(([, v]) => v.hidden)
          .map(([k]) => k),
        folders: list.folders.map(({ id, projectId, name, path }) => ({ id, projectId, name, path })),
      };
      store.put("folders:state", state);
      return state;
    } catch {
      return store.get("folders:state") ?? { hidden: [], folders: [] };
    }
  }
  // thread:changed accumulates here; the sync loop turns finished turns into topic reports.
  const pendingThreads = new Map<string, Set<string>>();
  async function botToken(): Promise<string> {
    const source = await tokenSource();
    if (source === "manual") return (await settings.get()).botToken!.trim();
    if (source === "env") return envToken.value;
    envToken.at = 0;
    throw new Error("bot_configuration_unavailable");
  }
  const apiRoot = async () => (await settings.get()).telegramApiRoot;
  async function receiveLocalFile(incoming:{fileId:string;name:string;size:number},updateId:number,
    threadId:string,fileSignal:AbortSignal,scope?:string[],isolated=false,maxBytes?:number) {
    const c = await settings.get();
    if (checkedApiRoot(c.telegramApiRoot) === "https://api.telegram.org" ||
        !c.telegramLocalRoot || !c.telegramInboxRoot)
      throw Error("attachment_local_api_required");
    if (!isolated) {
      const thread = await bb.sdk.threads.get({threadId});
      if (!thread.environmentId || !c.telegramFileHostId) throw Error("attachment_wrong_host");
      const env = await bb.sdk.environments.get({environmentId:thread.environmentId});
      if (env.hostId !== c.telegramFileHostId) throw Error("attachment_wrong_host");
    }
    if (incoming.size > 2 * 1024 * 1024 * 1024) throw Error("attachment_too_large");
    const tg = telegram(botToken, fileSignal, 30 * 60 * 1000, ownerId, apiRoot);
    const file = await tg("getFile", {file_id:incoming.fileId});
    if (typeof file.file_path !== "string") throw Error("attachment_file_invalid");
    return saveLocalTelegramFile({sourcePath:file.file_path,
      localRoot:c.telegramLocalRoot, inboxRoot:scope ? join(c.telegramInboxRoot,...scope) : c.telegramInboxRoot,
      threadId:isolated ? "isolated:"+threadId : threadId, updateId:updateId, fileId:incoming.fileId, name:incoming.name,
      expectedBytes:incoming.size || undefined, maxBytes, signal:fileSignal});
  }
  async function receiveGroupFile(file:import("./ingress").GroupExample,
    route:Extract<import("./ingress").Ingress,{kind:"group"}>, signal:AbortSignal,bot:number) {
    if (file.image && checkedApiRoot(await apiRoot())==="https://api.telegram.org") {
      if (file.size>maxImageBytes) throw Error("attachment_too_large");
      const getFile=telegram(botToken,signal,30_000,undefined,apiRoot);
      return downloadGroupImage(botToken,await getFile("getFile",{file_id:file.fileId}),file.size,signal);
    }
    const policy=store.get<import("./ingress").GroupTopicPolicy>(`group:policy:${route.chatId}:${route.topicId}`);
    return receiveLocalFile(file,route.updateId,route.threadId,signal,
      ["groups",String(bot),String(route.chatId),String(route.topicId),String(route.senderId)],
      policy?.isolated===true,file.image ? maxImageBytes : undefined);
  }
  let cleaning=false;
  const inboxTimer=setInterval(async()=>{
    if(cleaning || stateTransferBusy)return;
    cleaning=true;
    try {
      const cfg=await settings.get();
      if((!cfg.enabled && !cfg.isolatedGroupProject) || !cfg.telegramInboxRoot || !existsSync(cfg.telegramInboxRoot))return;
      await cleanInbox(cfg.telegramInboxRoot,async id=>{
        if (id.startsWith("isolated:")) {
          const remoteId=id.slice("isolated:".length);
          return !store.list<{route?:{threadId?:string}}>("group:in:").some(row=>row.value.route?.threadId===remoteId);
        }
        const queue=[id], seen=new Set<string>();
        while(queue.length){
          const threadId=queue.pop()!;
          if(seen.has(threadId))return false;
          seen.add(threadId);
          const t=await bb.sdk.threads.get({threadId,signal:lifetime.signal});
          if(t.status!=="idle" || t.queuedMessageCount || t.activeBackgroundAgentCount || ("hasPendingInteraction" in t && t.hasPendingInteraction))return false;
          const children=await bb.sdk.threads.list({parentThreadId:threadId,includeHidden:true,limit:100,signal:lifetime.signal});
          if(children.length===100)return false;
          queue.push(...children.map(c=>c.id));
        }
        return true;
      });
    } catch { console.warn("Telegram inbox maintenance deferred"); }
    finally {cleaning=false;}
  },3600_000);
  const localFiles = async () => {
    const c = await settings.get();
    return {localRoot:c.telegramLocalRoot, inboxRoot:c.telegramInboxRoot};
  };
  const safeError = (e: unknown) =>
    e instanceof TelegramFailure
      ? e.code
      : e instanceof Error && /^[a-z_]+(?::[a-zA-Z0-9_]+)?$/.test(e.message)
        ? e.message
        : "sync_failed";
  async function status() {
    const cfg = await settings.get();
    return {
      chatEnabled: cfg.chatEnabled,
      chatBindings: bridge?.status().bindings ?? [],
      chatQueue: bridge?.status().outgoing ?? 0,
      chatError: bridge?.status().lastError ?? null,
      enabled: cfg.enabled,
      bot: username,
      topicsEnabled,
      lastSync,
      error: lastError,
      queue: store.list("queue:").length,
      ingressError,
      owner: ownerId() ?? null,
      menu:
        store.get<{ command: string; description: string }[]>("menu:served") ??
        [],
      topics: store.list<Topic>("topic:").map((x) => ({
        key: x.value.key,
        name: x.value.name,
        threadId: x.value.threadId,
        creating: x.value.creating,
      })),
      tasks: store.list("task:").length,
    };
  }
  async function run() {
    const cfg = await settings.get();
    const tr = (s: string) => translate(cfg.language as "ru" | "en", s);
    if (!cfg.enabled || stateTransferBusy) return;
    if ((store.get<number>("retryAt") ?? 0) > Date.now()) return;
    if (!store.get("trackingSince")) store.put("trackingSince", Date.now());
    const tg = telegram(botToken, lifetime.signal, 15_000, ownerId, apiRoot);
    const me = await checkBot(tg, botId());
    if (!botId()) store.put("bot:id", me.id);
    username = me.username;
    store.put("bot:username", me.username);
    store.put(privacyKey(me.id), !me.readsAllGroups);
    if (!ownerId()) {
      lastError = "owner_not_paired";
      return;
    }
    const wanted = menuCommands(cfg.language as "ru" | "en");
    const signature = cfg.language + ":" + JSON.stringify(wanted);
    if (store.get("commandsLanguage") !== signature) {
      for (const language_code of ["", "ru", "en"])
        await tg("setMyCommands", {
          commands: wanted,
          scope: { type: "chat", chat_id: ownerId() },
          language_code,
        });
      // Read the menu back: the page shows what Telegram actually serves.
      const served = await tg<{ command: string; description: string }[]>(
        "getMyCommands",
        { scope: { type: "chat", chat_id: ownerId() } },
      );
      store.put("menu:served", served);
      if (JSON.stringify(served) === JSON.stringify(wanted))
        store.put("commandsLanguage", signature);
    }
    username = me.username;
    store.put("bot:username", me.username);
    topicsEnabled = me.topics;
    // A complete project snapshot is the only authority for removals. Failed reads never reconcile.
    const projects = (
      await bb.sdk.projects.list({ signal: lifetime.signal })
    ).filter((p) => p.kind === "standard");
    const cli = (args: string[]) =>
      runBb(cfg.cliPath, bb.server.loopbackBaseUrl, args, lifetime.signal);
    let taskFailure: string | null = null;
    const allTasks: { task: Task; tracker: Tracker }[] = [];
    const ev = await events();
    const folders = await folderState();
    const hidden = new Set(cfg.hideWithFolders ? folders.hidden : []);
    const visible = projects.filter((p) => !hidden.has("p:" + p.id));
    if (taskKindsOn(ev)) {
      try {
        const trackers = trackersSchema.parse(
          await cli(["tasks", "project", "list", "--json"]),
        ).projects;
        for (const tracker of trackers) {
          if (
            !tracker.linkedBbProjectId ||
            !projects.some((p) => p.id === tracker.linkedBbProjectId)
          )
            continue;
          const tasks = await readTasks(cli, tracker.id);
          ingest(store, tracker, tasks);
          allTasks.push(...tasks.map((task) => ({ task, tracker })));
          if (ev.worker_error.on) {
            for (const task of tasks.filter(
              (t) => !["done", "canceled"].includes(t.status),
            )) {
              const result = z
                .object({
                  taskThreads: z.array(
                    z.object({
                      threadId: z.string(),
                      liveStatus: z.string().nullable(),
                      updatedAt: z.string(),
                    }),
                  ),
                })
                .parse(await cli(["tasks", "threads", task.id, "--json"]));
              for (const worker of result.taskThreads) {
                const key = "worker:" + worker.threadId;
                const prev = store.get<{ liveStatus: string | null }>(key);
                if (
                  (prev
                    ? prev.liveStatus !== worker.liveStatus
                    : Date.parse(worker.updatedAt) >=
                      (store.get<number>("trackingSince") ?? Infinity)) &&
                  worker.liveStatus === "error"
                ) {
                  const event: Event = {
                    id: `${task.id}:${worker.threadId}:${worker.updatedAt}:error`,
                    projectId: tracker.linkedBbProjectId,
                    taskId: task.id,
                    key: task.key,
                    title: task.title,
                    tracker: tracker.name,
                    status: task.status,
                    kind: "worker_error",
                    dueDate: task.dueDate,
                    at: new Date().toISOString(),
                    urgent: true,
                  };
                  if (!store.get("sent:" + event.id))
                    store.put("queue:" + event.id, event);
                }
                store.put(key, { liveStatus: worker.liveStatus });
              }
            }
          }
        }
      } catch (e) {
        taskFailure = safeError(e);
      }
    }
    activeTasks = allTasks;
    // Topics live only in this database. An empty database must not recreate a full set
    // next to topics another installation already made: creation waits for explicit consent.
    if (!store.get("topicsBootstrapped")) {
      if (store.list("topic:").length) store.put("topicsBootstrapped", true);
      else {
        // A connected personal chat works without creating project topics.
        // Keep actual Tasks failures visible even in this mode.
        lastError = cfg.chatEnabled && (bridge?.status().bindings.length ?? 0) > 0
          ? taskFailure
          : "topics_not_initialized";
        await publishProjection(cfg.companionDir, allTasks);
        return;
      }
    }
    if (!topicsEnabled) {
      lastError = "threaded_mode_disabled";
      await publishProjection(cfg.companionDir, allTasks);
      return;
    }
    await ensureTopic(store, tg, "navigation", tr("🧭 Навигация"));
    if (cfg.smsTopic) await ensureTopic(store, tg, "sms", "📱 SMS");
    // Telegram cannot hide a topic in a private chat: hiding removes it; showing creates a new one.
    for (const b of store.list<{ topicId: number; projectId: string; folderId?: string }>("chat:binding:").map((x) => x.value)) {
      const main = store.get<Topic>("topic:" + b.projectId)?.threadId === b.topicId;
      if (main || !(hidden.has("p:" + b.projectId) || (b.folderId && hidden.has("f:" + b.folderId)))) continue;
      await tg("deleteForumTopic", { message_thread_id: b.topicId }).catch((e) => {
        if (!(e instanceof TelegramFailure && e.code === "topic_missing")) throw e;
      });
      if (bridge) bridge.forget(b.topicId);
      else store.del("chat:binding:" + b.topicId);
    }
    for (const p of projects.filter((p) => hidden.has("p:" + p.id))) {
      const topic = store.get<Topic>("topic:" + p.id);
      if (!topic || topic.creating) continue;
      if (topic.threadId)
        await tg("deleteForumTopic", { message_thread_id: topic.threadId }).catch((e) => {
          if (!(e instanceof TelegramFailure && e.code === "topic_missing")) throw e;
        });
      bridge?.forget(topic.threadId ?? -1);
      store.del("chat:binding:" + topic.threadId);
      store.del("topic:" + p.id);
    }
    await reconcileProjects(store, tg, visible, cfg.deleteTopics);
    await collectThreadEvents(ev, visible, folders.folders, hidden);
    const base = new URL(cfg.appUrl);
    if (base.protocol !== "https:")
      throw new Error("public_https_url_required");
    for (const { value: topic } of store.list<Topic>("topic:")) {
      if (!topic.threadId || topic.missingSince) continue;
      let text =
        topic.key === "navigation"
          ? tr("<b>🧭 Рабочее пространство BB</b>\n\n") +
            visible.map((p) => "📂 " + escapeHtml(p.name)).join("\n") +
            tr(
              "\n\nВ темах проектов — чаты BB, отчёты агентов и уведомления Tasks.",
            ) +
            (store.get<Topic>("topic:sms")?.threadId
              ? tr("\n📱 SMS — коды и сообщения на телефон.")
              : "") +
            tr(
              "\n\n/project — привязать новую тему\n/chats — чаты BB\n/model — агент и модель\n/tasks — активные задачи\n/menu — управление",
            )
          : topic.key === "sms"
            ? tr(
                "<b>📱 SMS</b>\n\nЗдесь будут новые сообщения на телефон и кнопки копирования кодов.",
              )
            : "<b>" +
              String(escapeHtml(topic.name)) +
              tr(
                "</b>\n\nЗдесь появляются события задач и отчёты агентов этого проекта: кто закончил работу, кто ждёт ответа, что остановилось.\n\n/menu — управление чатом BB\n/new — новая сессия\n/chats — подключиться к существующему чату\n/model — агент и модель\n/tasks — задачи проекта\n\nКакие события присылать, настраивается на странице плагина, вкладка «События».",
              );
      // The BB iPhone app claims /projects/* links; the bare origin opens only in a browser.
      const open = topic.key.startsWith("proj_")
        ? base.origin + "/projects/" + encodeURIComponent(topic.key)
        : base.origin;
      const intro = text + "\n" + open;
      if (topic.introText === intro) continue;
      const payload = {
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [[{ text: tr("Открыть BB"), url: open }]],
        },
      };
      if (topic.introId)
        await tg("editMessageText", { message_id: topic.introId, ...payload });
      else {
        const sent = await tg("sendMessage", {
          message_thread_id: topic.threadId,
          disable_notification: true,
          ...payload,
        });
        topic.introId = sent.message_id;
      }
      topic.introText = intro;
      store.put("topic:" + topic.key, topic);
    }
    await advanceSummaries(cfg.language as "ru" | "en", cfg);
    const zone = safeTimeZone(cfg.timeZone);
    let sent = 0;
    for (const { key, value: e } of store.list<Event>("queue:")) {
      if (sent >= 15) break;
      if (e.summary?.state === "pending") continue;
      const agency = e.kind.startsWith("agency_");
      const kind = eventKind(e);
      const decision =
        e.kind === "test"
          ? { send: true, sound: false }
          : agency
            ? { send: cfg.agencyEnabled, sound: e.urgent }
            : kind
              ? route(ev, kind, e.projectId)
              : { send: false, sound: false };
      // Switched-off events and hidden or removed projects are dropped, not kept in the queue.
      if (!decision.send || !visible.some((p) => p.id === e.projectId)) {
        if (!agency || !cfg.agencyEnabled) store.del(key);
        continue;
      }
      const topic = store.get<Topic>("topic:" + e.projectId);
      if (!topic?.threadId) continue;
      if (agency && e.agencyTopicId !== topic.threadId) continue;
      // Keep deliveries bound to their original topic.
      // Tasks detail route verified through the live Tasks UI.
      const common = {
        message_thread_id: topic.threadId,
        disable_notification: !decision.sound,
        link_preview_options: { is_disabled: true },
        reply_markup: {
          inline_keyboard: [
            [
              ...(e.thread && cfg.chatEnabled && bridge
                ? [bridge.connectButton(topic.threadId, e.thread.threadId)].filter(
                    (k) => k !== undefined,
                  )
                : []),
              {
                text: e.thread
                  ? tr("Открыть в BB")
                  : e.kind === "test"
                    ? tr("Открыть Telegram Projects")
                    : tr("Открыть ") + String(e.key) + "",
                url:
                  base.origin +
                  (e.thread
                    ? "/projects/" +
                      encodeURIComponent(e.projectId) +
                      "/threads/" +
                      encodeURIComponent(e.thread.threadId)
                    : e.kind === "test"
                      ? "/plugins/telegram-projects/telegram-projects"
                      : agency
                        ? "/plugins/agency/overview/jobs/" + encodeURIComponent(e.key)
                        : "/plugins/tasks/tasks/task/" + encodeURIComponent(e.key)),
              },
            ],
          ],
        },
      };
      const html = {
        ...common,
        text: e.thread
          ? formatThreadCard(e.thread, cfg.language as "ru" | "en", zone)
          : formatEvent(e, cfg.language as "ru" | "en", zone),
        parse_mode: "HTML",
      };
      // Agent reports go out as native Rich Messages; HTML stays as the fallback.
      if (e.thread && cfg.richReplies)
        await tg("sendRichMessage", {
          ...common,
          rich_message: {
            markdown: formatThreadRich(
              e.thread,
              cfg.language as "ru" | "en",
              zone,
            ),
          },
        }).catch((err) => {
          if (err instanceof TelegramFailure && err.code === "telegram_400")
            return tg("sendMessage", html);
          throw err;
        });
      else await tg("sendMessage", html);
      sent++;
      store.atomic(() => {
        store.put("sent:" + e.id, Date.now());
        store.del(key);
      });
    }
    // Keep dedupe receipts for a month. Task/worker snapshots contain metadata only.
    for (const { key, value: at } of store.list<number>("sent:"))
      if (at < Date.now() - 30 * 86400_000) store.del(key);
    lastSync = new Date().toISOString();
    lastError = taskFailure;
    await publishProjection(cfg.companionDir, allTasks);
  }
  // A hidden worker thread writes the summary with the chosen BB model; the sync loop only
  // polls it, so a slow model never blocks other deliveries. Failures keep the full reply.
  async function advanceSummaries(
    language: "ru" | "en",
    cfg: {
      summaryProvider: string;
      summaryModel: string;
      summaryReasoning: string;
      summaryServiceTier: string;
    },
  ) {
    for (const { key, value: e } of store.list<Event>("queue:")) {
      if (e.summary?.state !== "pending" || !e.thread) continue;
      const summary = e.summary;
      const finish = async (text: string | null) => {
        if (text) {
          e.thread!.reply = text;
          e.thread!.summaryModel = cfg.summaryModel || cfg.summaryProvider || "BB";
        }
        e.summary = { ...summary, state: text ? "done" : "failed" };
        store.put(key, e);
        if (summary.workerId)
          await bb.sdk.threads
            .archive({ threadId: summary.workerId })
            .catch(() => {});
      };
      try {
        if (!summary.workerId) {
          const source = await bb.sdk.threads.get({ threadId: e.thread.threadId });
          if (!source.environmentId) {
            await finish(null);
            continue;
          }
          const worker = await bb.sdk.threads.spawn({
            projectId: e.projectId,
            environment: { type: "reuse", environmentId: source.environmentId },
            prompt: summaryPrompt(e.thread.title, e.thread.reply ?? "", language),
            title: "Telegram · саммери · " + e.thread.title.slice(0, 60),
            visibility: "hidden",
            ...(cfg.summaryProvider ? { providerId: cfg.summaryProvider } : {}),
            ...(cfg.summaryModel ? { model: cfg.summaryModel } : {}),
            ...(cfg.summaryReasoning
              ? { reasoningLevel: cfg.summaryReasoning as "low" }
              : {}),
            ...(cfg.summaryServiceTier
              ? { serviceTier: cfg.summaryServiceTier as "fast" }
              : {}),
            pluginMetadata: { role: "telegram-summary", threadId: e.thread.threadId },
          });
          e.summary = { state: "pending", workerId: worker.id, startedAt: Date.now() };
          store.put(key, e);
          continue;
        }
        const worker = await bb.sdk.threads.get({ threadId: summary.workerId });
        if (worker.status === "error" || worker.archivedAt || worker.deletedAt) {
          await finish(null);
          continue;
        }
        if (worker.status === "idle" && !worker.queuedMessageCount) {
          const out = await bb.sdk.threads
            .output({ threadId: summary.workerId, signal: lifetime.signal })
            .then((r) => r.output?.trim() || null)
            .catch(() => null);
          if (out) {
            await finish(out);
            continue;
          }
        }
        if (Date.now() - (summary.startedAt ?? 0) > 180_000) await finish(null);
      } catch {
        await finish(null);
      }
    }
  }
  async function collectThreadEvents(
    ev: Events,
    visible: { id: string; name: string }[],
    folders: Folder[],
    hidden: Set<string>,
  ) {
    const batch = [...pendingThreads];
    pendingThreads.clear();
    const bound = new Set(
      store
        .list<{ threadId: string | null }>("chat:binding:")
        .map((x) => x.value.threadId),
    );
    for (const [threadId, types] of batch) {
      try {
        const t = await bb.sdk.threads.get({ threadId, signal: lifetime.signal });
        const project = visible.find((p) => p.id === t.projectId);
        // Sub-agents, chats already mirrored into Telegram and closed threads stay quiet.
        if (
          !project ||
          t.parentThreadId ||
          bound.has(threadId) ||
          store.get(sharedGroupThreadKey(threadId)) ||
          t.deletedAt ||
          t.archivedAt ||
          t.visibility === "hidden"
        )
          continue;
        const pending = await bb.sdk.threads.interactions
          .list({ threadId, signal: lifetime.signal })
          .then((list) => list.filter((i: any) => i.status === "pending" || !i.status))
          .catch(() => []);
        const previous = store.get<string>("thread:status:" + threadId);
        store.put("thread:status:" + threadId, t.status);
        const outcome = classifyThread(
          [...types],
          t.status,
          pending.length,
          previous,
        );
        if (!outcome) {
          // turn/completed can arrive while the status still reads active: look again next pass.
          if (["active", "starting", "stopping", "pending"].includes(t.status))
            pendingThreads.set(threadId, new Set([...types, ...(pendingThreads.get(threadId) ?? [])]));
          continue;
        }
        const kind = ("thread_" + outcome) as "thread_done";
        if (!route(ev, kind, project.id).send) continue;
        const env = t.environmentId
          ? await bb.sdk.environments
              .get({ environmentId: t.environmentId })
              .catch(() => null)
          : null;
        const section = sectionFor(
          folders.filter((f) => f.projectId === project.id),
          (env as { path?: string } | null)?.path,
        );
        if (section && hidden.has("f:" + section.id)) continue;
        const stamp =
          outcome === "attention"
            ? pending.map((i: any) => i.id).join(",")
            : String(t.updatedAt);
        const id = `thread:${threadId}:${outcome}:${stamp}`;
        if (store.get("sent:" + id)) continue;
        const reply =
          outcome === "attention"
            ? null
            : await bb.sdk.threads
                .output({ threadId, signal: lifetime.signal })
                .then((r) => r.output ?? null)
                .catch(() => null);
        const event: Event = {
          id,
          projectId: project.id,
          taskId: "",
          key: threadId,
          title: t.title || t.titleFallback || threadId,
          tracker: "",
          status: t.status,
          kind,
          dueDate: null,
          at: new Date().toISOString(),
          urgent: outcome !== "done",
          thread: {
            threadId,
            outcome,
            status: t.status,
            project: project.name,
            section: section?.name ?? null,
            title: t.title || t.titleFallback || threadId,
            agent: t.providerId,
            reply,
            at: Date.now(),
          },
        };
        const cfg = await settings.get();
        if (cfg.reportMode === "summary" && reply && reply.length > 500)
          event.summary = { state: "pending" };
        store.put("queue:" + id, event);
      } catch {
        // A thread that cannot be read now is retried with its next change.
      }
    }
  }
  // Only for a companion service that reads topics from a file (for example SMS delivery).
  async function publishProjection(
    dir: string,
    items: { task: Task; tracker: Tracker }[],
  ) {
    if (!dir) return;
    const data = {
      botId: botId(),
      ownerId: ownerId(),
      updatedAt: Date.now(),
      topicsEnabled,
      error: lastError,
      topics: store
        .list<Topic>("topic:")
        .map((x) => x.value)
        .filter((x) => !x.missingSince),
      chatBindings:
        bridge
          ?.bindings()
          .map((b) => ({ topicId: b.topicId, projectId: b.projectId })) ?? [],
      tasks: items
        .filter((x) => !["done", "canceled"].includes(x.task.status))
        .map(({ task, tracker }) => ({
          key: task.key,
          title: task.title,
          status: task.status,
          projectId: tracker.linkedBbProjectId,
          tracker: tracker.name,
        }))
        .slice(0, 500),
    };
    await writeJsonAtomic(join(dir, "telegram-projects.json"), data);
  }
  async function sync() {
    if (flight) return flight;
    flight = run()
      .catch((e) => {
        lastError = safeError(e);
        if (e instanceof TelegramFailure)
          store.put("retryAt", Date.now() + e.retryAfter * 1000);
        bb.log.warn("Telegram Projects: " + lastError);
      })
      .finally(() => {
        flight = null;
      });
    return flight;
  }
  const agency=agencyIntegration(store);
  async function isolatedProject() {
    const config=await settings.get();
    const project=config.isolatedGroupProject;
    if (!project || ownerId() || botId()) throw Error("isolated_executor_required");
    if (config.enabled || config.chatEnabled || config.botToken || await tokenSource() !== "none")
      throw Error("isolated_executor_required");
    return project;
  }
  bb.rpc.register(rpcContract, {
    rightsAccess: async () => botId() ? accessList(store, botId()!) : [],
    rightsAccessSet: async ({ people }) => {
      if (!botId()) throw Error("bot_unavailable");
      return setAccess(store, botId()!, people);
    },
    rightsGroup: async ({ chatId }) => botId() ? groupSettings(store, botId()!, chatId) ?? null : null,
    rightsGroupSet: async ({ chatId, ...change }) => {
      if (!botId()) throw Error("bot_unavailable");
      return saveGroupSettings(store, botId()!, chatId, change);
    },
    reconcileEmployeeTicket: async ({idempotencyKey})=>{
      const read=()=>{
        const path=process.env.BB_TELEGRAM_EMPLOYEE_PROFILE;
        if(!path || stateTransferBusy) throw Error("employee_unavailable");
        const p=readEmployeeProfile(path);
        if(p.owner!==ownerId() || p.botId!==botId()) throw Error("employee_identity_mismatch");
        return p;
      };
      return reconcileEmployeeTicket(store,read,idempotencyKey,chat=>telegram(botToken,lifetime.signal,15000,()=>chat,apiRoot));
    },
    checkEmployeeWrite: args=>{
      const path=process.env.BB_TELEGRAM_EMPLOYEE_PROFILE;
      if(!path)return {allowed:false};
      const p=readEmployeeProfile(path);
      return {allowed:p.botId===botId() && p.owner===ownerId() && employeeWriteAllowed(store,p,args)};
    },
    submitIsolatedGroup: async args => submitIsolatedGroup(bb.sdk,store,await isolatedProject(),args,(await settings.get()).telegramInboxRoot),
    readIsolatedPdf: async args => readIsolatedPdf(bb.sdk,store,await isolatedProject(),(await settings.get()).isolatedFileHost,args),
    readIsolatedImage: async args => readIsolatedImage(bb.sdk,store,await isolatedProject(),(await settings.get()).isolatedFileHost,args),
    readIsolatedGroup: async args => readIsolatedGroup(bb.sdk,store,await isolatedProject(),args),
    inspectChannelRights: async ({channelId})=>{
      const owner=ownerId(), bot=botId();
      if (!owner || !bot) throw Error("bot_unavailable");
      if (!(await settings.get()).managedChannels.split(/[,\s]+/).includes([bot,owner,channelId].join(":")))
        throw Error("channel_not_configured");
      const tg=telegram(botToken,lifetime.signal,15000,()=>channelId,apiRoot);
      await checkBot(tg,bot);
      return inspectChannelRights(tg,channelId,owner,bot);
    },
    scheduleGroupReminder: async args=>{
      const owner=ownerId(), bot=botId();
      if (!bridge || !owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      await bridge.validateOwnerAction(args.threadId,args.routeToken,owner);
      const cfg=await settings.get();
      if (!cfg.enabled || !cfg.chatEnabled || owner!==ownerId() || bot!==botId() || stateTransferBusy)
        throw Error("bot_unavailable");
      const status=queueGroupReminder(store,owner,bot,args);
      chatWake?.();
      return status;
    },
    presentOwnerProposal: async args=>{
      const owner=ownerId(),bot=botId();
      if(!bridge || !owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      await bridge.validateOwnerAction(args.threadId,args.routeToken,owner);
      const cfg=await settings.get();
      if(!cfg.enabled || !cfg.chatEnabled || owner!==ownerId() || bot!==botId() || stateTransferBusy)
        throw Error("bot_unavailable");
      return presentProposal(store,owner,bot,args,telegram(botToken,lifetime.signal,15000,ownerId,apiRoot));
    },
    resolveOwnerGroupMessage: async args=>{
      const owner=ownerId(), bot=botId();
      if (!bridge || !owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      await bridge.validateOwnerAction(args.threadId,args.routeToken,owner);
      const cfg=await settings.get();
      if (!cfg.enabled || !cfg.chatEnabled || owner!==ownerId() || bot!==botId() || stateTransferBusy)
        throw Error("bot_unavailable");
      return resolveGroupMessage(store,owner,bot,args.link);
    },
    inspectGroupTask: async args=>{
      const owner=ownerId(), bot=botId();
      if (!bridge || !owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      await bridge.validateOwnerAction(args.threadId,args.routeToken,owner);
      const cfg=await settings.get();
      if (!cfg.enabled || !cfg.chatEnabled || owner!==ownerId() || bot!==botId() || stateTransferBusy)
        throw Error("bot_unavailable");
      return inspectGroupTask(store,owner,bot,args.taskId);
    },
    returnGroupResult: async args=>{
      const owner=ownerId(), bot=botId();
      if (!bridge || !owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      await bridge.validateOwnerAction(args.threadId,args.routeToken,owner);
      const cfg=await settings.get();
      if (!cfg.enabled || !cfg.chatEnabled || owner!==ownerId() || bot!==botId() || stateTransferBusy)
        throw Error("bot_unavailable");
      const status=queueGroupResult(store,owner,bot,args.taskId,args.text);
      chatWake?.();
      return status;
    },
    channelPost: async args=>{
      const owner=ownerId(), bot=botId();
      if (!bridge || !owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      const token=await botToken(), root=await apiRoot();
      const tg=telegram(async()=>token,lifetime.signal,15000,()=>args.channelId,async()=>root);
      const cfg=await settings.get();
      if(!cfg.managedChannels.split(/[,\s]+/).includes([bot,owner,args.channelId].join(":"))) throw Error("channel_not_configured");
      await checkBot(tg,bot);
      const chat=await tg("getChat",{chat_id:args.channelId});
      if (chat.id!==args.channelId || chat.type!=="channel") throw Error("channel_required");
      await bridge.validateOwnerAction(args.threadId,args.routeToken,owner);
      const current=await settings.get();
      if(owner!==ownerId() || bot!==botId() || stateTransferBusy || !current.enabled || !current.chatEnabled) throw Error("bot_changed");
      activeTelegramWrites++;
      try { return await channelPost(store,tg,owner,bot,current.managedChannels,args); }
      finally { activeTelegramWrites--; }
    },
    bindGroupTopic: async ({chatId,topicId,threadId,ownerOnly,requireMention,ownerSharedProject,addressName,allowedSenderIds,deliverySources,includeTopicContext,searchableHistory,retainFullHistory})=>{
      const owner=ownerId(), bot=botId();
      if (!owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      const tg=telegram(botToken,lifetime.signal,15_000,()=>chatId,apiRoot);
      const me=await checkBot(tg,bot);
      const chat=await tg("getChat",{chat_id:chatId});
      if (chat.id!==chatId || !["group","supergroup"].includes(chat.type) ||
          (topicId>0 && !chat.is_forum)) throw Error("group_unavailable");
      const member=await tg("getChatMember",{chat_id:chatId,user_id:owner});
      if (!["creator","administrator"].includes(member.status)) throw Error("group_owner_required");
      if (retainFullHistory && !searchableHistory) throw Error("full_history_requires_search");
      if (searchableHistory && (!includeTopicContext || !history)) throw Error("history_requires_topic_context_and_fts5");
      let warning:string|undefined;
      if ((includeTopicContext || requireMention || addressName) && !me.readsAllGroups) {
        const self=await tg("getChatMember",{chat_id:chatId,user_id:bot});
        if (!["creator","administrator"].includes(self.status)) {
          warning="Пока бот в этой группе обычный участник, Telegram показывает ему только ответы на его сообщения и команды для него; отметки через @ до него не доходят. Чтобы бота можно было просто отметить, сделайте его администратором группы (права можно не давать). До этого обращайтесь ответом на его сообщение.";
          if (includeTopicContext || addressName) throw Error(warning);
        }
      }
      const executor=groupExecutor(chatId,topicId);
      if (ownerSharedProject) {
        if (executor || !await sharedOwnerForum(tg,chatId,owner,bot))
          throw Error("private_owner_forum_required");
        if (!requireMention && !me.readsAllGroups) {
          const self=await tg("getChatMember",{chat_id:chatId,user_id:bot});
          if (self.status!=="administrator") throw Error("private_owner_forum_cannot_read_plain_messages");
        }
      }
      if (executor && executor.threadId!==threadId) throw Error("isolated_thread_required");
      const thread=executor ?? await bb.sdk.threads.get({threadId});
      if (!thread.projectId || ("visibility" in thread && (thread.archivedAt || thread.deletedAt || thread.visibility==="hidden")))
        throw Error("thread_unavailable");
      if (ownerSharedProject) {
        if (!("parentThreadId" in thread) || thread.parentThreadId) throw Error("separate_group_root_required");
        if (!store.get(sharedGroupThreadKey(threadId))) {
          const lineage=await bb.sdk.threads.experimental_listDescendants({threadIds:[threadId],
            includeHidden:true,includeArchived:true,signal:lifetime.signal});
          if (lineage.threads.length!==1 || lineage.threads[0].descendantIds.length)
            throw Error("separate_group_root_required");
        }
      }
      if (owner!==ownerId() || bot!==botId() || stateTransferBusy) throw Error("bot_changed");
      bindGroupTopic(store,{ownerSharedProject,addressName,deliverySources:deliverySources ? [...new Set(deliverySources)].sort() : store.get<{deliverySources?:string[]}>(`group:policy:${chatId}:${topicId}`)?.deliverySources,isolated:!!executor,searchableHistory,retainFullHistory,includeTopicContext,allowedSenderIds:[...new Set(allowedSenderIds)].sort((a,b)=>a-b),chatId,topicId,threadId,ownerOnly,requireMention,botId:bot,botUsername:me.username,
        ownerId:owner,revision:crypto.randomUUID()},thread.projectId);
      return warning ? {bound:true as const,warning} : {bound:true as const};
    },
    unbindGroupTopic: ({chatId,topicId})=>{
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      const key=`group:policy:${chatId}:${topicId}`;
      const previous=store.get<{botId:number}>(key);
      const removed=!!previous;
      store.atomic(()=>{if (previous) {
        for (const row of store.list(`group:recent-files:${previous.botId}:${chatId}:${topicId}:`)) store.del(row.key);
        for (const row of store.list(contextMediaPrefix(previous.botId,chatId,topicId))) store.del(row.key);
      }
        for (const row of store.list(historyPrefix(chatId,topicId))) store.del(row.key);store.del(key);store.del(`group:context:${chatId}:${topicId}`);});
      return {removed};
    },
    providerHandoffStatus: ({topicId}) => bridge?.providerHandoffStatus(topicId) ?? null,
    startProviderHandoff: async ({topicId, sourceThreadId, providerId, model}) => {
      if (!bridge) throw Error("chat_bridge_unavailable");
      return bridge.beginProviderHandoff(topicId, sourceThreadId, providerId, model);
    },
    cancelProviderHandoff: async ({topicId, id}) => {
      if (!bridge) throw Error("chat_bridge_unavailable");
      return bridge.cancelProviderHandoff(topicId, id);
    },
    exportPrivateState: async ({targetVersion}) => {
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      const c = await settings.get();
      if (c.enabled || c.chatEnabled || ingressPolling || flight || bridge || activeTelegramWrites)
        throw Error("stop_receivers_before_state_export");
      return new StateTransfer(store).export(c, targetVersion);
    },
    restorePrivateState: async ({id, sha256}) => {
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      stateTransferBusy = true;
      try {
        const c = await settings.get();
        if (c.enabled || c.chatEnabled || ingressPolling || flight || bridge || activeTelegramWrites)
          throw Error("stop_receivers_before_state_restore");
        return await new StateTransfer(store).restore(id, sha256,
          value => settings.experimental_set(value as Parameters<typeof settings.experimental_set>[0]));
      } finally { stateTransferBusy = false; }
    },
    replacePrivateState: async ({id, sha256, expectedCurrentSha256}) => {
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      stateTransferBusy = true;
      try {
        const c = await settings.get();
        if (c.enabled || c.chatEnabled || ingressPolling || flight || bridge || activeTelegramWrites)
          throw Error("stop_receivers_before_state_replace");
        return await new StateTransfer(store).replace(id, sha256, expectedCurrentSha256, c,
          value => settings.experimental_set(value as Parameters<typeof settings.experimental_set>[0]));
      } finally { stateTransferBusy = false; }
    },
    agencyCapabilities: async()=>{const c=await settings.get();return agency.capabilities(c.enabled&&c.agencyEnabled);},
    agencyConfigure: async({enabled})=>{await settings.experimental_set({agencyEnabled:enabled});return {saved:true as const};},
    agencyEnqueue: async(input)=>{const c=await settings.get();return agency.enqueue(input,c.enabled&&c.agencyEnabled);},
    agencyDeliveryStatus: ({deliveryId})=>agency.status(deliveryId),
    preferences: async () => {
      const c = await settings.get();
      return {
        ...(Object.fromEntries(
          Object.keys(preferencesSchema.shape).map((k) => [
            k,
            c[k as keyof typeof c],
          ]),
        ) as z.infer<typeof preferencesSchema>),
        tokenPresent: (await tokenSource()) !== "none",
        tokenSource: await tokenSource(),
        tokenEnv: c.tokenEnv,
      };
    },
    savePreferences: async (value) => {
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      await settings.experimental_set(value);
      return true;
    },
    checkConnection: async ({ token }) => {
      const c = await settings.get();
      return diagnose(
        token?.trim() || (await botToken().catch(() => "")),
        fetch,
        botId(),
        c.telegramApiRoot,
      );
    },
    telegramDeliveryStatus: async ({deliveryId}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.explicitDeliveryStatus(deliveryId);
    },
    sendDelegated: async args => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.sendDelegated(args);
    },
    spawnDelegated: async args => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.spawnDelegated(args);
    },
    sendToTelegram: async (args) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.sendExplicit(args);
    },
    prepareLocalApi: async ({ expectedUsername }) => {
      const c = await settings.get();
      if (c.enabled || c.chatEnabled) throw Error("disable_receivers_before_transfer");
      if (ingressPolling || flight || bridge) throw Error("wait_for_receivers_to_stop");
      if (checkedApiRoot(c.telegramApiRoot) !== "https://api.telegram.org")
        throw Error("cloud_endpoint_required");
      const key = "migration:cloud-logout";
      const previous = store.get<{state: string; username: string; botId: number}>(key);
      if (previous) {
        if (previous.username !== expectedUsername) throw Error("transfer_identity_changed");
        if (previous.state !== "done") throw Error("logout_outcome_uncertain_check_before_retry");
        return {loggedOut: true, botId: previous.botId};
      }
      const tg = telegram(botToken, lifetime.signal, 30_000, ownerId, apiRoot);
      const me = await checkBot(tg, botId());
      if (me.username !== expectedUsername) throw Error("unexpected_bot_identity");
      store.put(key, {state: "attempting", username: me.username, botId: me.id});
      const result = await tg("logOut", {});
      if (result !== true) throw Error("logout_not_confirmed");
      store.put(key, {state: "done", username: me.username, botId: me.id});
      return {loggedOut: true, botId: me.id};
    },
    saveToken: async ({ token }) => {
      const clean = token.trim();
      const result = await diagnose(clean, fetch, botId(), await apiRoot());
      if (result.valid && result.sameBot && !result.error && !result.webhook) {
        await settings.experimental_set({ botToken: clean });
      }
      return result;
    },
    eventsGet: async () => {
      const [ev, list, folders] = await Promise.all([
        events(),
        bb.sdk.projects.list({ signal: lifetime.signal }),
        folderState(),
      ]);
      return {
        events: ev,
        projects: list
          .filter((p) => p.kind === "standard")
          .map((p) => ({
            id: p.id,
            name: p.name,
            hidden: folders.hidden.includes("p:" + p.id),
            topicId: store.get<Topic>("topic:" + p.id)?.threadId ?? null,
          })),
      };
    },
    eventsSave: async (value) => {
      store.put("events:config", value);
      wake?.();
      return true;
    },
    syncMenu: async () => {
      store.del("commandsLanguage");
      await sync();
      return status();
    },
    // The native picker needs a concrete value: start from BB's own default model.
    summaryDefaults: async () => {
      const base = await bb.sdk.system.executionOptions({});
      const providerId =
        base.providers.find((p) => p.available)?.id ?? "claude-code";
      const options = await bb.sdk.system.executionOptions({ providerId });
      const model =
        options.models.find((m) => m.isDefault) ?? options.models[0];
      return {
        providerId,
        model: model?.model ?? "",
        reasoningLevel: model?.defaultReasoningEffort ?? "medium",
      };
    },
    useEnvToken: async () => {
      await settings.experimental_set({ botToken: null });
      envToken.at = 0;
      return (await tokenSource()) === "env";
    },
    // The owner is whoever sends "/start <code>" to the bot from a private chat.
    pairing: async () => {
      const owner = ownerId() ?? null;
      if (owner) return { owner, code: null, link: null };
      const code = pairCode();
      return {
        owner,
        code,
        link: username ? `https://t.me/${username}?start=${code}` : null,
      };
    },
    unpair: async () => {
      store.del("owner:id");
      store.del("commandsLanguage");
      return true;
    },
    initTopics: async () => {
      store.put("topicsBootstrapped", true);
      await sync();
      return status();
    },
    status: () => status(),
    sync: async () => {
      await sync();
      return status();
    },
  });
  bb.cli.register({
    name: "telegram-projects",
    summary: "BB project topics, chats and Tasks notifications in Telegram",
    commands: [
      {
        name:"search-history",
        summary:"Search messages received in the current bound group or topic",
        usage:"bb telegram-projects search-history <words>",
      },
      {
        name: "chat-forget",
        summary: "Remove a topic binding and keep the chats",
        usage: "bb telegram-projects chat-forget <topic-id>",
      },
      {
        name: "chat-status",
        summary: "Chat bridge status",
        usage: "bb telegram-projects chat-status --json",
      },
      {
        name: "menu",
        summary: "Show the chat menu in a project topic",
        usage: "bb telegram-projects menu <project-id>",
      },
      {
        name: "test",
        summary: "Send a clearly marked test card to a project topic",
        usage: "bb telegram-projects test <project-id>",
      },
      {
        name: "status",
        summary: "Status and topics",
        usage: "bb telegram-projects status --json",
      },
      {
        name: "sync",
        summary: "Sync now",
        usage: "bb telegram-projects sync --json",
      },
      {
        name: "bind",
        summary:
          "Bind an existing topic to a project, SMS or navigation",
        usage:
          "bb telegram-projects bind <project-id|sms|navigation> <topic-id>",
      },
    ],
    async run(argv,ctx) {
      if (argv[0] !== "search-history" && (groupCliRestricted(store, ctx.projectId, ctx.threadId) ||
          (ctx.threadId && (await sharedGroupThreads(store,bb.sdk.threads,[ctx.threadId])).has(ctx.threadId))))
        return {exitCode: 1, stderr: "bridge_admin_command_unavailable_in_group"};
      if(argv[0]==="search-history"){
        const threadId=ctx.threadId;
        const scope=threadId && store.get<string>("group:thread:"+threadId);
        const policy=scope && store.get<import("./ingress").GroupTopicPolicy>(scope);
        if(!history || !policy || !policy.searchableHistory || policy.threadId!==threadId ||
          policy.ownerId!==ownerId() || policy.botId!==botId())return {exitCode:1,stderr:"bound_searchable_group_required"};
        const query=argv.slice(1).join(" ").trim();
        if(!query || query.length>1000)return {exitCode:1,stderr:"search_query_required"};
        const rows=history.find(historyPrefix(policy.chatId,policy.topicId),query,Number.MAX_SAFE_INTEGER);
        return {exitCode:0,stdout:topicPassages(rows,policy.chatId)||"Совпадений нет."};
      }
      const [cmd, key, id] = argv.filter((x) => x !== "--json");
      if (cmd === "chat-forget") {
        const topicId = Number(key);
        if (!bridge || !Number.isSafeInteger(topicId) || topicId < 0)
          return { exitCode: 1, stderr: "invalid_topic" };
        bridge.forget(topicId);
        return {
          exitCode: 0,
          stdout: "Binding removed; BB and Telegram history preserved",
        };
      }
      if (cmd === "chat-status")
        return {
          exitCode: 0,
          stdout: JSON.stringify(bridge?.status() ?? { started: false }),
        };
      if (cmd === "menu") {
        const topic = key ? store.get<Topic>("topic:" + key) : undefined;
        if (!bridge || !topic?.threadId)
          return { exitCode: 1, stderr: "chat_topic_required" };
        await bridge.handle({
          updateId: Date.now(),
          ownerId: ownerId()!,
          chatId: ownerId()!,
          topicId: topic.threadId,
          messageId: 0,
          text: "/menu",
        });
        return { exitCode: 0, stdout: "Menu queued" };
      }
      if (cmd === "test") {
        if (flight) await flight;
        const cfg = await settings.get();
        if (
          !cfg.enabled ||
          !key ||
          !key.startsWith("proj_") ||
          !store.get<Topic>("topic:" + key)?.threadId
        )
          return { exitCode: 1, stderr: "project_topic_required" };
        const event: Event = {
          id: "test:" + Date.now(),
          projectId: key,
          taskId: "demo",
          key: "TEST",
          title: translate(
            cfg.language as "ru" | "en",
            "Уведомления Tasks будут приходить в тему своего проекта. Это проверка доставки, не настоящая задача.",
          ),
          tracker: translate(cfg.language as "ru" | "en", "Проверка настройки"),
          status: "todo",
          kind: "test",
          dueDate: null,
          at: new Date().toISOString(),
          urgent: false,
        };
        store.put("queue:" + event.id, event);
        await sync();
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            queued: !!store.get("queue:" + event.id),
            error: lastError,
          }),
        };
      }
      if (cmd === "bind") {
        if (flight) return { exitCode: 1, stderr: "sync_busy" };
        // An empty database adopts existing topics; the next sync restores their names.
        const topic: Topic | undefined =
          key && /^(proj_\w+|sms|navigation)$/.test(key)
            ? (store.get<Topic>("topic:" + key) ?? {
                key,
                name: "",
                threadId: null,
                creating: false,
              })
            : undefined;
        const threadId = Number(id);
        if (!topic || !Number.isSafeInteger(threadId) || threadId <= 0)
          return { exitCode: 1, stderr: "invalid_binding" };
        if (
          store
            .list<Topic>("topic:")
            .some((x) => x.value.key !== key && x.value.threadId === threadId)
        )
          return { exitCode: 1, stderr: "topic_already_bound" };
        const tg = telegram(botToken, lifetime.signal, 15_000, ownerId, apiRoot);
        await checkBot(tg, botId());
        if (topic.name)
          await tg("editForumTopic", {
            message_thread_id: threadId,
            name: topic.name,
          });
        store.put("topicsBootstrapped", true);
        store.put("topic:" + key, {
          ...topic,
          threadId,
          creating: false,
          introId: undefined,
          introText: undefined,
        });
        return { exitCode: 0, stdout: "Bound" };
      }
      if (cmd === "sync") await sync();
      else if (cmd !== "status")
        return { exitCode: 1, stderr: "Use status, sync or bind" };
      return { exitCode: 0, stdout: JSON.stringify(await status(), null, 2) };
    },
  });
  settings.onChange(() => {
    wake?.();
  });
  bb.background.service("project-task-sync", {
    async start(signal) {
      signal.addEventListener("abort", () => lifetime.abort(), { once: true });
      const unsubscribe = bb.sdk.subscribe({
        event: "project:changed",
        callback: () => wake?.(),
      });
      const relevant = [
        "turn/completed",
        "system/thread/interrupted",
        "system/interaction/lifecycle",
        "system/userQuestion/lifecycle",
      ];
      const unsubscribeThreads = bb.sdk.subscribe({
        event: "thread:changed",
        callback: (e) => {
          const types = e.metadata?.eventTypes ?? [];
          const status = e.changes?.includes("status-changed");
          if (!e.id || (!status && !types.some((x) => relevant.includes(x))))
            return;
          const set = pendingThreads.get(e.id) ?? new Set<string>();
          for (const x of types) set.add(x);
          pendingThreads.set(e.id, set);
          wake?.();
        },
      });
      try {
        while (!signal.aborted) {
          await sync();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, 15_000);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              wake = undefined;
              resolve();
            }
            wake = done;
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }
      } finally {
        unsubscribe();
        unsubscribeThreads();
      }
    },
  });
  bb.background.service("telegram-chat", {
    async start(signal) {
      // The control file and spool exist only for an optional companion receiver.
      const companion = (await settings.get()).companionDir;
      const spool = companion ? join(companion, "bb-chat-inbox") : undefined;
      const publishControl = companion
        ? makeChatControlPublisher(join(companion, "telegram-chat.json"))
        : async () => {};
      let rich = true;
      let currentUrl = "";
      let language: "ru" | "en" = "ru";
      let typing:(()=>Promise<void>)|undefined;
      let activeAbort: AbortController | undefined;
      let pendingWake = false;
      let resume: (() => void) | undefined;
      const wakeChat = () => {
        pendingWake = true;
        resume?.();
      };
      chatWake = wakeChat;
      if (spool) await mkdir(spool, { recursive: true, mode: 0o700 });
      const watcher = spool
        ? watch(spool, (_event, name) => {
            if (name?.toString().endsWith(".json")) wakeChat();
          })
        : undefined;
      watcher?.on("error", () => {}); // Timed polling remains as recovery if filesystem events are lost.
      try {
        while (!signal.aborted) {
          const cfg = await settings.get();
          if (cfg.enabled && cfg.chatEnabled && !stateTransferBusy) {
            rich = cfg.richReplies;
            currentUrl = new URL(cfg.appUrl).origin;
            language = cfg.language as "ru" | "en";
            if (!bridge) {
              if (spool) await mkdir(spool, { recursive: true, mode: 0o700 });
              activeAbort = new AbortController();
              const bridgeSignal = AbortSignal.any([
                signal,
                activeAbort.signal,
                lifetime.signal,
              ]);
              typing=groupTyping(store,ownerId,botId,chatId=>telegram(botToken,bridgeSignal,3000,()=>chatId,apiRoot),bridgeSignal);
              bridge = new ChatBridge({
                collectMs: 4000,
                store,
                sdk: bb.sdk,
                tg: telegram(botToken, bridgeSignal, 15_000, ownerId, apiRoot),
                owner: ownerId,
                spool,
                get baseUrl() {
                  return currentUrl;
                },
                signal: bridgeSignal,
                rich: () => rich,
                language: () => language,
                wake: wakeChat,
                transcribe: async (v) => {
                  const {voiceRouterPath} = await settings.get();
                  return transcribeTelegramVoice(botToken, bb.sdk, v, bridgeSignal, apiRoot, localFiles,
                    voiceRouterPath ? audio => transcribeWithVoiceRouter(voiceRouterPath, audio, bridgeSignal) : undefined);
                },
                receiveAttachment: async (input, threadId) => {
                  return receiveLocalFile(input.attachment!,input.updateId,threadId,bridgeSignal);
                },
              });
              bridge.recover();
            }
            await publishControl(true, cfg.language);
            await bridge.tick();
            const owner = ownerId(), bot = botId();
            if (owner && bot) {
              try {
                void typing?.();
                await presentProjectProposals(store,owner,bot,telegram(botToken,signal,15000,ownerId,apiRoot));
                collectDecisionResults(store,owner,bot);
                const groupTransport=(chatId:number)=>telegram(botToken,signal,15000,()=>chatId,apiRoot);
                const verifyOwnerForum=async (policy:GroupTopicPolicy)=> {
                  try {
                    return await sharedOwnerForum(groupTransport(policy.chatId),policy.chatId,owner,bot) &&
                      ownerId()===owner && botId()===bot && !stateTransferBusy;
                  } catch { return false; }
                };
                await deliverGroupResults(store,bb.sdk,o=>o.owner===ownerId() && o.bot===botId() && !stateTransferBusy,
                  groupTransport,signal,verifyOwnerForum);
                await processGroupInputs(store,bb.sdk,owner,bot,
                  groupTransport,signal,
                  voice=>transcribeTelegramVoice(botToken,bb.sdk,voice,signal,apiRoot,localFiles,
                    cfg.voiceRouterPath ? audio=>transcribeWithVoiceRouter(cfg.voiceRouterPath,audio,signal) : undefined),cfg.telegramFileHostId,
                  (file,r)=>receiveGroupFile(file,r,signal,bot),true,verifyOwnerForum);
              } catch (error) { ingressError = safeError(error); }
            }
          } else {
            activeAbort?.abort();
            await bridge?.dispose();
            bridge = undefined;
            await publishControl(false, cfg.language);
          }
          await new Promise<void>((resolve) => {
            if (pendingWake) {
              pendingWake = false;
              resolve();
              return;
            }
            resume = done;
            const timer = setTimeout(done, 2000);
            function done() {
              clearTimeout(timer);
              resume = undefined;
              pendingWake = false;
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
        }
      } finally {
        watcher?.close();
        await bridge?.dispose();
      }
    },
  });
  function taskList(topicId: number, language: "ru" | "en") {
    const tr = (s: string) => translate(language, s);
    const projectId =
      store.list<Topic>("topic:").find((x) => x.value.threadId === topicId)
        ?.value.key ??
      bridge?.bindings().find((b) => b.topicId === topicId)?.projectId;
    const project = projectId?.startsWith("proj_")
      ? store.get<Topic>("topic:" + projectId)
      : undefined;
    const names: Record<string, string> = {
      backlog: tr("в планах"),
      todo: tr("к выполнению"),
      in_progress: tr("в работе"),
      in_review: tr("нужна проверка"),
    };
    const list = activeTasks.filter(
      (x) =>
        !["done", "canceled"].includes(x.task.status) &&
        (!project || x.tracker.linkedBbProjectId === project.key),
    );
    return (
      "📋 " +
      (project?.name ?? tr("Активные задачи")) +
      "\n\n" +
      (list.length
        ? list
            .slice(0, 12)
            .map(
              ({ task, tracker }) =>
                `${task.key} · ${tracker.name}\n${task.title.slice(0, 140)}\n${names[task.status] ?? task.status}`,
            )
            .join("\n\n")
        : tr("Активных задач нет.")) +
      (list.length > 12
        ? tr("\n\nЕщё ") + String(list.length - 12) + tr(" — в BB.")
        : "")
    ).slice(0, 3900);
  }
  bb.background.service("rights-consent", {
    async start(signal) {
      const pause = (ms: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
      });
      while (!signal.aborted) {
        const cfg = await settings.get();
        if (cfg.enabled && cfg.chatEnabled && botId() && ownerId() && !stateTransferBusy)
          await watchConsents(consentContext(signal)).catch(() => {});
        await pause(4000);
      }
    },
  });
  bb.background.service("telegram-ingress", {
    async start(signal) {
      const pause = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
        });
      const tg = telegram(botToken, signal, 40_000, ownerId, apiRoot);
      const sendGroupVisibility = async () => {
        if (!legacyOperations) return notifyGroupsAdded(await setupContext(signal));
        const path=legacyOperations ? process.env.BB_TELEGRAM_EMPLOYEE_PROFILE : undefined;
        const profile=path ? readEmployeeProfile(path) : undefined;
        const managers=profile ? (profile.botId===botId() && profile.owner===ownerId() ? profile.admins : [])
          : [ownerId()!, ...accessList(store,botId()!).map(p=>p.id)];
        return sendVisibilityUpdates(store,botId()!,chat=>telegram(botToken,signal,15000,()=>chat,apiRoot),managers);
      };
      while (!signal.aborted) {
        const cfg = await settings.get();
        store.put(accessModeKey, cfg.accessPermissionMode);
        store.put(installKindKey, cfg.installKind);
        consentTtlMs = Math.max(1, Number(cfg.consentMinutes) || 30) * 60_000;
        if (botId() && ownerId()) migrateLegacyRights(store, botId()!, profilePeople());
        // Hold updates until the chat bridge exists, so none is consumed and lost.
        if (!cfg.enabled || stateTransferBusy || (cfg.chatEnabled && ownerId() && !bridge)) {
          ingressError = null;
          await pause(cfg.enabled ? 1000 : 5000);
          continue;
        }
        try {
          let updates: any[];
          ingressPolling = true;
          try {
            updates = await tg<any[]>("getUpdates", {
              offset: store.get<number>("ingress:offset") ?? 0,
              timeout: 25,
              allowed_updates: ["message", "edited_message", "callback_query", ...(process.env.BB_TELEGRAM_GUEST_TOPICS ? ["guest_message"] : []), "my_chat_member"],
            });
          } finally { ingressPolling = false; }
          ingressError = null;
          for (const u of updates) {
            if (botId() && u.my_chat_member) {
              rememberMembership(store,botId()!,u);
              const me = await checkBot(tg,botId());
              store.put(privacyKey(me.id), !me.readsAllGroups);
              if (ownerId()) await sendGroupVisibility();
            }
            if (skipExcludedForumUpdate(store, u)) continue;
            const profilePath=legacyOperations ? process.env.BB_TELEGRAM_EMPLOYEE_PROFILE : undefined;
            const configured=profilePath!==undefined ? readEmployeeProfile(profilePath) : undefined;
            if (botId() && ownerId() && await handleConsentCallback(consentContext(signal), u)) {
              store.put("ingress:offset", u.update_id + 1);
              continue;
            }
            if (!legacyOperations && botId() && ownerId() && await handleSetupUpdate(await setupContext(signal), u)) {
              store.put("ingress:offset", u.update_id + 1);
              continue;
            }
            if (legacyOperations && profilePath !== undefined && configured && isEmployeeUpdate(store, botId() ?? 0, u, ownerId(), configured.settingsTitle,configured.personalGrants.map(g=>g.subject),configured.personalAccess?.subjects)) {
              const profile = () => {
                const current = readEmployeeProfile(profilePath);
                if (current.botId !== botId() || current.owner !== ownerId())
                  throw Error("employee_identity_mismatch");
                return current;
              };
              if (ownerId()) {
                profile(); // Configuration errors hold the update until the operator corrects them.
                const receipt = "employee:ingress:" + botId() + ":" + u.update_id;
                if (!store.get(receipt)) {
                  store.put(receipt, "started");
                  try {
                    await employeeUpdate(store, profile, u, chat => telegram(botToken, signal, 30000, () => chat, apiRoot));
                    store.atomic(()=>{store.put("ingress:offset",u.update_id+1);store.del(receipt);});
                  } catch {
                    // Keep only the update ID for operator reconciliation. An adapter may already have committed.
                    store.put(receipt, "unconfirmed");
                  }
                }
              }
              store.put("ingress:offset", u.update_id + 1);
              continue;
            }
            if (cfg.chatEnabled && await handleOwnerSelection(store,u,ownerId(),botId(),tg)) {
              store.put("ingress:offset",u.update_id+1);
              continue;
            }
            if (cfg.chatEnabled && acceptGroupUpdate(store, u, ownerId(), botId())) continue;
            const route = routeUpdate(u, ownerId(), store.get("pair:code"));
            if (route.kind === "pair") {
              if (profilePath!==undefined && route.userId!==readEmployeeProfile(profilePath).owner) {store.put("ingress:offset",u.update_id+1);continue;}
              store.put("owner:id", route.userId);
              store.del("pair:code");
              await tg("sendMessage", {
                text: translate(
                  cfg.language as "ru" | "en",
                  "✅ Бот привязан к BB. Темы проектов появятся в этом чате в течение минуты.",
                ) + "\n" + privacySummary(store, botId()!),
              });
              if(profilePath!==undefined) {
                const p=readEmployeeProfile(profilePath);
                if(p.botId===botId() && p.owner===route.userId)
                  await tg("sendMessage",employeeHome(store,p));
              } else if (!legacyOperations && botId()) {
                const setup=await setupContext(signal);
                if (setup.role) await tg("sendMessage",{chat_id:route.userId,...welcomeScreen({...setup,privacy:store.get<boolean>(privacyKey(botId()!))})});
              }
              wake?.();
            } else if (route.kind === "chat" && cfg.chatEnabled && bridge) {
              bridge.accept(route.input);
              chatWake?.();
            } else if (route.kind === "tasks")
              await tg("sendMessage", {
                message_thread_id: route.topicId || undefined,
                text: taskList(route.topicId, cfg.language as "ru" | "en"),
              });
            if ("callbackId" in route && route.callbackId)
              await tg("answerCallbackQuery", {
                callback_query_id: route.callbackId,
              }).catch(() => {});
            store.put("ingress:offset", u.update_id + 1);
          }
          if (botId() && ownerId() && store.list("visibility:"+botId()+":group:").length)
            await sendGroupVisibility();
        } catch (e) {
          if (signal.aborted) break;
          // telegram_409: another process still polls this bot.
          ingressError = safeError(e);
          await pause(10_000);
        }
      }
    },
  });
  bb.onDispose(async () => {
    clearInterval(historyTimer);
    clearInterval(inboxTimer);
    lifetime.abort();
    wake?.();
    await flight;
    await bridge?.dispose();
  });
}
