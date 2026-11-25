import {homedir} from "node:os";
import {ensureConversationProject,moveConversation,ownFolderProject,restoreConversation} from "./conversation-folder";
import {curators,addressedToAgent,leadRefusal,leadsByDefault,leadsByDefaultKey,LEAD_NOTE,leadsChat,NO_LEADER_LINE,noLeaderToldKey,setChatMode,canAssignLead,chatAgentsCheckedKey,curatorsKey,noteAgentsLeaving,refreshChatAgents,modeLine,otherAgentsInChat,setTopicMode,topicMode,type TopicMode} from "./topic-mode";
import {TOPIC_ACTIONS,topicRefusal,type TopicAction} from "./topic-command";
import {deliverScheduledResults} from "./group-schedule";
import {bbMentionsOn,bbText,type BbMentionsSetting} from "./bb-mentions";
import {learnTopicName,rememberForumName,describeForumTopic,inheritedForumPolicy,inheritableForumTopic,forumDefaults,forumDefaultsKey,forumOptOutKey,forumAutoOffKey,forumAutoKey,reviveArchivedForumTopic,type ForumDefaults} from "./forum-defaults";
import {handleDelegatedForumCommand} from "./forum-delegation";
import {applyForumTopicChange,handleOwnerForumCommand,missingRightRefusal} from "./forum-commands";
import {authorOfTurn,deleteLog,deleteRefusal} from "./delete-command";
import {topicStateKey,isTopicPaused} from "./topic-lifecycle";
import {acceptPrivateEmployeeUpdate,greetPendingApproved,privatePolicyKey} from "./employee-private";
import {basicGroupChats,groupMigration,migrateGroupChat} from "./group-migration";
import {FILE_REMOVED,archiveQuery,openArchive,voiceTranscripts,type Archive} from "./archive";
import {conversationOf,conversationOfThread,guardGroupMemory,movedConversationOf,movedConversationRefusal,readableChats} from "./archive-access";
import {closeAsk,findGroup,findPerson,findTopic,ownerReport,rememberAsk,sendRefusal,sendTargets,curatorTarget,conversationMayAttach} from "./send-command";
import {sendFormattedText,sendOutboundMessage} from "./outbound-message";
import {sameWords,sentInTurnKey} from "./group-worker";
import {maxAlbumItems,sendAlbum} from "./media-album";
import {renderTelegramParts} from "./telegram-ux";
import {acceptOwnerAskCallback,answerTurnText,askButtons,cleanQuestion,forwardOriginal,ownerQuestion,queueAnswerTurn,rememberAskMessage,turnMessageKey} from "./owner-ask";
import {sharedGroupThreads,sharedGroupThreadKey,sharedOwnerForum,groupThreadMatches} from "./group-binding";
import {maxImageBytes} from "./group-attachments";
import { checkOwnerForum, ownerPrivateTopicInput, ownerTopicInput, ownerTopicTool } from "./owner-topic";
import { privacyKey, privacySummary, rememberMembership, sendVisibilityUpdates } from "./group-visibility";
import {reconcileEmployeeTicket,employeeHome,employeeUpdate,isEmployeeUpdate,readEmployeeProfile,employeeWriteAllowed,employeeWriteCheck} from "./employee-policy";
import {proposalInput,presentProposal,handleOwnerSelection,collectDecisionResults,presentProjectProposals} from "./owner-selection";
import {groupFollowUpInput,bbReminderInput,isDirectOwnerRequest,resolveGroupMessage,inspectGroupTask,deliverGroupResults,groupResultInput,groupResultStatus,queueGroupResult,groupReminderInput,queueGroupReminder} from "./group-result";
import {groupExecutor} from "./isolated-client";
import {isolatedGroupInput,isolatedGroupResult,submitIsolatedGroup,isolatedLookup,isolatedAnswer,readIsolatedGroup,isolatedPdfInput,isolatedPdfPart,readIsolatedPdf,isolatedImageInput,isolatedImagePart,readIsolatedImage,isolatedDocumentInput,isolatedDocumentPart,readIsolatedDocument,validateIsolatedPurpose} from "./isolated-group";
import {cleanInbox} from "./inbox-retention";
import {allInboxes, inboxFor} from "./project-inbox";
import {openTopicSearch,historyPrefix,topicPassages} from "./topic-search";
import { transcribeWithVoiceRouter } from "./voice-router";
import {MAX_INCOMING_BYTES, maxRoutedDocumentBytes, openInboxDirs, safeTelegramFilename, saveLocalTelegramFile, setUploadLimit, telegramApiRoot as checkedApiRoot, uploadLimit } from "./telegram-files";
import { agencyIntegration, agencyDeliverySchema, agencyCapabilitySchema, agencyReceiptSchema } from "./agency-integration";
import { translate } from "./locale";
import { today, todayLine } from "./today";
import {
  preferencesSchema,
  diagnosisSchema,
  diagnose,
} from "./settings";
import {channelPost,channelPostSchema,inspectChannelRights} from "./channel-post";
import { bindGroupTopic, groupCliRestricted, groupTyping, processGroupInputs } from "./group-worker";
import {decideChooser,decideChoice,chooseTopicIcon,parseReactionOptions,type ReactionChooser,type ReactionOption} from "./turn-feedback";
/** С45: reaction choice from the settings, refreshed with them; the chat bridge and the group worker read it. */
let currentReactions:{chooser?:ReactionChooser;options:ReactionOption[]}={options:parseReactionOptions(),chooser:decideChooser()};
/** С58: the topic icon chooser (the same quick decision service); off with the topicIcons setting. */
let currentIconChooser:ReturnType<typeof decideChoice>|undefined=decideChoice();
const reactionsFrom=(c:{reactionChoice?:boolean;reactionSet?:string;decideCommand?:string;topicIcons?:boolean})=>
  (currentIconChooser=c.topicIcons===false ? undefined : decideChoice(c.decideCommand || "vallis-decide"),
  currentReactions={options:parseReactionOptions(c.reactionSet),
    ...(c.reactionChoice!==false ? {chooser:decideChooser(c.decideCommand || "vallis-decide")} : {})});
import { applyThreadTitles, rememberGroupTitle, threadTitlesPass } from "./thread-titles";
import { groupModelCommand } from "./group-model";
import { ChatBridge } from "./chat";
import { handoffDispatch } from "./handoff";
import { StateTransfer } from "./state-transfer";
import { acceptGroupUpdate, contextMediaPrefix, offsetForServer, routeUpdate, skipExcludedForumUpdate, unboundAddressedGroupMessage, type GroupTopicPolicy } from "./ingress";
import { accessList, accessModeKey, agentBots, agentBotsKey, installKindKey, groupSettings, hasAccess, migrateLegacyRights, saveGroupSettings, senderRole, setAccess } from "./rights";
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
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomInt } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  watch,
  mkdirSync,
  existsSync,
} from "node:fs";
import {
  telegram,
  sentMessages,
  transcribeTelegramVoice, downloadGroupImage, receiveCloudTelegramDocument,
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
  /** The last error with where and when; cleared by the next success in the same conversation. */
  chatLastError: z.object({ code: z.string(), topicId: z.number().optional(), threadId: z.string().optional(), at: z.string(),
    text: z.string() }).nullable().optional(),
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
  ownerNoMention: z.boolean().optional(), shortName: z.string().max(64).optional(),
});
export const rpcContract = defineRpcContract({
  // П28/С60: a plugin of this BB tells the owner something in their private chat, without a model turn.
  sendToOwner: {
    input: z.object({ text: z.string().min(1).max(16000), source: z.string().max(120).optional() }).strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().optional() }),
  },
  rightsAccess: { input: z.null(), output: z.array(personSchema) },
  rightsAccessSet: { input: z.object({ people: z.array(personSchema).max(200) }).strict(), output: z.array(personSchema) },
  rightsGroup: { input: z.object({ chatId: z.number().int() }).strict(), output: groupRightsSchema.nullable() },
  rightsGroupSet: {
    input: z.object({ chatId: z.number().int(), who: z.enum(["access", "all"]).optional(), reply: z.enum(["mention", "auto"]).optional(),
      members: z.enum(["silent", "read", "propose"]).optional(), zones: z.array(z.string().max(64)).max(50).optional(),
      note: z.string().max(500).optional(), ownerNoMention: z.boolean().optional(),
      shortName: z.string().max(64).optional() }).strict(),
    output: groupRightsSchema,
  },
  reconcileEmployeeTicket:{input:z.object({idempotencyKey:z.string().regex(/^[a-f0-9]{32}$/)}).strict(),output:z.object({state:z.string(),messageId:z.number().optional()})},
  checkEmployeeWrite:{input:employeeWriteCheck,output:z.object({allowed:z.boolean()})},
  readIsolatedPdf:{input:isolatedPdfInput,output:isolatedPdfPart},
  readIsolatedImage:{input:isolatedImageInput,output:isolatedImagePart},
  readIsolatedDocument:{input:isolatedDocumentInput,output:isolatedDocumentPart},
  readIsolatedGroup:{input:isolatedLookup,output:isolatedAnswer},
  submitIsolatedGroup:{input:isolatedGroupInput,output:isolatedGroupResult},
  submitIsolatedPrivate:{input:isolatedGroupInput,output:isolatedGroupResult},
  readIsolatedPrivate:{input:isolatedLookup,output:isolatedAnswer},
  readIsolatedPrivatePdf:{input:isolatedPdfInput,output:isolatedPdfPart},
  readIsolatedPrivateImage:{input:isolatedImageInput,output:isolatedImagePart},
  readIsolatedPrivateDocument:{input:isolatedDocumentInput,output:isolatedDocumentPart},
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
      ownerTopicManagerProjectId:z.string().min(1).max(160).optional(),
      addressName:z.string().trim().min(3).max(40).regex(/^[\p{L}][\p{L}\p{M} -]*[\p{L}\p{M}]$/u).optional(),
      deliverySources:z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)).max(100).optional(),
      allowedSenderIds:z.array(z.number().int().positive().safe()).max(100).optional(),includeTopicContext:z.boolean().optional(),searchableHistory:z.boolean().optional(),retainFullHistory:z.boolean().optional()}).strict(),
    output:z.object({bound:z.literal(true),warning:z.string().optional()}),
  },
  setForumTopicDefaults:{
    input:z.object({confirm:z.literal(true),chatId:z.number().int().negative(),sourceTopicId:z.number().int().min(2),
      enabled:z.boolean(),managers:z.array(z.number().int().positive().safe()).max(100).default([]),
      closeManagers:z.array(z.number().int().positive().safe()).max(100).optional(),
      deleteManagers:z.array(z.number().int().positive().safe()).max(100).default([])}).strict(),
    output:z.object({enabled:z.boolean()}),
  },
  unbindGroupTopic: {
    input:z.object({confirm:z.literal(true),chatId:z.number().int().negative(),topicId:z.number().int().nonnegative()}).strict(),
    output:z.object({removed:z.boolean()}),
  },
  // С76: an existing group (all its topics) or a person's chat moves from the owner's folder into its own one; the
  // previous threads keep their history and files and are told whom to hand open work to. restore — the way back.
  // For other plugins (case cards, С65): which Telegram chat and topic a thread (or its subthread) talks to; read only.
  // The owner's chat (topic 0) to a project, as /project does: the owner's first message starts the conversation (С102).
  bindOwnerChat:{
    input:z.object({projectId:z.string().min(1).max(160)}).strict(),
    output:z.object({changed:z.boolean(),projectId:z.string(),threadId:z.string().nullable()}),
  },
  conversationOf:{
    input:z.object({threadId:z.string().min(1).max(160)}).strict(),
    output:z.object({kind:z.enum(["owner","group","person"]),chatId:z.number(),topicId:z.number()}).nullable(),
  },
  moveConversationToFolder:{
    input:z.object({confirm:z.literal(true),chatId:z.number().int().safe(),dryRun:z.boolean().default(false)}).strict(),
    output:z.object({path:z.string().optional(),projectId:z.string().optional(),
      moved:z.array(z.object({topicId:z.number(),from:z.string(),to:z.string().optional(),
        schedules:z.object({moved:z.array(z.string()),left:z.array(z.string())}).optional()})),skipped:z.array(z.string())}),
  },
  restoreConversationFolder:{
    input:z.object({confirm:z.literal(true),chatId:z.number().int().safe()}).strict(),
    output:z.object({restored:z.array(z.object({topicId:z.number(),threadId:z.string(),
      schedules:z.object({moved:z.array(z.string()),left:z.array(z.string())}).optional()}))}),
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
      deliveryId:z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),providerId:z.string().min(1).optional(),model:z.string().min(1).optional(),
      urgent:z.boolean().optional()}).strict(),
    output:z.object({threadId:z.string()}),
  },
  /** Постоянная пара тредов чата: основной и резервный, переключение по лимиту. */
  configureChatPair: {
    input: z.object({topicId: z.number().int().nonnegative(), primaryThreadId: z.string().min(1),
      fallbackThreadId: z.string().min(1), name: z.string().trim().min(1).max(60).optional()}).strict(),
    output: z.object({configured: z.literal(true)}),
  },
  removeChatPair: {input: z.object({topicId: z.number().int().nonnegative()}).strict(), output: z.boolean()},
  chatPairStatus: {input: z.object({topicId: z.number().int().nonnegative()}).strict(), output: z.unknown()},
  switchChatThread: {
    input: z.object({topicId: z.number().int().nonnegative(), fromThreadId: z.string().min(1),
      toThreadId: z.string().min(1)}).strict(),
    output: z.unknown(),
  },
  setChildUrgency: {input: z.object({threadId: z.string().min(1), urgent: z.boolean()}).strict(), output: z.boolean()},
  clearChatPairLimit: {input: z.object({topicId: z.number().int().nonnegative(), threadId: z.string().min(1)}).strict(), output: z.boolean()},
  /** Решение владельца по треду, созданному помощником: перенести на действующую модель. */
  continueChildOnActive: {input: z.object({threadId: z.string().min(1), topicId: z.number().int().nonnegative().optional()}).strict(),
    output: z.object({threadId: z.string()})},
  /** Решение владельца «закрыть»: архив треда, созданного помощником (не удаление). */
  archiveAssistantThread: {input: z.object({threadId: z.string().min(1), topicId: z.number().int().nonnegative().optional()}).strict(),
    output: z.boolean()},
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
    isolatedPrivateProject:{type:"string",label:"Проект изолированного личного исполнителя",default:""},
    isolatedPrivateThread:{type:"string",label:"Тред изолированного личного исполнителя",default:""},
    employeePrivateRequests:{type:"boolean",label:"Запросы доступа в личке сотрудника",default:false},
    agentBots:{type:"string",label:"Боты агентов организации (Telegram ID через запятую): их сообщения в группах принимаются",default:""},
    agentChainLimit:{type:"number",label:"Сколько реплик агентов подряд без человека допустимо",default:12},
    leadsChatsByDefault:{type:"string",label:"Ведёт общие чаты по умолчанию (из паспорта сотрудника): yes — отвечает владельцу без отметки во всех темах без своего ведущего; no — по отметке; auto — yes, пока в списке нет других ботов организации",default:"auto"},
    curators:{type:"string",label:"Кураторы этого агента (Telegram ID через запятую): вместе с владельцем назначают его ведущим темы",default:""},
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
    bbMentions: {
      type: "select",
      label: "Ссылки и упоминания BB в Telegram (auto — по виду установки: помощник — да, сотрудник — нет)",
      options: ["auto", "on", "off"],
      default: "auto",
    },
    accessPermissionMode: {
      type: "select",
      label: "Режим хода для тех, кто может поручать (в группах)",
      options: ["auto", "full"],
      default: "auto",
    },
    archiveFileDays: {
      type: "number",
      label: "Сколько дней хранить файлы в памяти переписки (тексты — всегда; 0 — файлы тоже всегда)",
      default: 183,
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
    organizationName: {
      type: "string", label: "Название организации — так сотрудник называет её людям (С102; пусто — без названия)", default: "",
    },
    employeeName: {
      type: "string", label: "Имя сотрудника — так он называет себя людям (С102; пусто — без имени)", default: "",
    },
    employeeProject: {
      type: "string", label: "Проект сотрудника: к нему личка владельца привязывается сама, когда владелец привязывает бота (пусто — выбор через /project)", default: "",
    },
    conversationFoldersRoot: {
      type: "string", label: "Own folder for each group and person's chat (С76; empty: they share the owner's folder)", default: "",
    },
    conversationMoveEnabled: {
      type: "boolean", label: "Move existing groups into their own folders on command (С76; off on working installations until the owner's word)", default: false,
    },
    conversationRulesFile: {
      type: "string", label: "Rules of the agent's role for conversation folders (an absolute path)", default: "",
    },
    projectInboxRoots: {
      type: "string", label: "Received-file directory per project (proj_id=/path, comma separated; others use the shared one)", default: "",
    },
    voiceRouterPath: {
      type: "string", label: "Local voice router executable (empty: BB transcription)", default: "",
    },
    autoTopics: {
      type: "boolean", label: "New forum topics are picked up automatically (each gets its own thread); off — only bound topics", default: true,
    },
    topicIcons: {
      type: "boolean", label: "A new topic gets a fitting standard icon (vallis-decide); an icon set by a person is kept", default: true,
    },
    reactionChoice: {
      type: "boolean", label: "Reactions: a quick model picks the reaction (vallis-decide); off — 👀 only", default: true,
    },
    reactionSet: {
      type: "string", label: "Reactions to choose from: «👍=agreed; 😁=funny; …» (empty: the default set)", default: "",
    },
    decideCommand: {
      type: "string", label: "Quick decision command", default: "vallis-decide",
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
  let archive:Archive|undefined;
  try { archive=openArchive(db); } catch { archive=undefined; }
  let history:ReturnType<typeof openTopicSearch>|undefined;
  try { history=openTopicSearch(db); } catch(error) {
    if (!String(error).includes("no such module: fts5")) throw error;
  }
  const forgetExamples=db.prepare("DELETE FROM state WHERE (key GLOB 'group:recent-files:*' OR key GLOB 'group:context-media:*') AND json_extract(value,'$.expiresAt')<=?");
  const forgetCommands=db.prepare("DELETE FROM state WHERE key GLOB 'group:topic-command:*' AND json_extract(value,'$.expires')<=?");
  const forgetAlbums=db.prepare(`DELETE FROM state
    WHERE (key GLOB 'paired:album:*' OR key GLOB 'paired:album-copy:*' OR key GLOB 'paired:album-resend:*'
        OR key GLOB 'group:album:*' OR key GLOB 'group:album-warning:*'
        OR key GLOB 'private:album:*' OR key GLOB 'private:album-warning:*')
      AND json_extract(value,'$.expires')<=?`);
  const purgeHistory=()=>{history?.prune();forgetExamples.run(Date.now());forgetAlbums.run(Date.now());forgetCommands.run(Date.now()-7*86400_000);};
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
    atomicBusyExact(fn) {
      db.transaction(fn).immediate();
    },
  };
  const lifetime = new AbortController();
  let bridge: ChatBridge | undefined;
  // С103: the organization's time zone (the bridge's timeZone setting; empty — Europe/Moscow) for «today».
  let orgTimeZone = "";
  const todayOf = (chatId: number, topicId: number) => {
    const bot = botId();
    if (!bot || !archive) return "";
    return todayLine(today(archive.lastSent(bot, chatId, topicId), Date.now(), orgTimeZone));
  };
  // One dispatch handler for the whole bridge: a second registration could replace the first.
  let scheduleAccess: ((ctx: Parameters<typeof handoffDispatch>[1]) => Promise<{action: "reject"; message: string} | undefined>) | undefined;
  bb.experimental_hooks.on("message.dispatch", async ctx =>
    (await scheduleAccess?.(ctx)) ?? handoffDispatch(store, ctx) ?? bridge?.admitDispatch(ctx) ?? {action: "proceed"});
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
  let nextUpgradeCheck = 0;
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
  sentMessages.observe=(message)=>{ const bot=botId(); if (bot) archive?.record(bot,{message}); };
  voiceTranscripts.observe=(chat,message,transcript)=>{ const bot=botId(); if (bot) archive?.transcript(bot,chat,message,transcript); };
  // One reading tool for the conversation archive. The calling conversation comes from the thread
  // BB names for this call; what it may read is decided in archive-access.ts.
  const archiveToolInput=archiveQuery.extend({
    message:z.object({chat:z.number().int().optional(),message:z.number().int().positive()}).strict().optional()
      .describe("One message by its number (С81): the text of the message someone answered to. Chat defaults to this conversation's chat."),
    file:z.object({chat:z.number().int(),message:z.number().int().positive()}).strict().optional()
      .describe("Download the file of one found message (chat and message from a search result). Returns a local path; open it with your usual tools."),
  }).strict();
  // The same reading for the agent tool and for the plugin command: a thread started before an
  // update does not get new agent tools, but every thread can run the command.
  async function readArchive(args:z.infer<typeof archiveToolInput>,threadId:string,signal:AbortSignal) {
      const owner=ownerId(),bot=botId();
      if (!owner || !bot || !archive) throw Error("archive_unavailable");
      const conversation=await conversationOf(store,bb.sdk.threads,threadId,signal);
      if (!conversation) {
        const moved=await movedConversationOf(store,bb.sdk.threads,threadId,signal);
        throw Error(moved ? movedConversationRefusal(moved,movedTitle(moved.chatId)) : "telegram_conversation_required");
      }
      const readable=readableChats(store,archive,bot,owner,conversation);
      const cfg=await settings.get();
      if (args.message) {
        const chat=args.message.chat ?? (conversation.kind==="group" ? conversation.chat : conversation.kind==="person" ? conversation.subject : owner);
        if (!readable(chat)) throw Error("not_available_in_this_conversation");
        const found=archive.message(bot,chat,args.message.message);
        // The message is not in the conversation's memory (older than it, another bot's, archive off): say so plainly,
        // so the agent asks the person instead of guessing.
        if (!found) {
          const saved=store.get<string|{t:string}>(`reply:quote:${chat}:${args.message.message}`);
          const quote=typeof saved==="string" ? saved : saved?.t;
          return JSON.stringify(quote ? {message:args.message.message,quote,
            note:"Текста в памяти переписки нет, цитата из Telegram (до 200 знаков)."} :
            {message:args.message.message,unavailable:true,
              note:"Текст исходного сообщения недоступен. Спроси человека, о каком сообщении речь, — не угадывай."});
        }
        return JSON.stringify(found);
      }
      if (args.file) {
        if (!readable(args.file.chat)) throw Error("not_available_in_this_conversation");
        const f=archive.file(bot,args.file.chat,args.file.message);
        if (f?.file_removed) throw Error(FILE_REMOVED);
        if (!f?.file_id) throw Error("message_has_no_file");
        const inboxRoot=await inboxOf(threadId,cfg);
        if (!inboxRoot) throw Error("inbox_not_configured");
        const info=await telegram(botToken,signal,60_000,undefined,apiRoot)<{file_path?:string}>("getFile",{file_id:f.file_id});
        if (!info.file_path) throw Error("file_unavailable");
        const dir=join(inboxRoot,"archive",String(bot),String(args.file.chat),String(args.file.message));
        await openInboxDirs(inboxRoot,dir);
        const name=safeTelegramFilename(f.file_name || info.file_path.split("/").at(-1) || "file");
        const path=join(dir,name);
        if (checkedApiRoot(await apiRoot())!=="https://api.telegram.org") {
          // A local Telegram server keeps the file on disk and returns its absolute path: copy it with the usual checks.
          if (!cfg.telegramLocalRoot) throw Error("attachment_local_api_required");
          const saved=await saveLocalTelegramFile({sourcePath:info.file_path,localRoot:cfg.telegramLocalRoot,inboxRoot:dir,inboxBase:inboxRoot,
            threadId,updateId:args.file.message,fileId:f.file_id,name,expectedBytes:f.file_size||undefined,signal});
          return JSON.stringify({path:saved.path,name,kind:f.file_kind,size:f.file_size});
        }
        const res=await fetch(`${checkedApiRoot(await apiRoot())}/file/bot${await botToken()}/${info.file_path}`,{signal});
        if (!res.ok) throw Error("file_download_failed");
        await writeFile(path,Buffer.from(await res.arrayBuffer()),{mode:0o640});
        await chmod(path,0o640);
        return JSON.stringify({path,name,kind:f.file_kind,size:f.file_size});
      }
      const {file:_file,...query}=args;
      return JSON.stringify({messages:archive.find(bot,readable,query,safeTimeZone(cfg.timeZone))});
  }
  bb.agents.registerTool({
    name:"telegram_conversation_archive",
    description:"Read the saved Telegram conversation: earlier messages of this chat and its topics, and of the other chats this conversation may see. "+
      "Use it whenever someone refers to something said or sent earlier (\"as we discussed\", \"the file from this morning\", \"in the other topic\"), instead of asking to resend. "+
      "Search by words (case, «ё», small typos and Latin/Cyrillic spelling do not matter), by author, by period with a time zone, the last N messages, or files only; then download a file by chat and message. "+
      "Other people's private chats are never returned.",
    parameters:archiveToolInput,
    async execute(args,{threadId,signal}) { return readArchive(args,threadId,signal); },
  });
  // A schedule set up in a group or a person's private chat runs only while that conversation still has access.
  scheduleAccess=async ctx=>{
    if (ctx.originPluginId!=="automations") return undefined;
    const owner=ownerId(),bot=botId();
    if (!owner || !bot) return undefined;
    const ids=[ctx.thread.id,...(ctx.thread.parentThreadId ? [ctx.thread.parentThreadId] : [])];
    const closed=ids.some(id=>store.get("conversation:closed:"+id));
    const conv=ids.map(id=>conversationOfThread(store,id)).find(Boolean);
    const gone=closed || (conv?.kind==="group" && !store.get(`visibility:${bot}:group:${conv.chat}`)) ||
      (conv?.kind==="person" && !hasAccess(store,bot,owner,conv.subject));
    if (!gone) return undefined;
    const told="conversation:schedule-refused:"+ctx.thread.id;
    if (!store.get(told)) {
      store.put(told,Date.now());
      await telegram(botToken,new AbortController().signal,15_000,ownerId,apiRoot)("sendMessage",{chat_id:owner,
        text:`Расписание в разговоре «${ctx.thread.title ?? ctx.thread.id}» не запущено: у этого разговора больше нет доступа.`}).catch(()=>{});
    }
    return {action:"reject" as const,message:"This conversation no longer has access; its schedules do not run."};
  };
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
    description:"Schedule one follow-up turn of this employee for the current Telegram group task. At dueAt the employee itself re-reads the topic and its tools and answers under the original message, or stays silent with NO_REPLY. Use only when the person who wrote this group request (the owner or a member allowed to call you here) asked for a later check.",
    parameters:groupFollowUpInput,
    async execute(args,{threadId}) {
      const owner=ownerId(),bot=botId();
      if (!owner || !bot || !bridge || stateTransferBusy) throw Error("bot_unavailable");
      const policyKey=store.get<string>("group:thread:"+threadId);
      const origin=store.get<{threadId:string;sender:number;owner:number;bot:number}>("group:origin:"+args.taskId);
      // Anyone who may call the bot in this group may ask for a later check here, not only the owner.
      const chat=store.get<GroupTopicPolicy>(policyKey ?? "")?.chatId;
      if (!policyKey || !origin || origin.threadId!==threadId || origin.owner!==owner || origin.bot!==bot || chat===undefined ||
          senderRole(store,bot,owner,chat,origin.sender)==="none")
        throw Error("group_request_required");
      const active=store.list<{taskId?:string;state:string;ownerId:number;route:{threadId:string;senderId:number}}>(`group:in:${bot}:`)
        .some(({value:j})=>j.taskId===args.taskId && j.state==="submitted" && j.ownerId===owner &&
          j.route.threadId===threadId && j.route.senderId===origin.sender);
      if (!active) throw Error("group_request_required");
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
  const forumCheck=(owner:number,bot:number,signal:AbortSignal)=>(chatId:number)=>
    checkOwnerForum(telegram(botToken,signal,15_000,()=>chatId,apiRoot),chatId,owner,bot,{shared:true}).then(()=>{});
  const forumCurrent=(owner:number,bot:number)=>()=>ownerId()===owner && botId()===bot && !stateTransferBusy;
  const reviveForumTopic=(owner:number,bot:number,signal:AbortSignal,topic:NonNullable<ReturnType<typeof describeForumTopic>>)=>
    reviveArchivedForumTopic(store,{owner,bot,check:forumCheck(owner,bot,signal),current:forumCurrent(owner,bot),
      threads:bb.sdk.threads as never,signal,bind:(policy,projectId)=>bindGroupTopic(store,policy,projectId)},topic);
  // Agents in chats: which bots of the organization are in a group — asked of Telegram once a day per chat and again
  // when a bot joins or leaves, so a colleague that never wrote counts too.
  async function checkChatAgents(update:unknown,signal:AbortSignal) {
    const me=botId();
    const m=(update as {message?:any;edited_message?:any})?.message ?? (update as {edited_message?:any})?.edited_message;
    const chat=m?.chat?.id;
    if (!me || !Number.isSafeInteger(chat) || chat>=0 || !agentBots(store).length) return;
    if (m.left_chat_member) noteAgentsLeaving(store,me,chat,m,agentBots(store));
    if (m.new_chat_members || m.left_chat_member) store.del(chatAgentsCheckedKey(me,chat));
    await refreshChatAgents(store,me,chat,agentBots(store),
      user=>telegram(botToken,signal,5_000,()=>chat,apiRoot)("getChatMember",{chat_id:chat,user_id:user}) as never).catch(()=>false);
  }
  async function inheritForumTopic(owner:number,bot:number,signal:AbortSignal,update:unknown) {
    const topic=describeForumTopic(store,bot,owner,update);
    if (topic?.policy && !topic.service) {
      await reviveForumTopic(owner,bot,signal,topic);
      return false;
    }
    const candidate=inheritableForumTopic(store,bot,owner,topic);
    if (!topic || !candidate) return topic?.service??false;
    const {chat,topic:topicId}=topic;
    const {source,metadata}=candidate;
    // Agents in chats (item 3): an agent nobody called costs nothing.
    const firstMessage=(update as {message?:any})?.message;
    // An agent that does not lead the chat (passport: not by default, or another leader named) gets a topic's
    // conversation only at the first message addressed to it; the chat's leader picks topics up as before (С54).
    if (!leadsChat(store,bot,chat) && !addressedToAgent(firstMessage,bot,source.botUsername,source.addressName)) return topic.service;
    const executor=source.isolated?groupExecutor(chat,topicId,true):undefined;
    if (source.isolated && (!executor || executor.threadId===source.threadId || executor.projectId===source.projectId)) return topic.service;
    const targetKey=`group:policy:${chat}:${topicId}`;
    const journal=`group:forum-provision:${bot}:${chat}:${topicId}`;
    if (store.get(journal)) return topic.service;
    const current=()=>{
      const live=forumDefaults(store,bot,owner,chat)?.source;
      return ownerId()===owner && botId()===bot && !stateTransferBusy &&
        live?.revision===source.revision && live?.threadId===source.threadId &&
        !store.get(targetKey) &&
        !!inheritableForumTopic(store,bot,owner,topic);
    };
    let projectId=executor?.projectId,threadId=executor?.threadId;
    if (source.ownerSharedProject || !source.isolated) {
      // С54: a shared owner topic and an ordinary local topic get a new thread next to the template's thread.
      if (source.ownerSharedProject) await checkOwnerForum(telegram(botToken,signal,15_000,()=>chat,apiRoot),chat,owner,bot,{shared:true});
      const sourceThread=await bb.sdk.threads.get({threadId:source.threadId,signal});
      if (!sourceThread.environmentId || sourceThread.projectId!==source.projectId || sourceThread.visibility!=="visible" ||
          sourceThread.archivedAt || sourceThread.deletedAt || sourceThread.parentThreadId || !current()) return topic.service;
      store.put(journal,"spawning");
      const child=await bb.sdk.threads.spawn({projectId:sourceThread.projectId,visibility:"visible",
        title:metadata.name,permissionMode:"accept-edits",
        environment:{type:"reuse",environmentId:sourceThread.environmentId},
        ...(sourceThread.providerId && {providerId:sourceThread.providerId}),
        input:[{type:"text",visibility:"agent-only",mentions:[],
          text:"Initialize an empty Telegram topic conversation. Wait for a Telegram request and reply NO_REPLY."}]});
      if (child.projectId!==source.projectId || child.id===source.threadId) throw Error("forum_topic_thread_unconfirmed");
      projectId=child.projectId;threadId=child.id;
    }
    if (current() && projectId && threadId) {
      const policy=inheritedForumPolicy(source,topicId,{threadId,projectId},crypto.randomUUID());
      bindGroupTopic(store,policy,projectId);
      store.del(journal);
      void applyThreadTitles(store,bb.sdk,bot,chat).catch(()=>{});   // С66: «<тема> — группа «…»»
      // С58: only on the topic's creation message, and only when it has no icon yet — a person's icon is kept.
      const created=(update as {message?:{forum_topic_created?:{name?:string;icon_custom_emoji_id?:string}}})?.message?.forum_topic_created;
      if (created) void chooseTopicIcon(telegram(botToken,signal,15_000,()=>chat,apiRoot),chat,topicId,
        created.name ?? metadata.name,created.icon_custom_emoji_id,currentIconChooser,signal);
    }
    return topic.service;
  }
  async function forumCommand(owner:number,bot:number,signal:AbortSignal,update:unknown) {
    activeTelegramWrites++;
    try {
      const since=store.get<number>("group:forum-command-since:"+bot);
      if (since===undefined) return false;
      const delegated=await handleDelegatedForumCommand({
        store,owner,bot,signal,since,
        transport:chatId=>telegram(botToken,signal,15000,()=>chatId,apiRoot),
        current:()=>!!bridge && ownerId()===owner && botId()===bot && !stateTransferBusy,
        create:createOwnerTopic,
      },update);
      if (delegated) return true;
      return await handleOwnerForumCommand({
        store,owner,bot,signal,since,
        transport:chatId=>telegram(botToken,signal,15000,()=>chatId,apiRoot),
        binding:topicId=>{
          const b=bridge?.bindings().find(row=>row.topicId===topicId);
          return b?.threadId ? {threadId:b.threadId,projectId:b.projectId} : undefined;
        },
        current:()=>!!bridge && ownerId()===owner && botId()===bot && !stateTransferBusy,
        create:createOwnerTopic,
      },update);
    } finally {activeTelegramWrites--;}
  }
  bb.agents.registerTool({
    name:"telegram_create_owner_topic",
    description:"Create a topic in the same connected Telegram forum and post its first message. In a work forum, connecting an executor is a separate administrative step. Use only if the paired owner explicitly requested a new topic in this current group task and gave its title. Copy the title from their request. Supply text only if the owner specified the exact first message; otherwise the bridge posts a fixed confirmation. A confirmed receipt may be repeated; do not retry an unconfirmed mutation or send the first message through another tool.",
    parameters:ownerTopicInput,
    async execute(args,ctx) {
      activeTelegramWrites++;
      try { return JSON.stringify(await createOwnerTopic(args,ctx)); }
      finally { activeTelegramWrites--; }
    },
  });
  bb.agents.registerTool({
    name:"telegram_create_private_forum_topic",
    description:"From a current direct Telegram request by the paired owner, create a topic in a configured owner forum or a work forum delegated to this project. If several forums are available, the owner must explicitly give the exact forum name or a private forum link, and the forum argument must copy it. If selection is required or ambiguous, ask which forum and wait for the owner's answer. Use only for an explicit instruction to create a topic. Copy the exact topic title and any exact first message. Otherwise a fixed confirmation is used. Pass the current Telegram route token.",
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
  async function assertTelegramThreadHost(threadId:string,fileHostId:string) {
    const thread=await bb.sdk.threads.get({threadId});
    if (!thread.environmentId || !fileHostId) throw Error("attachment_wrong_host");
    const env=await bb.sdk.environments.get({environmentId:thread.environmentId});
    if (env.hostId!==fileHostId) throw Error("attachment_wrong_host");
  }
  async function inboxOf(threadId:string,c:{telegramInboxRoot:string;projectInboxRoots?:string}) {
    if (!c.projectInboxRoots) return c.telegramInboxRoot;
    const thread=await bb.sdk.threads.get({threadId}).catch(()=>undefined);
    return inboxFor(c.projectInboxRoots,c.telegramInboxRoot,thread?.projectId);
  }
  async function receiveLocalFile(incoming:{fileId:string;name:string;size:number},updateId:number,
    threadId:string,fileSignal:AbortSignal,scope?:string[],isolated=false,maxBytes?:number) {
    const c = await settings.get();
    const inboxRoot = await inboxOf(threadId,c);
    if (checkedApiRoot(c.telegramApiRoot) === "https://api.telegram.org" ||
        !c.telegramLocalRoot || !inboxRoot)
      throw Error("attachment_local_api_required");
    if (!isolated) await assertTelegramThreadHost(threadId,c.telegramFileHostId);
    if (incoming.size > 2 * 1024 * 1024 * 1024) throw Error("attachment_too_large");
    const tg = telegram(botToken, fileSignal, 30 * 60 * 1000, ownerId, apiRoot);
    const file = await tg("getFile", {file_id:incoming.fileId});
    if (typeof file.file_path !== "string") throw Error("attachment_file_invalid");
    return saveLocalTelegramFile({sourcePath:file.file_path,
      localRoot:c.telegramLocalRoot, inboxRoot:scope ? join(inboxRoot,...scope) : inboxRoot, inboxBase:inboxRoot,
      threadId:isolated ? "isolated:"+threadId : threadId, updateId:updateId, fileId:incoming.fileId, name:incoming.name,
      expectedBytes:incoming.size || undefined, maxBytes, signal:fileSignal});
  }
  async function receiveCloudImage(file:import("./ingress").GroupExample,signal:AbortSignal) {
    if (!file.image || file.document || checkedApiRoot(await apiRoot())!=="https://api.telegram.org") return;
    if (file.size>maxImageBytes) throw Error("attachment_too_large");
    const getFile=telegram(botToken,signal,30_000,undefined,apiRoot);
    const info=await getFile<import("./adapters").CloudFile>("getFile",{file_id:file.fileId});
    if (info.file_id!==file.fileId) throw Error("attachment_invalid_image");
    return downloadGroupImage(botToken,info,file.size,signal);
  }
  async function receiveCloudDocument(file:import("./ingress").GroupExample,updateId:number,
    threadId:string,scope:string[],signal:AbortSignal) {
    const c=await settings.get();
    const inboxRoot=await inboxOf(threadId,c);
    if (checkedApiRoot(c.telegramApiRoot)!=="https://api.telegram.org" || !inboxRoot) return;
    const configuredToken=await botToken();
    const requestToken=async()=>configuredToken;
    const getFile=telegram(requestToken,signal,30_000,undefined,async()=>"https://api.telegram.org");
    if (file.size>maxRoutedDocumentBytes) throw Error("attachment_too_large");
    return receiveCloudTelegramDocument(requestToken,await getFile("getFile",{file_id:file.fileId}),{
      ...file,updateId,threadId:"isolated:"+threadId,inboxRoot:join(inboxRoot,...scope),inboxBase:inboxRoot,signal,
    },fetch,!!file.pdf);
  }
  async function receiveGroupFile(file:import("./ingress").GroupExample,
    route:Extract<import("./ingress").Ingress,{kind:"group"}>, signal:AbortSignal,bot:number) {
    const cloud=await receiveCloudImage(file,signal);
    if (cloud) return cloud;
    const policy=store.get<import("./ingress").GroupTopicPolicy>(`group:policy:${route.chatId}:${route.topicId}`);
    const scope=["groups",String(bot),String(route.chatId),String(route.topicId),String(route.senderId)];
    if (file.pdf && policy?.isolated!==true)
      await assertTelegramThreadHost(route.threadId,(await settings.get()).telegramFileHostId);
    const document=await receiveCloudDocument(file,file.sourceUpdateId??route.updateId,route.threadId,scope,signal);
    if (document) return document;
    return receiveLocalFile(file,file.sourceUpdateId??route.updateId,route.threadId,signal,scope,
      policy?.isolated===true,file.image && !file.document ? maxImageBytes : policy?.isolated===true ? maxRoutedDocumentBytes : MAX_INCOMING_BYTES);
  }
  // Every conversation of an employee is an ordinary thread in its own project: the same
  // environment, agent and instructions as the owner's private chat. A person's private chat and
  // each group topic get one thread, created on first use.
  // The rules in force from the platform plugin (0.4.4); a platform without them (older version) gives nothing.
  // Platform 0.4.7: the employee's pause; an older platform has no such call — not paused.
  async function pausedOf() {
    return (await bb.sdk.plugins.callRpc({pluginId:"personal-assistant",method:"pauseStatus",input:{},
      outputSchema:z.object({paused:z.boolean(),since:z.number().nullable()})}).catch(()=>null))?.paused===true;
  }
  /** С: a group's or a person's conversation may attach only its own chat's received files and its own tasks' results. */
  async function insideConversationFolder(threadId:string,path:string,caller:import("./archive-access").Conversation) {
    try {
      const bot=botId(); if (!bot || caller.kind==="owner") return true;
      const chat=caller.kind==="group" ? caller.chat : caller.subject;
      const real=await realpath(path);
      const cfg=await settings.get();
      const inboxRoots=(await Promise.all(allInboxes(cfg.projectInboxRoots,cfg.telegramInboxRoot).map(r=>realpath(r).catch(()=>"")))).filter(Boolean);
      const policy=store.get<import("./ingress").GroupTopicPolicy>(`group:policy:${chat}:${caller.kind==="group" ? caller.topic ?? 0 : 0}`);
      const threads=new Set([threadId,policy?.threadId].filter((t):t is string=>!!t));
      const taskDirs:string[]=[];
      for (const t of threads) {
        const thread=await bb.sdk.threads.get({threadId:t}).catch(()=>undefined) as {environmentId?:string|null}|undefined;
        const env=thread?.environmentId ? await bb.sdk.environments.get({environmentId:thread.environmentId}).catch(()=>undefined) as {path?:string}|undefined : undefined;
        const root=env?.path ? await realpath(env.path).catch(()=>"") : "";
        if (!root) continue;
        for (const {key,value} of store.list<{threadId?:string}>("group:origin:"))
          if (value.threadId && threads.has(value.threadId)) taskDirs.push(`${root}/outputs/${key.slice("group:origin:".length,"group:origin:".length+8)}`);
      }
      if (conversationMayAttach(real,{inboxRoots,bot,chat,taskDirs})) return true;
      // A run without a task number (a schedule from the group): a file under outputs/ made during this very turn.
      const started=(await bb.sdk.threads.events.list({threadId,order:"desc",limit:"1",types:["turn/started"]}))[0] as {createdAt?:number}|undefined;
      const thread=await bb.sdk.threads.get({threadId}).catch(()=>undefined) as {environmentId?:string|null}|undefined;
      const env=thread?.environmentId ? await bb.sdk.environments.get({environmentId:thread.environmentId}).catch(()=>undefined) as {path?:string}|undefined : undefined;
      const outputs=env?.path ? (await realpath(env.path).catch(()=>""))+"/outputs/" : "";
      if (!outputs || !real.startsWith(outputs) || !started?.createdAt) return false;
      return (await stat(real)).mtimeMs>=started.createdAt-1000;
    } catch { return false; }
  }
  /** Where this conversation's file should go to be sent: the current task's folder, or outputs/ during this turn. */
  async function sendableDir(threadId:string) {
    const thread=await bb.sdk.threads.get({threadId}).catch(()=>undefined) as {environmentId?:string|null}|undefined;
    const env=thread?.environmentId ? await bb.sdk.environments.get({environmentId:thread.environmentId}).catch(()=>undefined) as {path?:string}|undefined : undefined;
    const base=(env?.path ?? "")+"/outputs/";
    const job=store.list<{route?:{threadId?:string};taskId?:string;state?:string}>("group:in:").map(r=>r.value)
      .find(j=>j.route?.threadId===threadId && j.taskId && j.state==="submitted");
    return job?.taskId ? base+job.taskId.slice(0,8)+"/" : base+" (новый файл, созданный в этом ходе)";
  }
  async function turnRulesOf(projectId:string) {
    return bb.sdk.plugins.callRpc({pluginId:"personal-assistant",method:"turnRules",input:{projectId},
      outputSchema:z.object({version:z.string(),text:z.string()}).nullable()}).catch(()=>null);
  }
  // С43/С67: the owner's answer to a question from another conversation comes to that conversation as a turn.
  async function deliverOwnerAnswer(ask:import("./send-command").Ask,answer:string,via:"button"|"text",who?:string) {
    const bot=botId(), owner=ownerId();
    if (!bot || !owner || !answer.trim()) return false;
    // П28: an ordinary thread asked — the answer comes to it as a turn.
    if (ask.originThread) {
      await bb.sdk.threads.send({threadId:ask.originThread,mode:"queue-if-active",input:[{type:"text",mentions:[],
        text:answerTurnText(ask,answer.trim(),via,who).split("\n").slice(0,2).join("\n")+"\nЭто ответ самого владельца. Продолжи дело по нему."}]});
      closeAsk(store,bot,ask.id);
      return true;
    }
    const sender=ask.target===owner ? {id:owner,name:"Владелец"} : {id:ask.target,name:who ?? "Собеседник"};
    if (queueAnswerTurn(store,bot,owner,ask,answerTurnText(ask,answer.trim(),via,who),sender)) {
      closeAsk(store,bot,ask.id); chatWake?.(); return true;
    }
    // Without the original message (an older question) the answer still reaches the conversation as a turn.
    const threadId=store.get<GroupTopicPolicy>(`group:policy:${ask.origin.chat}:${ask.origin.topic}`)?.threadId;
    if (!threadId) return false;
    await bb.sdk.threads.send({threadId,mode:"queue-if-active",input:[{type:"text",mentions:[],
      text:answerTurnText(ask,answer.trim(),via,who)+"\nОтветь человеку явной отправкой (bb telegram-projects send …)."}]});
    closeAsk(store,bot,ask.id);
    return true;
  }
  // С62: the person's conversation writes first after approval: a greeting, then the agent finds out what the person needs.
  async function greetPerson(subject:number,name:string,talkedBefore:boolean,late=false) {
    const threadId=store.get<GroupTopicPolicy>(`group:policy:${subject}:0`)?.threadId;
    if (!threadId) return false;
    const who=name || "этот человек";
    await bb.sdk.threads.send({threadId,mode:"queue-if-active",input:[{type:"text",mentions:[],text:[
      `Владелец открыл личку с тобой человеку: ${who}.`,
      talkedBefore
        ? "Вы уже переписывались. Если о себе и своих возможностях ты ему ещё не рассказывал — напиши одно короткое сообщение: кто ты и с чем можешь помочь, своими словами. Если рассказывал — ничего не отправляй."
        : "Напиши ему первым одно короткое сообщение: приветствие, кто ты и с чем можешь помочь, своими словами, и спроси, что ему нужно от этой лички.",
      `Отправка: bb telegram-projects send --person ${subject} --text "…" (без неё сообщение до него не дойдёт).`,
      "Затем доведи разговор: выясни, что ему нужно, и помоги. Отдельное расписание для этого не ставь.",
    ].join("\n")}]});
    return true;
  }
  async function handOverNotices(from:string,to:string,chatId:number,topicId:number,
    schedules?:{moved:string[];left:string[]},label?:string) {
    // The thread's own title already names the place («<тема> — группа «…»»); otherwise the group's remembered title.
    const place=label ? "«"+label+"»" : "«"+(movedTitle(chatId) ?? "группа")+"»"+(topicId ? ", тема "+topicId : "");
    const service=(text:string)=>[{type:"text" as const,mentions:[],text:"[Мост Telegram] "+text+" Отвечать на это не нужно."}];
    await bb.sdk.threads.send({threadId:from,mode:"queue-if-active",input:service(
      `Разговор ${place} теперь ведёт тред ${to}. Отсюда отправка в этот чат и список адресатов недоступны. `+
      `Незаконченное по этому чату передай туда: bb thread tell ${to} '…' (что сделать и где лежит результат).`+
      (schedules?.moved.length ? ` Расписания этого треда перенесены туда: ${schedules.moved.join(", ")}.` : "")+
      (schedules?.left.length ? ` Расписания ${schedules.left.join(", ")} перенести не удалось — перенеси сам: bb automation update <id> --target-thread ${to}.` : ""))}).catch(()=>undefined);
    await bb.sdk.threads.send({threadId:to,mode:"queue-if-active",input:service(
      `Этот тред теперь ведёт разговор ${place}. Прежний тред — ${from}: в нём история и, возможно, незаконченные дела и результаты этого чата; при необходимости сверься с ним (bb thread show ${from}).`)}).catch(()=>undefined);
  }
  const movedTitle=(chat:number)=>store.get<{title?:string}>(`visibility:${botId()}:group:${chat}`)?.title;
  // С76: the enabled schedules aimed at one thread are aimed at another (a move into a folder and its way back).
  async function moveThreadSchedules(from:string,to:string,fallbackProject:string) {
          const list=await bb.sdk.plugins.callRpc({pluginId:"automations",method:"automations_list",input:{targetThreadId:from},
            outputSchema:z.array(z.object({id:z.string(),projectId:z.string().optional(),enabled:z.boolean().optional()}).passthrough())});
          const out={moved:[] as string[],left:[] as string[]};
          for (const a of list) {
            const ok=await bb.sdk.plugins.callRpc({pluginId:"automations",method:"automations_update",
              input:{projectId:a.projectId ?? fallbackProject,automationId:a.id,agent:{target:{type:"target-thread",threadId:to}}},
              outputSchema:z.unknown()}).then(()=>true,()=>false);
            (ok ? out.moved : out.left).push(a.id);
          }
          return out;
        }
  /** The owner's private chat binding (topic 0): its project is the owner's folder; another binding only as a fallback. */
  const ownerBinding=()=>{
    const own=store.get<{projectId?:string;threadId?:string}>("chat:binding:0");
    if (own?.threadId && own.projectId) return own as {projectId:string;threadId:string};
    // The owner's chat may be bound to the project with no conversation yet (a new chat, or bound by the installer):
    // conversations of groups and people still go to that very project, never to another topic's.
    if (own?.projectId) return {projectId:own.projectId} as {projectId:string;threadId?:string};
    return store.list<{projectId:string;threadId?:string}>("chat:binding:").map(row=>row.value).find(v=>v.threadId && v.projectId);
  };
  async function bindConversation(owner:number,bot:number,c:{chatId:number;topicId:number;title:string;
    privateChat?:boolean;allowedSenderIds?:number[];acceptAfterSecond?:number},signal:AbortSignal) {
    if (store.get(`group:policy:${c.chatId}:${c.topicId}`)) return true;
    const dm=ownerBinding();
    const botUsername=store.get<string>("bot:username");
    if (!dm?.projectId || !botUsername) return false;
    const reserve="employee:conversation:thread:"+bot+":"+c.chatId+":"+c.topicId;
    const prior=store.get<{at:number;threadId?:string}>(reserve);
    let threadId=prior?.threadId;
    if (!threadId) {
      // An unconfirmed spawn is not repeated for ten minutes, so one conversation never gets two threads.
      if (prior && Date.now()-prior.at<10*60_000) return false;
      // Next to the owner's conversation when there is one; otherwise in the project's own environment.
      const source=dm.threadId ? await bb.sdk.threads.get({threadId:dm.threadId,signal}) : undefined;
      if (dm.threadId && (!source?.environmentId || source.projectId!==dm.projectId)) return false;
      store.put(reserve,{at:Date.now()});
      // A folder that cannot be made keeps the conversation unbound (retried in ten minutes), never in the owner's folder.
      const own=await ownConversationProject(dm.projectId,c).catch(error=>{
        console.warn("[telegram-projects] С76: conversation folder:",error?.message ?? error);
        return null;
      });
      if (own===null) return false;
      const projectId=own ?? dm.projectId;
      const thread=await bb.sdk.threads.spawn({projectId,title:c.title,
        visibility:"visible",permissionMode:"accept-edits",
        input:[{type:"text",visibility:"agent-only",mentions:[],
          text:"This thread is the Telegram conversation «"+c.title+"». Wait for a request. Reply with NO_REPLY, without using tools."}],
        environment:own || !source ? {type:"project-default"} : {type:"reuse",environmentId:source.environmentId!},
        ...(source?.providerId && {providerId:source.providerId})});
      if (!thread.id || thread.projectId!==projectId) return false;
      threadId=thread.id;
      store.put(reserve,{at:Date.now(),threadId,...(own && {projectId:own})});
    }
    const projectId=store.get<{projectId?:string}>(reserve)?.projectId ?? dm.projectId;
    if (owner!==ownerId() || bot!==botId() || stateTransferBusy) return false;
    bindGroupTopic(store,{chatId:c.chatId,topicId:c.topicId,threadId,
      ...(c.privateChat ? {privateChat:true as const} : {inOwnerProject:true as const}),
      ...(projectId!==dm.projectId && {ownFolder:true as const}),
      ownerOnly:!!c.privateChat,allowedSenderIds:c.allowedSenderIds,requireMention:!c.privateChat,
      includeTopicContext:true,searchableHistory:true,retainFullHistory:true,
      ...(c.acceptAfterSecond!==undefined && {acceptAfterSecond:c.acceptAfterSecond}),
      botId:bot,botUsername,ownerId:owner,revision:crypto.randomUUID()},projectId);
    return true;
  }
  /** С76: the conversation's own folder and project, when the installer named the root of such folders. */
  async function ownConversationProject(ownerProjectId:string,c:{chatId:number;title:string;privateChat?:boolean}) {
    const cfg=await settings.get();
    return ownFolderProject({root:String(cfg.conversationFoldersRoot ?? "").trim(),rulesFile:String(cfg.conversationRulesFile ?? "").trim(),
      home:homedir(),codexHome:process.env.CODEX_HOME,store,projects:bb.sdk.projects as any,ownerProjectId},c);
  }
  // Retention of the conversation archive (В2): texts forever, files for archiveFileDays (0 — forever).
  async function expireArchiveFiles(cfg:{archiveFileDays?:number;telegramInboxRoot?:string;projectInboxRoots?:string}) {
    const days=Number(cfg.archiveFileDays ?? 183);
    if (!archive || !(days>0)) return;
    for (const g of archive.expireFiles(Math.floor(Date.now()/1000-days*86400)))
      for (const root of allInboxes(cfg.projectInboxRoots,cfg.telegramInboxRoot))
        await rm(join(root,"archive",String(g.bot),String(g.chat),String(g.message)),{recursive:true,force:true});
  }
  // The history kept before the archive existed moves into it once per start; repeating adds nothing.
  function importOldHistory() {
    const bot=botId();
    if (!archive || !bot) return;
    const items=store.list<{id?:number;sender?:number;name?:string;date?:number;replyTo?:number;text?:string}>("group:history:").flatMap(({key,value})=>{
      const [,, chat, topic]=key.split(":").map(Number);
      if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(topic) || !value || typeof value.text!=="string") return [];
      return [{chat,topic,id:Number(value.id),sender:Number(value.sender ?? 0),name:String(value.name ?? ""),date:Number(value.date),
        replyTo:Number.isSafeInteger(value.replyTo) ? value.replyTo : undefined,text:value.text,
        title:store.get<{title?:string}>(`visibility:${bot}:group:${chat}`)?.title}];
    });
    store.put("archive:history-imported:"+bot,{at:Date.now(),added:archive.importHistory(bot,items),seen:items.length});
  }
  const firstExpiry=setTimeout(()=>{
    try { importOldHistory(); } catch { /* the next start repeats it */ }
    void settings.get().then(expireArchiveFiles).catch(()=>{});
  },60_000);
  let cleaning=false;
  const inboxTimer=setInterval(async()=>{
    if(cleaning || stateTransferBusy)return;
    cleaning=true;
    try {
      const cfg=await settings.get();
      await expireArchiveFiles(cfg).catch(()=>{});
      if(!cfg.enabled && !cfg.isolatedGroupProject && !cfg.isolatedPrivateProject)return;
      for (const root of allInboxes(cfg.projectInboxRoots,cfg.telegramInboxRoot)) {
      if(!existsSync(root))continue;
      await cleanInbox(root,async id=>{
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
      }
      // Telegram's spare quotes (С81 fallback) are kept 30 days.
      for (const {key,value} of store.list<{at?:number}|string>("reply:quote:"))
        if (typeof value==="string" || (value.at ?? 0)<Date.now()-30*86400_000) store.del(key);
    } catch { console.warn("Telegram inbox maintenance deferred"); }
    finally {cleaning=false;}
  },3600_000);
  const localFiles = async () => {
    const c = await settings.get();
    return {localRoot:c.telegramLocalRoot, inboxRoot:c.telegramInboxRoot};
  };
  let lastLoggedError="";
  const safeError = (e: unknown) => {
    const code = e instanceof TelegramFailure
      ? e.code
      : e instanceof Error && /^[a-z_]+(?::[a-zA-Z0-9_]+)?$/.test(e.message)
        ? e.message
        : "sync_failed";
    // An unexpected failure is written to the plugin log once (its message and where), without tokens or texts.
    if (code==="sync_failed") {
      const where=(e instanceof Error ? (e.stack ?? "").split("\n").slice(0,3).join(" | ") : String(e))
        .replace(/bot\d+:[A-Za-z0-9_-]+/g,"bot***").slice(0,400);
      if (where!==lastLoggedError) { lastLoggedError=where; bb.log.warn("Telegram Projects: unexpected failure: "+where); }
    }
    return code;
  };
  async function status() {
    const cfg = await settings.get();
    return {
      chatEnabled: cfg.chatEnabled,
      chatBindings: bridge?.status().bindings ?? [],
      chatQueue: bridge?.status().outgoing ?? 0,
      chatError: bridge?.status().lastError ?? null,
      chatLastError: (() => {
        const e = bridge?.status().lastErrorDetail;
        if (!e) return null;
        const where = [e.topicId !== undefined ? (e.topicId ? `тема ${e.topicId}` : "личка") : "", e.threadId ? `тред ${e.threadId}` : ""]
          .filter(Boolean).join(", ");
        return { ...e, text: `последняя ошибка: ${e.code}${where ? ", " + where : ""}, ${e.at.slice(0, 16).replace("T", " ")} UTC` };
      })(),
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
    const bbOn = bbMentionsOn(store, cfg.bbMentions as BbMentionsSetting);
    const tr = (s: string) => bbText(t => translate(cfg.language as "ru" | "en", t), cfg.language, bbOn, s);
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
        ...(bbOn && {reply_markup: {
          inline_keyboard: [[{ text: tr("Открыть BB"), url: open }]],
        }}),
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
              // Every link here opens BB: without BB mentions there is no button.
              ...(bbOn ? [{
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
              }] : []),
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
  async function isolatedProject(privateThread?:string) {
    const config=await settings.get();
    if (config.isolatedGroupProject && config.isolatedPrivateProject) throw Error("isolated_executor_requires_one_scope");
    if (privateThread!==undefined && config.isolatedPrivateThread!==privateThread) throw Error("isolated_thread_required");
    const project=privateThread!==undefined?config.isolatedPrivateProject:config.isolatedGroupProject;
    if (!project || ownerId() || botId()) throw Error("isolated_executor_required");
    if (config.enabled || config.chatEnabled || config.botToken || await tokenSource() !== "none")
      throw Error("isolated_executor_required");
    validateIsolatedPurpose(store,project,privateThread);
    return project;
  }
  bb.rpc.register(rpcContract, {
    sendToOwner: async ({ text, source }) => {
      const owner = ownerId(), bot = botId();
      if (!bridge || !owner || !bot || stateTransferBusy) return { ok: false, reason: "bot_unavailable" };
      const cfg = await settings.get();
      if (!cfg.enabled || !cfg.chatEnabled) return { ok: false, reason: "bridge_off" };
      const body = text.trim();
      if (!body) return { ok: false, reason: "empty_text" };
      const cut = body.length > 3500 ? body.slice(0, 3500) + "…" : body;
      try {
        await sendFormattedText(telegram(botToken, lifetime.signal, 15_000, () => owner, apiRoot),
          { chatId: owner, topicId: 0, markdown: (source ? `От: ${source}\n` : "") + cut });
        return { ok: true };
      } catch (error) { return { ok: false, reason: "telegram_failed: " + String((error as Error).message).slice(0, 120) }; }
    },
    rightsAccess: async () => botId() ? accessList(store, botId()!) : [],
    rightsAccessSet: async ({ people }) => {
      if (!botId()) throw Error("bot_unavailable");
      return setAccess(store, botId()!, people);
    },
    rightsGroup: async ({ chatId }) => botId() ? groupSettings(store, botId()!, chatId) ?? null : null,
    rightsGroupSet: async ({ chatId, ...change }) => {
      if (!botId()) throw Error("bot_unavailable");
      const saved = saveGroupSettings(store, botId()!, chatId, change);
      if (change.shortName !== undefined) void applyThreadTitles(store, bb.sdk, botId()!, chatId).catch(() => {});   // С66
      return saved;
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
    readIsolatedDocument: async args => readIsolatedDocument(bb.sdk,store,await isolatedProject(),
      (await settings.get()).isolatedFileHost,args),
    readIsolatedGroup: async args => readIsolatedGroup(bb.sdk,store,await isolatedProject(),args),
    submitIsolatedPrivate: async args => submitIsolatedGroup(bb.sdk,store,await isolatedProject(args.threadId),args,
      (await settings.get()).telegramInboxRoot,true),
    readIsolatedPrivate: async args => readIsolatedGroup(bb.sdk,store,await isolatedProject(args.threadId),args,true),
    readIsolatedPrivatePdf: async args => readIsolatedPdf(bb.sdk,store,await isolatedProject(args.threadId),
      (await settings.get()).isolatedFileHost,args,true),
    readIsolatedPrivateImage: async args => readIsolatedImage(bb.sdk,store,await isolatedProject(args.threadId),
      (await settings.get()).isolatedFileHost,args,true),
    readIsolatedPrivateDocument: async args => readIsolatedDocument(bb.sdk,store,await isolatedProject(args.threadId),
      (await settings.get()).isolatedFileHost,args,true),
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
    bindGroupTopic: async ({chatId,topicId,threadId,ownerOnly,requireMention,ownerSharedProject,ownerTopicManagerProjectId,addressName,allowedSenderIds,deliverySources,includeTopicContext,searchableHistory,retainFullHistory})=>{
      const owner=ownerId(), bot=botId();
      if (!owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      const tg=telegram(botToken,lifetime.signal,15_000,()=>chatId,apiRoot);
      if (store.get(topicStateKey(bot,chatId,topicId))==="deleted") throw Error("forum_topic_deleted");
      const me=await checkBot(tg,bot);
      const chat=await tg("getChat",{chat_id:chatId});
      if (chat.id!==chatId || !["group","supergroup"].includes(chat.type) ||
          (topicId>0 && !chat.is_forum)) throw Error("group_unavailable");
      const member=await tg("getChatMember",{chat_id:chatId,user_id:owner});
      if (!["creator","administrator"].includes(member.status)) throw Error("group_owner_required");
      if (ownerTopicManagerProjectId) {
        if (ownerSharedProject || chat.is_forum!==true || topicId<2 ||
            (member.status!=="creator" && member.can_manage_topics!==true))
          throw Error("work_forum_binding_required");
        if ((await bb.sdk.projects.get({projectId:ownerTopicManagerProjectId})).kind!=="standard")
          throw Error("owner_topic_manager_project_required");
      }
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
      const thread=executor ? undefined : await bb.sdk.threads.get({threadId});
      const projectId=executor?.projectId ?? thread?.projectId;
      if (!projectId || (thread && (thread.archivedAt || thread.deletedAt || thread.visibility==="hidden")))
        throw Error("thread_unavailable");
      if (ownerSharedProject) {
        if (!thread || thread.parentThreadId) throw Error("separate_group_root_required");
        if (!store.get(sharedGroupThreadKey(threadId))) {
          const lineage=await bb.sdk.threads.experimental_listDescendants({threadIds:[threadId],
            includeHidden:true,includeArchived:true,signal:lifetime.signal});
          if (lineage.threads.length!==1 || lineage.threads[0].descendantIds.length)
            throw Error("separate_group_root_required");
        }
      }
      if (owner!==ownerId() || bot!==botId() || stateTransferBusy) throw Error("bot_changed");
      const topicState=store.get(topicStateKey(bot,chatId,topicId));
      if (topicState==="deleted" || topicState==="working" || topicState==="uncertain") throw Error("forum_topic_unavailable");
      const before=store.get<GroupTopicPolicy>(`group:policy:${chatId}:${topicId}`)?.threadId;
      bindGroupTopic(store,{ownerSharedProject,ownerTopicManagerProjectId,addressName,deliverySources:deliverySources ? [...new Set(deliverySources)].sort() : store.get<{deliverySources?:string[]}>(`group:policy:${chatId}:${topicId}`)?.deliverySources,isolated:!!executor,searchableHistory,retainFullHistory,includeTopicContext,allowedSenderIds:[...new Set(allowedSenderIds)].sort((a,b)=>a-b),chatId,topicId,threadId,ownerOnly,requireMention,botId:bot,botUsername:me.username,
        ownerId:owner,revision:crypto.randomUUID()},projectId);
      store.del(forumOptOutKey(bot,chatId,topicId));
      void applyThreadTitles(store,bb.sdk,bot,chatId).catch(()=>{});   // С66
      // The conversation moved to another thread: neither thread loses the work silently. The former one learns where
      // to pass what it still holds; the new one learns where the earlier work and its results are.
      if (before && before!==threadId) void handOverNotices(before,threadId,chatId,topicId).catch(()=>{});
      return warning ? {bound:true as const,warning} : {bound:true as const};
    },
    setForumTopicDefaults: async ({chatId,sourceTopicId,enabled,managers,closeManagers,deleteManagers})=>{
      const owner=ownerId(),bot=botId();
      if (!owner || !bot || stateTransferBusy) throw Error("bot_unavailable");
      const key=forumDefaultsKey(bot,chatId);
      // С54: turning off also stops the default pickup for this group; turning on clears that.
      if (!enabled) {store.atomic(()=>{store.del(key);store.put(forumAutoOffKey(bot,chatId),true);});return {enabled:false};}
      store.del(forumAutoOffKey(bot,chatId));
      const sourceKey=`group:policy:${chatId}:${sourceTopicId}`;
      const source=store.get<GroupTopicPolicy>(sourceKey);
      if (!source || source.ownerId!==owner || source.botId!==bot || !source.projectId ||
          !groupThreadMatches(store,source,source.projectId) || (!source.ownerSharedProject && (!source.isolated || !source.ownerTopicManagerProjectId)))
        throw Error("forum_default_scope_required");
      const tg=telegram(botToken,lifetime.signal,15_000,()=>chatId,apiRoot);
      await checkOwnerForum(tg,chatId,owner,bot,{shared:source.ownerSharedProject,work:source.ownerSharedProject?undefined:true});
      if (stateTransferBusy || owner!==ownerId() || bot!==botId() ||
          store.get<GroupTopicPolicy>(sourceKey)?.revision!==source.revision) throw Error("forum_default_scope_changed");
      store.put(key,{sourceTopicId,managers:[...new Set(managers)],closeManagers:[...new Set(closeManagers??[])],
        deleteManagers:[...new Set(deleteManagers)],since:Math.floor(Date.now()/1000)} satisfies ForumDefaults);
      return {enabled:true};
    },
    bindOwnerChat: async ({projectId})=>{
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      if (!bridge) throw Error("chat_not_enabled");
      return bridge.bindOwnerChat(projectId);
    },
    conversationOf: async ({threadId})=>{
      const owner=ownerId();
      const found=await conversationOf(store,bb.sdk.threads,threadId).catch(()=>undefined);
      if (!found) return null;
      if (found.kind==="group") return {kind:"group" as const,chatId:found.chat as number,topicId:(found.topic ?? 0) as number};
      if (found.kind==="person") return {kind:"person" as const,chatId:found.subject as number,topicId:0};
      return owner ? {kind:"owner" as const,chatId:owner,topicId:0} : null;
    },
    moveConversationToFolder: async ({chatId,dryRun})=>{
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      if (!dryRun && (await settings.get()).conversationMoveEnabled!==true)
        throw Error("conversation_move_off: moving existing groups is switched off on this installation (conversationMoveEnabled)");
      const owner=ownerId(), bot=botId();
      const dm=ownerBinding();
      if (!owner || !bot || !dm) throw Error("bridge_not_ready");
      return moveConversation({store,owner,bot,ownerProjectId:dm.projectId,
        busy:(topic)=>["working","uncertain"].includes(String(store.get(topicStateKey(bot,chatId,topic)))),
        title:movedTitle(chatId) ?? (chatId<0 ? "Группа "+chatId : "Личка "+chatId),
        ensureProject:(title)=>ownConversationProject(dm.projectId,{chatId,title,privateChat:chatId>0}),
        projectPath:async(projectId)=>(await bb.sdk.projects.get({projectId}))?.sources?.[0]?.path,
        thread:(threadId)=>bb.sdk.threads.get({threadId}).catch(()=>undefined),
        spawn:(a)=>bb.sdk.threads.spawn(a as any),
        bind:(policy,projectId)=>bindGroupTopic(store,policy,projectId),
        notice:(from,to,topic,schedules,label)=>void handOverNotices(from,to,chatId,topic,schedules,label).catch(()=>{}),
        openChildren:async(threadId)=>{
          const rows=await (bb.sdk.threads as any).list({parentThreadId:threadId}) as {archivedAt?:unknown;deletedAt?:unknown}[];
          return (Array.isArray(rows) ? rows : []).filter(t=>!t.archivedAt && !t.deletedAt).length;
        },
        moveSchedules:(from,to)=>moveThreadSchedules(from,to,dm.projectId),
      },chatId,dryRun);
    },
    restoreConversationFolder: async ({chatId})=>{
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      const dm=ownerBinding();
      return restoreConversation({store,bind:(policy,projectId)=>bindGroupTopic(store,policy,projectId),
        notice:(from,to,topic,schedules)=>void handOverNotices(from,to,chatId,topic,schedules).catch(()=>{}),
        ...(dm && {moveSchedules:(from:string,to:string)=>moveThreadSchedules(from,to,dm.projectId)})},chatId);
    },
    unbindGroupTopic: ({chatId,topicId})=>{
      if (stateTransferBusy) throw Error("state_transfer_in_progress");
      const key=`group:policy:${chatId}:${topicId}`;
      const previous=store.get<{botId:number}>(key);
      const state=previous && store.get(topicStateKey(previous.botId,chatId,topicId));
      if (state==="working" || state==="uncertain") throw Error("forum_topic_operation_pending");
      const removed=!!previous;
      store.atomic(()=>{if (previous) {
        store.put(forumOptOutKey(previous.botId,chatId,topicId),true);
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
    configureChatPair: async ({topicId, primaryThreadId, fallbackThreadId, name}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      await bridge.pairs.configure(topicId, primaryThreadId, fallbackThreadId, name);
      return {configured: true as const};
    },
    removeChatPair: async ({topicId}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.pairs.remove(topicId);
    },
    chatPairStatus: async ({topicId}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.pairs.status(topicId);
    },
    switchChatThread: async ({topicId, fromThreadId, toThreadId}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.pairs.manualSwitch(topicId, fromThreadId, toThreadId);
    },
    continueChildOnActive: async ({threadId, topicId}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      const pair = await bridge.pairs.pairFor(threadId, topicId);
      if (!pair) throw Error("pair_missing");
      return {threadId: await bridge.pairs.continueOnActive(pair.topicId, threadId)};
    },
    archiveAssistantThread: async ({threadId, topicId}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      const pair = await bridge.pairs.pairFor(threadId, topicId);
      if (!pair) throw Error("pair_missing");
      return bridge.pairs.archiveCreated(pair.topicId, threadId);
    },
    clearChatPairLimit: async ({topicId, threadId}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.pairs.clearLimit(topicId, threadId);
    },
    setChildUrgency: async ({threadId, urgent}) => {
      if (!bridge) throw Error("telegram_chat_unavailable");
      return bridge.pairs.setUrgent(threadId, urgent);
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
        name:"send",
        summary:"Send a message or file to a group topic or a person with access; --ask remembers the question so the answer comes back",
        usage:"bb telegram-projects send --targets | send ([--chat GROUP] [--topic TOPIC] | --person PERSON|owner | --answer ASK) (--text TEXT | --text-file PATH, not stdin) [--file PATH …] [--reply-to MESSAGE] [--ask]",
      },
      {
        name:"topic",
        summary:"Create, rename, close, reopen or delete a forum topic by its name; a group may manage its own topics, deleting is for the owner",
        usage:"bb telegram-projects topic (create --chat GROUP --name NAME [--text FIRST] | rename --topic TOPIC --name NAME | close|reopen|delete --topic TOPIC) [--chat GROUP]",
      },
      {
        name:"edit",
        summary:"Edit the bot's own message in this conversation's chat (С82)",
        usage:"bb telegram-projects edit --message MESSAGE_ID --text TEXT",
      },
      {
        name:"topic-mode",
        summary:"Lead this topic (hear people without a mention) or leave it to mentions — on the word of the owner or a curator; status shows who leads",
        usage:"bb telegram-projects topic-mode (lead|mention|status) [--chat]  (--chat: the whole chat — every topic without its own leader, new ones too)",
      },
      {
        name:"delete",
        summary:"Delete a message in this conversation's own chat: the bot's own, or anyone's on the owner's word (С80)",
        usage:"bb telegram-projects delete --message MESSAGE_ID",
      },
      {
        name:"search-history",
        summary:"Read the conversation archive this conversation may see: words, author, period, last N, files; download a file",
        usage:"bb telegram-projects search-history [words] [--author A] [--from YYYY-MM-DD[THH:MM]] [--to …] [--tz Europe/Moscow] [--last N] [--files] [--chat C] [--topic T] [--file CHAT:MESSAGE] [--message [CHAT:]MESSAGE]",
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
        name: "bind-owner-chat",
        summary: "Bind the owner's chat to a project, as /project does",
        usage: "bb telegram-projects bind-owner-chat --project <project-id>",
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
      if (!["search-history","send","topic","delete","edit"].includes(argv[0]) && (groupCliRestricted(store, ctx.projectId, ctx.threadId) ||
          (ctx.threadId && (await sharedGroupThreads(store,bb.sdk.threads,[ctx.threadId])).has(ctx.threadId))))
        return {exitCode: 1, stderr: "bridge_admin_command_unavailable_in_group"};
      if(argv[0]==="topic"){
        const owner=ownerId(),bot=botId();
        if (!ctx.threadId || !owner || !bot) return {exitCode:1,stderr:"run_from_a_conversation_thread"};
        const action=argv[1] as TopicAction;
        if (!TOPIC_ACTIONS.includes(action)) return {exitCode:2,stderr:"usage: topic create|rename|close|reopen|delete"};
        const opt:Record<string,string>={};
        const rest=argv.slice(2);
        for (let i=0;i<rest.length;i++) {
          if (rest[i]==="--json") continue;
          if (rest[i].startsWith("--") && rest[i+1]!==undefined) opt[rest[i].slice(2)]=rest[++i];
          else return {exitCode:2,stderr:"unexpected_argument "+rest[i]};
        }
        let rightsChat:number|undefined;
        try {
          const caller=await conversationOf(store,bb.sdk.threads,ctx.threadId,lifetime.signal);
          const group=opt.chat ? findGroup(store,bot,opt.chat) : undefined;
          const target=action==="create" ? (group!==undefined ? {chat:group,topic:0} : undefined) :
            opt.topic ? findTopic(store,bot,group,opt.topic) : undefined;
          if (!target) return {exitCode:2,stderr:action==="create" ? "group_required: --chat" : "topic_required: --topic"};
          rightsChat=target.chat;
          const refusal=topicRefusal(caller,action,target.chat);
          if (refusal) return {exitCode:1,stderr:refusal};
          const tg=telegram(botToken,lifetime.signal,30_000,()=>target.chat,apiRoot);
          if (action==="create" || action==="rename") {
            const name=(opt.name ?? "").trim().slice(0,128);
            if (!name) return {exitCode:2,stderr:"name_required: --name"};
            if (action==="create") {
              const made=await tg<{message_thread_id:number}>("createForumTopic",{chat_id:target.chat,name});
              const topicId=made.message_thread_id, now=Math.floor(Date.now()/1000);
              rememberForumName(store,bot,target.chat,topicId,name,store.get<number>("ingress:offset") ?? 0,true,now);
              // The bot gets no update about its own topic: the topic gets its conversation here, as one the owner made (С54).
              const owner=ownerId();
              let conversation=false;
              if (owner) {
                try {
                  await inheritForumTopic(owner,bot,lifetime.signal,{update_id:store.get<number>("ingress:offset") ?? 0,message:{message_id:topicId,
                    message_thread_id:topicId,is_topic_message:true,date:now,from:{id:bot,is_bot:true},
                    chat:{id:target.chat,type:"supergroup",is_forum:true},forum_topic_created:{name}}});
                  if (!store.get(`group:policy:${target.chat}:${topicId}`) && (await settings.get()).installKind==="employee") {
                    const title=store.get<{title?:string}>(`visibility:${bot}:group:${target.chat}`)?.title ?? "группа";
                    await bindConversation(owner,bot,{chatId:target.chat,topicId,title:`${title} · ${name}`},lifetime.signal);
                  }
                } catch (error) { bb.log.warn("Telegram topic conversation deferred: "+String((error as Error)?.message ?? error)); }
                conversation=!!store.get(`group:policy:${target.chat}:${topicId}`);
              }
              if (opt.text) await sendOutboundMessage(tg,{chatId:target.chat,topicId,text:opt.text});
              return {exitCode:0,stdout:JSON.stringify({created:true,topic:topicId,name,conversation})};
            }
            if (await tg("editForumTopic",{chat_id:target.chat,message_thread_id:target.topic,name})!==true) throw Error("rename_unconfirmed");
            rememberForumName(store,bot,target.chat,target.topic,name,store.get<number>("ingress:offset") ?? 0);
            return {exitCode:0,stdout:JSON.stringify({renamed:true,topic:target.topic,name})};
          }
          const result=await applyForumTopicChange(store,bot,target.chat,target.topic,action,tg);
          return {exitCode:0,stdout:JSON.stringify({done:true,action,topic:target.topic,result})};
        } catch (error) {
          if (error instanceof TelegramFailure && error.code==="telegram_rights") {
            const title=(rightsChat!==undefined ? store.get<{title?:string}>(`visibility:${bot}:group:${rightsChat}`)?.title : undefined) ?? opt.chat ?? "эта группа";
            return {exitCode:1,stderr:missingRightRefusal(action,title)};
          }
          return {exitCode:1,stderr:String((error as Error).message)};
        }
      }
      if(argv[0]==="edit"){
        // С82: bb telegram-projects edit --message N --text T — the bot's own message in this conversation's chat.
        const owner=ownerId(),bot=botId();
        if (!ctx.threadId || !owner || !bot) return {exitCode:1,stderr:"run_from_a_conversation_thread"};
        const at=(k:string)=>{const i=argv.indexOf(k);return i>0 ? argv[i+1] : undefined;};
        const message=Number(at("--message")); const body=at("--text");
        if (!Number.isSafeInteger(message) || message<=0 || !body?.trim()) return {exitCode:2,stderr:"usage: edit --message MESSAGE_ID --text TEXT"};
        const caller=await conversationOf(store,bb.sdk.threads,ctx.threadId,lifetime.signal);
        if (!caller) return {exitCode:1,stderr:"edit_only_from_a_telegram_conversation: править можно только в чате своего разговора"};
        const chat=caller.kind==="group" ? caller.chat : caller.kind==="person" ? caller.subject : owner;
        const stored=archive?.message(bot,chat,message);
        if (archive?.sender(bot,chat,message)!==bot || (caller.kind==="group" && caller.topic!==undefined && stored && stored.topic!==caller.topic))
          return {exitCode:1,stderr:"edit_own_only: править можно только свои сообщения бота в чате и теме этого разговора"};
        try {
          const tg=telegram(botToken,lifetime.signal,15_000,()=>chat,apiRoot);
          const parts=renderTelegramParts(body);
          if (parts.length!==1) return {exitCode:1,stderr:"edit_text_too_long: новый текст должен уместиться в одно сообщение"};
          await tg("editMessageText",{chat_id:chat,message_id:message,text:parts[0],parse_mode:"HTML",link_preview_options:{is_disabled:true}});
          console.info(`[telegram-projects] edited message ${message} in ${chat} for ${ctx.threadId}`);
          return {exitCode:0,stdout:JSON.stringify({edited:true,message})};
        } catch (error) {
          if (error instanceof TelegramFailure && error.code==="telegram_400")
            return {exitCode:1,stderr:"edit_refused: Telegram не дал изменить — сообщение старше 48 часов, не текстовое или уже удалено"};
          return {exitCode:1,stderr:String((error as Error).message)};
        }
      }
      if(argv[0]==="topic-mode"){
        // Agents in chats: the agent leads its topic or waits for mentions, on the word of the owner or its curator.
        const owner=ownerId(),bot=botId();
        if (!ctx.threadId || !owner || !bot) return {exitCode:1,stderr:"run_from_a_conversation_thread"};
        const action=argv[1];
        if (!["lead","mention","status"].includes(action)) return {exitCode:2,stderr:"usage: topic-mode (lead|mention|status)"};
        const caller=await conversationOf(store,bb.sdk.threads,ctx.threadId,lifetime.signal);
        if (caller?.kind!=="group") return {exitCode:1,stderr:"Режим темы есть только у разговора группы или темы."};
        const place={chat:caller.chat as number,topic:caller.topic as number};
        const organization=agentBots(store);
        const now=topicMode(store,bot,place.chat,place.topic,organization);
        const wholeChat=argv.includes("--chat");
        if (action==="status") return {exitCode:0,stdout:JSON.stringify({mode:now.mode,explicit:now.explicit,
          chatLead:leadsChat(store,bot,place.chat),agents:otherAgentsInChat(store,bot,place.chat,organization)})};
        const author=store.get<number>("group:turn-author:"+ctx.threadId);
        if (author===undefined || !canAssignLead(store,owner,author))
          return {exitCode:1,stderr:"Назначать ведущего темы и отпускать его может только владелец или куратор этого агента. Скажи это человеку словами."};
        const refusal=action==="lead" ? leadRefusal(organization) : undefined;
        if (refusal) return {exitCode:1,stderr:refusal};
        const changed=wholeChat ? setChatMode(store,bot,place.chat,action as TopicMode,author)
          : setTopicMode(store,bot,place.chat,place.topic,action as TopicMode,author,organization);
        if (!changed) return {exitCode:0,stdout:JSON.stringify({mode:action,chat:wholeChat,changed:false})};
        try {
          await sendFormattedText(telegram(botToken,lifetime.signal,15_000,()=>place.chat,apiRoot),
            {chatId:place.chat,topicId:place.topic,markdown:modeLine(action as TopicMode,wholeChat)});
        } catch (error) {
          return {exitCode:0,stdout:JSON.stringify({mode:action,changed:true,announced:false,reason:String((error as Error).message)})};
        }
        return {exitCode:0,stdout:JSON.stringify({mode:action,changed:true,announced:true,
          ...(action==="lead" && {note:LEAD_NOTE})})};
      }
      if(argv[0]==="delete"){
        // С80: bb telegram-projects delete --message N — a message of this conversation's own chat.
        const owner=ownerId(),bot=botId();
        if (!ctx.threadId || !owner || !bot) return {exitCode:1,stderr:"run_from_a_conversation_thread"};
        const i=argv.indexOf("--message"); const message=Number(i>0 ? argv[i+1] : NaN);
        if (!Number.isSafeInteger(message) || message<=0) return {exitCode:2,stderr:"usage: delete --message MESSAGE_ID"};
        const caller=await conversationOf(store,bb.sdk.threads,ctx.threadId,lifetime.signal);
        const chat=caller?.kind==="group" ? caller.chat : caller?.kind==="person" ? caller.subject : owner;
        const sender=archive?.sender(bot,chat,message);
        // The owner's word lives only in a turn his Telegram message started (or his «да» answer): a later turn begun
        // from BB (a task, a schedule, another thread) does not inherit it.
        const started=(await bb.sdk.threads.events.list({threadId:ctx.threadId,order:"desc",limit:"1",types:["turn/started"],signal:lifetime.signal}))[0];
        const author=authorOfTurn(store,ctx.threadId,started?.scope.kind==="turn" ? started.scope.turnId : undefined,caller?.kind==="owner" ? owner : undefined);
        const refusal=deleteRefusal({caller,owner,bot,chat,sender,author});
        if (refusal) return {exitCode:1,stderr:refusal};
        try {
          const tg=telegram(botToken,lifetime.signal,15_000,()=>chat,apiRoot);
          if (await tg("deleteMessage",{chat_id:chat,message_id:message})!==true) throw Error("delete_unconfirmed");
          deleteLog(store,bot,{thread:ctx.threadId,chat,message,own:sender===bot,author});
          console.info(`[telegram-projects] deleted message ${message} in ${chat} for ${ctx.threadId} (${sender===bot ? "own" : "by owner"})`);
          return {exitCode:0,stdout:JSON.stringify({deleted:true,message})};
        } catch (error) {
          if (error instanceof TelegramFailure && (error.code==="telegram_rights" || error.code==="telegram_cannot_delete")) {
            const title=chat<0 ? store.get<{title?:string}>(`visibility:${bot}:group:${chat}`)?.title ?? "эта группа" : "этот чат";
            return {exitCode:1,stderr:(error.code==="telegram_cannot_delete" ? "Telegram не дал удалить: старше 48 часов или нет права. " : "")+
              missingRightRefusal("deleteMessage",title)};
          }
          return {exitCode:1,stderr:String((error as Error).message)};
        }
      }
      if(argv[0]==="send"){
        // bb telegram-projects send (--chat C [--topic T] | --person P | --answer ASK) (--text T | --text-file F) [--file PATH] [--reply-to MESSAGE] [--ask]
        const owner=ownerId(),bot=botId();
        if (!ctx.threadId || !owner || !bot) return {exitCode:1,stderr:"run_from_a_conversation_thread"};
        const opt:Record<string,string>={}; let ask=false; const files:string[]=[];
        const rest=argv.slice(1);
        for (let i=0;i<rest.length;i++) {
          if (rest[i]==="--ask") ask=true;
          else if (rest[i]==="--targets") opt.targets="1";
          // С84: several files in one send: --file A --file B … (one album per up to ten files).
          else if (rest[i]==="--file" && rest[i+1]!==undefined) { files.push(rest[++i]); opt.file??=files[0]; }
          else if (rest[i]==="--json") continue;
          else if (rest[i].startsWith("--") && rest[i+1]!==undefined) opt[rest[i].slice(2)]=rest[++i];
          else return {exitCode:2,stderr:"unexpected_argument "+rest[i]};
        }
        try {
          const caller=await conversationOf(store,bb.sdk.threads,ctx.threadId,lifetime.signal);
          // Who started the current turn of a group conversation: rights follow the author, not the place (С44).
          const author=ctx.threadId ? store.get<number>("group:turn-author:"+ctx.threadId) : undefined;
          // A thread whose group conversation moved to another thread is told so in words, not left with an empty list.
          const moved=caller || !ctx.threadId ? undefined : await movedConversationOf(store,bb.sdk.threads,ctx.threadId,lifetime.signal);
          if (moved && (opt.targets || !(opt.person && ["owner","владелец"].includes(opt.person.trim().toLowerCase()))))
            return {exitCode:1,stderr:movedConversationRefusal(moved,movedTitle(moved.chatId))};
          if (opt.targets) return {exitCode:0,stdout:JSON.stringify(sendTargets(store,bot,owner,caller,p=>archive?.groupsOf(bot,p) ?? [],author))};
          let target:{chat:number;topic:number}; let curatorAsked=false;
          const answer=store.get<import("./send-command").Ask>(`send:ask:${bot}:${opt.answer}`);
          if (opt.answer) { if (!answer) return {exitCode:1,stderr:"no_open_question_for_this_answer"}; target=answer.origin; }
          else if (opt.person && ["owner","владелец"].includes(opt.person.trim().toLowerCase())) target={chat:owner,topic:0};
          // agents-in-chats п.6: the agent's curator is an addressee like the owner — for a question (consent on work).
          else if (opt.person && ["curator","куратор"].includes(opt.person.trim().toLowerCase())) {
            const to=curatorTarget(curators(store),ask);
            if ("error" in to) return {exitCode:1,stderr:to.error};
            target=to; curatorAsked=true;
          }
          else if (opt.person) target={chat:findPerson(store,bot,opt.person),topic:0};
          else if (opt.chat) { const chat=findGroup(store,bot,opt.chat); target=opt.topic ? findTopic(store,bot,chat,opt.topic) : {chat,topic:0}; }
          else if (opt.topic) target=findTopic(store,bot,undefined,opt.topic);
          else return {exitCode:2,stderr:"target_required: --chat, --topic, --person or --answer; see --targets"};
          const relayTo=opt.for ? findPerson(store,bot,opt.for) : undefined;
          // A question to the curator is allowed from any conversation, like one to the owner; his chat must be open.
          const refusal=sendRefusal(store,bot,owner,curatorAsked ? {kind:"owner"} : caller,target,p=>archive?.groupsOf(bot,p) ?? [],opt.answer,author,ask,relayTo);
          if (refusal) return {exitCode:1,stderr:refusal};
          // С90: the relayed words are marked: the addressee mentioned, «по просьбе <requester>».
          if (caller?.kind==="person" && target.chat<0 && relayTo!==undefined && (opt.text || opt["text-file"])) {
            const people=accessList(store,bot);
            const to=people.find(p=>p.id===relayTo), from=people.find(p=>p.id===caller.subject);
            const body=opt["text-file"] && opt["text-file"]!=="-" ? await readFile(opt["text-file"],"utf8") : opt.text ?? "";
            opt.text=`[${to?.name ?? "коллега"}](tg://user?id=${relayTo}), ${body.trim()}\n\n— по просьбе ${from?.name ?? "коллеги"}`;
            delete opt["text-file"];
          }
          // A question to the owner from another conversation (С43, С67): where it comes from, who asks and their status,
          // the original request (a link, or the person's message forwarded), then buttons; the answer returns there.
          let ownerAsk:{turn?:import("./owner-ask").TurnMessage;thread?:string}|undefined;
          // С83: an ordinary thread doing work handed over by a group's conversation writes to the owner there, in that topic.
          let handedBy:{chat:number;topic:number}|undefined;
          if (!caller && target.chat===owner && !opt.answer && ctx.threadId) {
            const asked=(await bb.sdk.threads.events.list({threadId:ctx.threadId,order:"desc",limit:"30",types:["client/turn/requested"],signal:lifetime.signal}))
              .find(e=>e.type==="client/turn/requested" && e.data.initiator==="agent" && e.data.senderThreadId);
            const from=asked?.type==="client/turn/requested" && asked.data.senderThreadId ? await conversationOf(store,bb.sdk.threads,asked.data.senderThreadId,lifetime.signal) : undefined;
            if (from?.kind==="group") { handedBy={chat:from.chat,topic:from.topic ?? 0}; target={chat:from.chat,topic:from.topic ?? 0}; }
          }
          // П28: an ordinary thread of this BB writes to the owner: who it is, the text as sent, cut at 3500 characters.
          if (!caller && (target.chat===owner || handedBy) && !opt.answer && (opt.text || opt["text-file"])) {
            const body=opt["text-file"] && opt["text-file"]!=="-" ? await readFile(opt["text-file"],"utf8") : opt.text ?? "";
            const thread=await bb.sdk.threads.get({threadId:ctx.threadId}).catch(()=>undefined) as {title?:string;projectId?:string}|undefined;
            const project=thread?.projectId ? await bb.sdk.projects.get({projectId:thread.projectId}).catch(()=>undefined) as {name?:string}|undefined : undefined;
            const from=[thread?.title || "тред", project?.name].filter(Boolean).join(" · ");
            const cut=body.length>3500 ? body.slice(0,3500)+"…\n(полностью — в треде)" : body;
            opt.text=`От: ${from}\n${ask ? cleanQuestion(cut)+"\nОтветьте кнопкой или ответом на это сообщение." : cut}`;
            delete opt["text-file"];
            if (ask) ownerAsk={thread:ctx.threadId};
          }
          // A group's conversation reports to the owner (no question): text only, marked with the place, not too often.
          if (target.chat===owner && caller?.kind==="group" && !ask && !opt.answer) {
            const body=opt["text-file"] && opt["text-file"]!=="-" ? await readFile(opt["text-file"],"utf8") : opt.text ?? "";
            const report=ownerReport(store,bot,caller,body,!!opt.file);
            if ("error" in report) return {exitCode:1,stderr:report.error};
            opt.text=report.text; delete opt["text-file"]; delete opt["reply-to"];
          } else if (target.chat===owner && caller && caller.kind!=="owner" && !opt.answer && (opt.text || opt["text-file"])) {
            const place=caller?.kind==="person" ? "лички «"+(accessList(store,bot).find(p=>p.id===caller.subject)?.name ?? caller.subject)+"»"
              : "группы «"+(store.get<{title?:string}>(`visibility:${bot}:group:${caller?.kind==="group" ? caller.chat : 0}`)?.title ?? "группа")+"»";
            const body=opt["text-file"] && opt["text-file"]!=="-" ? await readFile(opt["text-file"],"utf8") : opt.text ?? "";
            const turn=ctx.threadId ? store.get<import("./owner-ask").TurnMessage>(turnMessageKey(ctx.threadId)) : undefined;
            opt.text=ownerQuestion({store,bot,owner,place,turn,body});
            delete opt["text-file"];
            ownerAsk={turn};
          }
          // The bridge's command gets no standard input: "-" cannot be read here.
          if (opt["text-file"]==="-") return {exitCode:2,stderr:"text_file_stdin_unsupported: pass the text with --text '…' (several lines are fine) or write it to a file and pass its path"};
          // A group's or a person's conversation sends only files of its own folder (or received from Telegram):
          // never the owner's or another conversation's files.
          if (caller && caller.kind!=="owner") {
            for (const path of new Set([...files,opt.file].filter((p):p is string=>!!p))) if (!await insideConversationFolder(ctx.threadId,path,caller))
              return {exitCode:1,stderr:"file_outside_this_conversation: этот файл ("+path+") не из этого разговора. Скопируй его в "+await sendableDir(ctx.threadId)+" и сразу отправь оттуда той же командой."};
          }
          const text=opt["text-file"] ? await readFile(opt["text-file"],"utf8") : opt.text;
          let file:import("./outbound-message").OutboundFile|undefined;
          if (opt.file) {
            const bytes=await readFile(opt.file);
            if (bytes.length>uploadLimit()) return {exitCode:1,stderr:"file_too_large"};
            const name=safeTelegramFilename(opt.file.split("/").at(-1) ?? "file");
            const photo=/\.(?:png|jpe?g)$/i.test(name);
            file={name,kind:photo ? "photo" : "document",data:new Blob([new Uint8Array(bytes)],{type:photo ? "image/"+(name.toLowerCase().endsWith("png") ? "png" : "jpeg") : "application/octet-stream"}),
              sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};
          }
          // The owner's answer to a question of another conversation goes to that conversation as a turn: it carries on.
          // Any answer to a question asked from a group or a person's chat comes back there as a turn (the agent there carries on);
          // an answer to the owner's own question is posted to the owner's chat as before.
          if (opt.answer && answer && (answer.origin.chat!==owner || answer.originThread)) {
            const who=answer.target===owner ? "Владелец" : (accessList(store,bot).find(p=>p.id===answer.target)?.name ?? "Собеседник");
            const delivered=await deliverOwnerAnswer(answer,text ?? "","text",who);
            return delivered ? {exitCode:0,stdout:JSON.stringify({sent:true,deliveredTo:"conversation"})} : {exitCode:1,stderr:"asking_conversation_unavailable"};
          }
          const tg=telegram(botToken,lifetime.signal,60_000,()=>target.chat,apiRoot);
          // С56: a PDF as a reply to the scheme picture sent just before (its messageId from the first send).
          const replyTo=opt["reply-to"] && /^\d+$/.test(opt["reply-to"]) ? Number(opt["reply-to"]) : undefined;
          let remembered:string|undefined;
          if (ask && !caller && ownerAsk?.thread && !opt.answer) {
            const asked=rememberAsk(store,bot,owner,{chat:owner,topic:0},text ?? "");
            store.put(`send:ask:${bot}:${asked.id}`,{...asked,originThread:ownerAsk.thread,...(handedBy && {postedChat:handedBy.chat})});
            remembered=asked.id;
          }
          if (ask && caller && !opt.answer) {
            const origin=caller.kind==="owner" ? {chat:owner,topic:0} : caller.kind==="group" ? {chat:caller.chat,topic:caller.topic ?? 0} : {chat:caller.subject,topic:0};
            const asked=rememberAsk(store,bot,target.chat,origin,text ?? opt.file ?? "");
            remembered=asked.id;
            // The answer will go under the request this question came from.
            const turn=ctx.threadId ? store.get<import("./owner-ask").TurnMessage>(turnMessageKey(ctx.threadId)) : undefined;
            if (turn && turn.chat===origin.chat && turn.topic===origin.topic) store.put(`send:ask:${bot}:${asked.id}`,{...asked,replyTo:turn.message});
          }
          // A person's own message goes to the owner as it is, before the question (С67).
          if (ownerAsk?.turn && ownerAsk.turn.chat>0) await forwardOriginal(chat=>telegram(botToken,lifetime.signal,60_000,()=>chat,apiRoot),owner,ownerAsk.turn);
          const buttons=ownerAsk && remembered ? askButtons(remembered) : undefined;
          // С103: whether the bot had written there today, taken before this message goes out.
          const day=archive ? today(archive.lastSent(bot,target.chat,target.topic),Date.now(),orgTimeZone || String((await settings.get()).timeZone ?? "")) : undefined;
          let messageId:number|undefined;
          if (files.length>1) {
            if (ask) return {exitCode:2,stderr:"ask_with_one_file_only"};
            const media:import("./media-album").AlbumMedia[]=[];
            for (const path of files) {
              const bytes=await readFile(path);
              if (bytes.length>uploadLimit()) return {exitCode:1,stderr:"file_too_large: "+path};
              media.push({kind:"document",name:safeTelegramFilename(path.split("/").at(-1) ?? "file"),data:new Blob([new Uint8Array(bytes)],{type:"application/octet-stream"})});
            }
            if (text?.trim()) messageId=(await sendFormattedText(tg,{chatId:target.chat,topicId:target.topic,replyTo,markdown:text})).at(-1);
            for (let i=0;i<media.length;i+=maxAlbumItems) {
              const chunk=media.slice(i,i+maxAlbumItems);
              try {
                const first=chunk.length>1 ? (await sendAlbum(tg,{chatId:target.chat,topicId:target.topic,replyTo:replyTo ?? 0},chunk)).messageIds[0]
                  : await sendOutboundMessage(tg,{chatId:target.chat,topicId:target.topic,file:{name:chunk[0].name!,kind:"document",data:chunk[0].data as Blob,sha256:"",bytes:(chunk[0].data as Blob).size},replyTo});
                messageId??=first;
              } catch (error) {
                // Part went out: say exactly what, so only the rest is sent again (a full repeat would double it).
                const went=[text?.trim() ? "текст" : "", i>0 ? `файлы 1–${i} из ${files.length}` : ""].filter(Boolean).join(" и ") || "ничего";
                return {exitCode:1,stderr:`partial_send: ушло: ${went}; не ушли файлы начиная с ${files[i]} (${String((error as Error).message)}). `+
                  `Повтори отправку только оставшихся файлов (${files.slice(i).join(" ")}), без текста.`};
              }
            }
          } else messageId=file || !text?.trim() ? await sendOutboundMessage(tg,{chatId:target.chat,topicId:target.topic,text,file,replyTo})
            : (await sendFormattedText(tg,{chatId:target.chat,topicId:target.topic,replyTo,markdown:text,...(buttons && {replyMarkup:buttons})})).at(-1);
          if (ownerAsk && remembered && messageId) rememberAskMessage(store,bot,messageId,remembered);
          if (opt.answer) closeAsk(store,bot,opt.answer);
          // A group conversation wrote into its own chat during the turn: the turn's final answer is not posted again.
          if (caller?.kind==="group" && caller.chat===target.chat && (caller.topic ?? 0)===target.topic && !ask && text?.trim()) {
            const prev=store.get<{chat:number;topic:number;at:number;sent?:{t:string;at:number}[]}>(sentInTurnKey(ctx.threadId));
            const same=prev && prev.chat===target.chat && prev.topic===target.topic;
            store.put(sentInTurnKey(ctx.threadId),{chat:target.chat,topic:target.topic,at:Date.now(),
              sent:[...(same ? (prev.sent ?? []).filter(x=>Date.now()-x.at<6*3600_000) : []),{t:sameWords(text),at:Date.now()}].slice(-10)});
          }
          return {exitCode:0,stdout:JSON.stringify({sent:true,messageId,...(remembered && {ask:remembered}),
            ...(day && {firstToday:day.firstToday,localTime:day.localTime})})};
        } catch (error) { return {exitCode:1,stderr:String((error as Error).message)}; }
      }
      if(argv[0]==="search-history"){
        if (!ctx.threadId) return {exitCode:1,stderr:"run_from_a_conversation_thread"};
        // bb telegram-projects search-history [words] [--author A] [--from D] [--to D] [--tz Z] [--last N] [--files] [--chat C] [--topic T] [--file CHAT:MESSAGE]
        const words:string[]=[]; const a:Record<string,unknown>={};
        const rest=argv.slice(1);
        for (let i=0;i<rest.length;i++) {
          const k=rest[i];
          if (k==="--files") a.files=true;
          else if (k==="--json") continue;
          else if (["--author","--from","--to","--tz","--last","--chat","--topic","--file","--message"].includes(k)) {
            const v=rest[++i]; if (v===undefined) return {exitCode:2,stderr:"missing_value_for "+k};
            if (k==="--tz") a.timeZone=v; else if (k==="--last") a.last=Number(v); else if (k==="--topic") a.topic=Number(v);
            else if (k==="--file") { const [c,m]=v.split(":").map(Number); a.file={chat:c,message:m}; }
            else if (k==="--message") { const parts=v.split(":").map(Number); a.message=parts.length>1 ? {chat:parts[0],message:parts[1]} : {message:parts[0]}; }
            else a[k.slice(2)]=v;
          } else words.push(k);
        }
        if (words.length) a.words=words.join(" ");
        const parsed=archiveToolInput.safeParse(a);
        if (!parsed.success) return {exitCode:2,stderr:"invalid_arguments"};
        try { return {exitCode:0,stdout:await readArchive(parsed.data,ctx.threadId,lifetime.signal)}; }
        catch (error) { return {exitCode:1,stderr:String((error as Error).message)}; }
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
      if (cmd === "bind-owner-chat") {
        // Only the owner's own conversation or a local call without a thread (the installer).
        if (ctx.threadId && !store.list<{threadId?:string|null}>("chat:binding:").some(row => row.value.threadId === ctx.threadId))
          return { exitCode: 1, stderr: "bind_owner_chat_only_from_the_owners_conversation_or_the_installer" };
        const i = argv.indexOf("--project");
        const projectId = i >= 0 ? argv[i + 1] : undefined;
        if (!projectId) return { exitCode: 2, stderr: "usage: bind-owner-chat --project <project-id>" };
        if (!bridge) return { exitCode: 1, stderr: "chat_not_enabled" };
        try { return { exitCode: 0, stdout: JSON.stringify(await bridge.bindOwnerChat(projectId)) }; }
        catch (error) { return { exitCode: 1, stderr: String((error as Error)?.message ?? error) }; }
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
      let employeeProjectSetting = "";
      let bbMentions: BbMentionsSetting = "auto";
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
      // С72: thread changes wake the chat loop; while the feed is down the bridge reads everything every 2 s.
      let feedUp = false;
      const scheduleDirty = new Set<string>();
      let lastScheduleFull = 0;
      const unsubscribeChanges = (() => {
        try {
          const offThreads = bb.sdk.subscribe({event: "thread:changed", callback: (e) => {
            if (!e.id) return;
            scheduleDirty.add(e.id);
            bridge?.noteThreadChange(e.id);
          }});
          const offConnection = bb.sdk.subscribe({event: "realtime:connection", callback: (e) => {
            feedUp = e.state === "connected";
            bridge?.setChangeFeed(feedUp);
          }});
          feedUp = true;
          return () => { offThreads(); offConnection(); };
        } catch { return () => {}; }
      })();
      try {
        while (!signal.aborted) {
          const cfg = await settings.get();
          if (cfg.enabled && cfg.chatEnabled && !stateTransferBusy) {
            rich = cfg.richReplies;
            currentUrl = new URL(cfg.appUrl).origin;
            language = cfg.language as "ru" | "en";
            try { setUploadLimit(cfg.telegramApiRoot); } catch { /* invalid setting: cloud limit stays */ }
            bbMentions = cfg.bbMentions as BbMentionsSetting;
            employeeProjectSetting = String(cfg.employeeProject ?? "").trim();
            orgTimeZone = String(cfg.timeZone ?? "").trim();
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
                bbMentions: () => bbMentionsOn(store, bbMentions),
                employeeProject: () => employeeProjectSetting || undefined,
                setupNote: (text) => bb.log.warn("Telegram setup: " + text),
                todayOf,
                wake: wakeChat,
                reactions: () => currentReactions,
                transcribe: async (v) => {
                  const {voiceRouterPath} = await settings.get();
                  return transcribeTelegramVoice(botToken, bb.sdk, v, bridgeSignal, apiRoot, localFiles,
                    voiceRouterPath ? audio => transcribeWithVoiceRouter(voiceRouterPath, audio, bridgeSignal) : undefined, language);
                },
                receiveAttachment: async (input, threadId) => {
                  return receiveLocalFile(input.attachment!,input.updateId,threadId,bridgeSignal);
                },
              });
              bridge.recover();
              bridge.setChangeFeed(feedUp);
            }
            await publishControl(true, cfg.language);
            await bridge.tick();
            const owner = ownerId(), bot = botId();
            const employeeProject=String(cfg.employeeProject ?? "").trim();
            if (owner && employeeProject && store.get("owner-chat:bind-employee-project")) {
              await bridge.bindOwnerChat(employeeProject)
                .catch(error=>bb.log.warn("Telegram owner chat binding: "+String(error?.message ?? error)));
              store.del("owner-chat:bind-employee-project");
            }
            if (owner && bot) {
              const groupTransport=(chatId:number)=>telegram(botToken,signal,15000,()=>chatId,apiRoot);
              try {
                void typing?.();
                await presentProjectProposals(store,owner,bot,telegram(botToken,signal,15000,ownerId,apiRoot));
                collectDecisionResults(store,owner,bot);
                const verifyOwnerForum=async (policy:GroupTopicPolicy)=> {
                  try {
                    return await sharedOwnerForum(groupTransport(policy.chatId),policy.chatId,owner,bot) &&
                      ownerId()===owner && botId()===bot && !stateTransferBusy;
                  } catch { return false; }
                };
                await deliverGroupResults(store,bb.sdk,o=>o.owner===ownerId() && o.bot===botId() && !stateTransferBusy,
                  groupTransport,signal,verifyOwnerForum);
                reactionsFrom(cfg);
                await processGroupInputs(store,bb.sdk,owner,bot,
                  groupTransport,signal,
                  voice=>transcribeTelegramVoice(botToken,bb.sdk,voice,signal,apiRoot,localFiles,
                    cfg.voiceRouterPath ? audio=>transcribeWithVoiceRouter(cfg.voiceRouterPath,audio,signal) : undefined,cfg.language as "ru"|"en"),cfg.telegramFileHostId,
                  (file,r)=>receiveGroupFile(file,r,signal,bot),true,verifyOwnerForum,()=>currentReactions,turnRulesOf,pausedOf,
                  (threadId,route,path)=>insideConversationFolder(threadId,path,route.privateChat ? {kind:"person",subject:route.chatId} : {kind:"group",chat:route.chatId,topic:route.topicId}),
                  (chatId,topicId)=>{ orgTimeZone=String(cfg.timeZone ?? "").trim(); return todayOf(chatId,topicId); });
                const scheduleFull=!feedUp || Date.now()-lastScheduleFull>=60_000;
                if (scheduleFull) lastScheduleFull=Date.now();
                const scheduleOnly=scheduleFull ? undefined : new Set(scheduleDirty);
                scheduleDirty.clear();
                await deliverScheduledResults(store,bb.sdk,groupTransport,signal,
                  ()=>ownerId()===owner && botId()===bot && !stateTransferBusy,scheduleOnly);
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
        unsubscribeChanges();
        await bridge?.dispose();
      }
    },
  });
  function taskList(topicId: number, language: "ru" | "en", bbOn = true) {
    const tr = (s: string) => bbText(t => translate(language, t), language, bbOn, s);
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
      let greetSweepAt=0;
      while (!signal.aborted) {
        const cfg = await settings.get();
        store.put(accessModeKey, cfg.accessPermissionMode);
        store.put(installKindKey, cfg.installKind);
        store.put(agentBotsKey, String(cfg.agentBots ?? "").split(/[\s,]+/).map(Number).filter(n => Number.isSafeInteger(n) && n > 0));
        store.put("rights:agent-chain-limit", Math.max(1, Math.min(50, Number(cfg.agentChainLimit) || 12)));
        store.put(leadsByDefaultKey, ["yes","no"].includes(String(cfg.leadsChatsByDefault)) ? String(cfg.leadsChatsByDefault) : "auto");
        // Two agents without the passport's word: nobody answers the owner without a mention — told once in his chat.
        {
          const me=botId(), owner=ownerId();
          if (me && owner && bridge && store.get(leadsByDefaultKey)==="auto" && !leadsByDefault(store,me) && !store.get(noLeaderToldKey)) {
            try {
              await sendFormattedText(telegram(botToken,lifetime.signal,15_000,()=>owner,apiRoot),{chatId:owner,topicId:0,markdown:NO_LEADER_LINE});
              store.put(noLeaderToldKey,Date.now());
            } catch { /* the next pass tries again */ }
          }
          if (store.get(leadsByDefaultKey)!=="auto" && store.get(noLeaderToldKey)) store.del(noLeaderToldKey);
        }
        store.put(curatorsKey, String(cfg.curators ?? "").split(/[\s,]+/).map(Number).filter(n => Number.isSafeInteger(n) && n > 0));
        consentTtlMs = Math.max(1, Number(cfg.consentMinutes) || 30) * 60_000;
        if (botId() && ownerId()) migrateLegacyRights(store, botId()!, profilePeople());
        // С62: people approved earlier (or whose conversation could not be made then) get their greeting, once.
        if (!legacyOperations && cfg.employeePrivateRequests && cfg.installKind==="employee" && cfg.chatEnabled && bridge &&
            botId() && ownerId() && Date.now()-greetSweepAt>60_000) {
          greetSweepAt=Date.now();
          const owner=ownerId()!, bot=botId()!;
          await greetPendingApproved({store,owner,bot,transport:chatId=>telegram(botToken,signal,15000,()=>chatId,apiRoot),
            current:()=>ownerId()===owner && botId()===bot && !stateTransferBusy,
            bindPerson:(subject,name)=>bindConversation(owner,bot,{chatId:subject,topicId:0,
              title:"Личка: "+(name||subject),privateChat:true,allowedSenderIds:[subject],acceptAfterSecond:0},signal),
            greetPerson}).catch(()=>{});
        }
        // Hold updates until the chat bridge exists, so none is consumed and lost.
        if (!cfg.enabled || stateTransferBusy || (cfg.chatEnabled && ownerId() && !bridge)) {
          ingressError = null;
          await pause(cfg.enabled ? 1000 : 5000);
          continue;
        }
        try {
          let updates: any[];
          const forumCommandsBot=botId();
          if (forumCommandsBot) {
            const key="group:forum-command-since:"+forumCommandsBot;
            if (!store.get(key)) store.put(key,Math.floor(Date.now()/1000)+1);
          }
          ingressPolling = true;
          try {
            updates = await tg<any[]>("getUpdates", {
              offset: offsetForServer(store, checkedApiRoot(await apiRoot())),
              timeout: 25,
              allowed_updates: ["message", "edited_message", "callback_query", ...(process.env.BB_TELEGRAM_GUEST_TOPICS ? ["guest_message"] : []), "my_chat_member"],
            });
          } finally { ingressPolling = false; }
          ingressError = null;
          for (const u of updates) {
            const moved=groupMigration(u);
            if (moved && botId()) {migrateGroupChat(store,botId()!,moved.from,moved.to);archive?.moveChat(botId()!,moved.from,moved.to);}
            try { if (botId()) { archive?.record(botId()!,u); learnTopicName(store,botId()!,u); } } catch { /* the archive never blocks a message */ }
            if (botId() && ownerId()) {
              const closed=guardGroupMemory(store,botId()!,ownerId()!,u);
              if (closed) await telegram(botToken,signal,15_000,ownerId,apiRoot)("sendMessage",{chat_id:ownerId(),
                text:`В «${closed.title}» появился другой человек: память группы теперь только этой группы, разговор — гостевой. Общую память можно вернуть, только когда в группе снова останетесь вы одни.`}).catch(()=>{});
            }
            if (skipExcludedForumUpdate(store, u)) continue;
            const privateOwner=ownerId(),privateBot=botId();
            if (privateOwner && privateBot && cfg.chatEnabled && bridge &&
                await forumCommand(privateOwner,privateBot,signal,u)) {
              store.put("ingress:offset",u.update_id+1);
              continue;
            }
            // С71: the owner's /model in a bound group or topic — this conversation's model or provider.
            if (privateOwner && privateBot && cfg.chatEnabled && bridge && await groupModelCommand({store,sdk:bb.sdk as never,
                owner:privateOwner,bot:privateBot,update:u,
                send:(chat,topic)=>text=>sendOutboundMessage(telegram(botToken,signal,15000,()=>chat,apiRoot),{chatId:chat,topicId:topic,text})})) {
              store.put("ingress:offset",u.update_id+1);
              continue;
            }
            // The owner's «Да / Нет» under a question from another conversation (any kind of install).
            if (privateOwner && privateBot && cfg.chatEnabled && bridge && await acceptOwnerAskCallback({store,bot:privateBot,owner:privateOwner,
                tg:telegram(botToken,signal,15000,()=>privateOwner,apiRoot),deliver:deliverOwnerAnswer,
                tgFor:chat=>telegram(botToken,signal,15000,()=>chat,apiRoot)},u)) {
              store.put("ingress:offset",u.update_id+1);
              continue;
            }
            if (!legacyOperations && cfg.employeePrivateRequests && cfg.installKind==="employee" && cfg.chatEnabled &&
                privateOwner && privateBot && await acceptPrivateEmployeeUpdate({
                  store,owner:privateOwner,bot:privateBot,
                  current:()=>ownerId()===privateOwner && botId()===privateBot && !stateTransferBusy,
                  transport:chatId=>telegram(botToken,signal,15000,()=>chatId,apiRoot),
                  bindPerson:(subject,name)=>bindConversation(privateOwner,privateBot,{chatId:subject,topicId:0,
                    title:"Личка: "+(name||subject),privateChat:true,allowedSenderIds:[subject],acceptAfterSecond:0},signal),
                  greetPerson,
              },u)) {
                store.put("ingress:offset",u.update_id+1);
                chatWake?.();
                continue;
            }
            if (botId() && u.my_chat_member) {
              rememberMembership(store,botId()!,u);
              const me = await checkBot(tg,botId());
              store.put(privacyKey(me.id), !me.readsAllGroups);
              if (ownerId()) await sendGroupVisibility();
            }
            // С54: the bridge-wide switch of the default topic pickup (stored so the pure checks see it).
            if (store.get(forumAutoKey)!==(cfg.autoTopics!==false)) store.put(forumAutoKey,cfg.autoTopics!==false);
            if (privateOwner && privateBot && cfg.chatEnabled && bridge) {
              // С66: thread titles follow the place — once for threads bound before, then on a rename of a topic or group.
              void threadTitlesPass(store,bb.sdk,privateBot).catch(()=>{});
              const renamedGroup=rememberGroupTitle(store,privateBot,u);
              const renamedTopic=(u as {message?:{forum_topic_edited?:{name?:string};chat?:{id?:number}}}).message;
              if (renamedGroup!==undefined) void applyThreadTitles(store,bb.sdk,privateBot,renamedGroup).catch(()=>{});
              void checkChatAgents(u,signal).catch(()=>{});
              activeTelegramWrites++;
              try {
                if (await inheritForumTopic(privateOwner,privateBot,signal,u)) {
                  if (renamedTopic?.forum_topic_edited?.name && Number.isSafeInteger(renamedTopic.chat?.id))
                    void applyThreadTitles(store,bb.sdk,privateBot,renamedTopic.chat!.id!).catch(()=>{});
                  store.put("ingress:offset",u.update_id+1);
                  continue;
                }
              } catch {
                bb.log.warn("Telegram forum topic provisioning deferred");
              } finally { activeTelegramWrites--; }
            }
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
            if (cfg.chatEnabled && !legacyOperations && cfg.installKind==="employee" && privateOwner && privateBot) {
              const unbound=unboundAddressedGroupMessage(store,u,privateBot,store.get<string>("bot:username")??"");
              if (unbound) await bindConversation(privateOwner,privateBot,{chatId:unbound.chatId,topicId:unbound.topicId,
                title:unbound.topicId ? `${unbound.title} · тема ${unbound.topicId}` : unbound.title,
                acceptAfterSecond:unbound.date-1},signal).catch(()=>false);
            }
            if (cfg.chatEnabled) void checkChatAgents(u,signal).catch(()=>{});   // in the background: no message waits
            if (cfg.chatEnabled && acceptGroupUpdate(store, u, ownerId(), botId())) continue;
            const route = routeUpdate(u, ownerId(), store.get("pair:code"));
            if (route.kind === "pair") {
              if (profilePath!==undefined && route.userId!==readEmployeeProfile(profilePath).owner) {store.put("ingress:offset",u.update_id+1);continue;}
              store.put("owner:id", route.userId);
              store.del("pair:code");
              // An employee's install names its project: the owner's chat goes there once the chat bridge runs (С102).
              if (String(cfg.employeeProject ?? "").trim()) store.put("owner-chat:bind-employee-project",true);
              // С102: an employee's owner hears the organization and the employee's name, not the setup's details.
              const employeeInstall=cfg.installKind==="employee";
              if (employeeInstall) bb.log.info("Telegram setup: "+privacySummary(store, botId()!));
              else await tg("sendMessage", {
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
                if (setup.role || employeeInstall) await tg("sendMessage",{chat_id:route.userId,...welcomeScreen({...setup,
                  privacy:store.get<boolean>(privacyKey(botId()!)),employee:employeeInstall,
                  organization:String(cfg.organizationName ?? "").trim(),name:String(cfg.employeeName ?? "").trim()})});
              }
              wake?.();
            } else if (route.kind === "chat" && cfg.chatEnabled && bridge) {
              bridge.accept(route.input);
              chatWake?.();
            } else if (route.kind === "tasks")
              await tg("sendMessage", {
                message_thread_id: route.topicId || undefined,
                text: taskList(route.topicId, cfg.language as "ru" | "en", bbMentionsOn(store, cfg.bbMentions as BbMentionsSetting)),
              });
            if ("callbackId" in route && route.callbackId)
              await tg("answerCallbackQuery", {
                callback_query_id: route.callbackId,
              }).catch(() => {});
            store.put("ingress:offset", u.update_id + 1);
          }
          if (botId() && Date.now()>=nextUpgradeCheck) {
            nextUpgradeCheck=Date.now()+10*60_000;
            // A basic group upgraded while the bridge was away: Telegram names the new ID on request.
            for (const chat of basicGroupChats(store)) {
              // getChat still answers for an upgraded group; a member count names the new chat.
              // The ingress transport is bound to the owner's chat; ask about the old group directly.
              try { await telegram(botToken,signal,15_000,()=>chat,apiRoot)("getChatMemberCount",{chat_id:chat}); }
              catch (error) { if (error instanceof TelegramFailure && error.migrateTo) {migrateGroupChat(store,botId()!,chat,error.migrateTo);archive?.moveChat(botId()!,chat,error.migrateTo);} }
            }
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
    clearTimeout(firstExpiry);
    lifetime.abort();
    wake?.();
    await flight;
    await bridge?.dispose();
  });
}
