---
name: telegram-projects
description: "Operate the personal BB Telegram bridge: project topics, connected chats, voice and Tasks notifications."
---

# Telegram Projects

Use `bb telegram-projects status --json` and `chat-status --json` for diagnostics. `sync` reconciles project topics and Tasks; `menu <project-id>` sends the chat menu to that project's main topic. `test <project-id>` sends a labelled Tasks test. `bind <project-id|sms|navigation> <topic-id>` repairs a main topic after verifying its identity. `chat-forget <topic-id>` removes only its conversation binding, preserving history.

The owner's Telegram menu supports /project, /projects, /menu, /chats, /new, /model, /section, /history, /stop, /disconnect and /tasks. Additional Telegram topics bind through /project. A new session starts on its first text/voice message; existing sessions connect explicitly and remain visible in BB. Only bound threads and Tasks are observed. Do not attach unrelated or hidden chats automatically.

Settings chatEnabled and richReplies control conversations and native Rich Messages. Incoming text/voice uses the existing owner-only companion, a durable local spool, and BB SDK. It is the only Telegram poller: never start another getUpdates/webhook receiver with the token. Voice uses BB system.transcribeVoice; do not request separate credentials. Questions depend on provider support; complex forms link to BB.

Personal host paths and IDs remain fixed; token stays in the private config. Keep plugin storage on updates. Unknown mutation outcomes must be checked, not automatically replayed. Read README.md and docs/usage.md in the source repository for limits and recovery. Never print token values or private message queues.

Version 0.3 adds settings directly in the Telegram nav panel: language ru/en, delivery/chat flags, public BB URL, read-only BotFather diagnosis and same-bot token rotation. Never return credentials. getMe exposes has_topics_enabled and allows_users_to_create_topics; Restrict bot usage needs manual inspection. Do not enable Bot Management/Bot-to-Bot for BB-internal agent communication. Language changes new service text and menus, not user content.

Version 0.3.1 wakes BB on durable spool changes; timed polling is recovery only. Menu callbacks edit the clicked card; ordinary messages and answers stay separate. The receiver uses grammY long polling and silent callback acknowledgement. Rich inline button layouts remain research, not an enabled feature.

Version 0.4 adds optional CLI Agents catalog/select RPC after model selection for new sessions. Selection is target-scoped and revalidated at spawn; marker appears only in the initial prompt. No global CLI config changes. Provider/section changes clear the profile. Existing sessions keep their native role. Section profiles require an already registered matching environment.

Use `/server` before choosing a model to select the new chat host. The project needs a source on that host. `/profile` opens native profiles; empty catalogs show a default-agent explanation. Existing chats keep their host.

## Personal bridge delivery overlay
Use normal Markdown for public replies: HTTP(S) links stay clickable; basic emphasis,
headings, lists and code render to Telegram HTML. Long replies are split without
truncation. Reference generated files with absolute Markdown links; the bridge uploads
allowed files from the connected thread or its visible direct children before the final
text. Files must currently exist on the bridge host, be under an environment workspace,
not a hidden path, and at most 49 MiB. Unsupported/unavailable files and uncertain
uploads are explicitly labelled. Never claim delivery before a bridge receipt.
Do not tell the user to click a local server path. Explain work in ordinary language,
without dispatch/subthread/tool names. Only public progress is forwarded, not reasoning.

Failure overlay: failed parent and visible direct child threads produce a deduplicated
Telegram notice. Retry time is taken from the actual durable threads.queue row, not
from historical retry decisions. With no row, say no automatic retry is scheduled.
Only sanitized failure categories are shown; never forward raw provider error details.

## Explicit delivery from BB

Do not automatically send an answer to Telegram merely because the BB thread is
bound to a Telegram chat. A BB-origin request stays in BB. Use `sendToTelegram`
only when the user explicitly asks to send that result to Telegram. This is an
extra delivery, not a change to the destination of future requests.

Call the plugin RPC with a JSON input file containing `threadId`, the bound
`topicId`, `text`, a stable unique `deliveryId` (8–100 ASCII letters/digits/_/-),
and `explicit: true`. Reuse the same delivery ID for retries of the same delivery.
A successful RPC means the output was queued, not that Telegram acknowledged it;
inspect delivery status before claiming it arrived. Never put secrets in the
message or command arguments. The thread/topic binding must match.
# Private source migration

Changing an installed Git source with the same plugin ID requires a state
transfer; removal deletes settings and secrets and may retain its database. Do not
remove the old installation before preparing and verifying a recovery copy.

The administrative `exportPrivateState` RPC takes `{ "confirm": true }`.
Disable both `enabled` and `chatEnabled` first and wait for receivers to stop.
It writes settings (including credentials) and plugin state to a mode-0600 file
inside the server user's mode-0700 `~/.bb-plugin-backups/telegram-projects/`.
Only the backup ID, SHA-256 and row count are returned. Never print, attach,
commit or copy the backup into a project. Keep it on the same server.

On a fresh, disabled installation, `restorePrivateState` takes `confirm: true`,
the returned `id` and `sha256`. It refuses conflicting nonempty state, altered
copies, unsafe file permissions and a replay that would roll back changed
state. It restores with both receivers disabled. Verify identity, bindings,
settings and receipts before separately enabling the receiver. These APIs do
not switch bots, log out Telegram, or enable polling automatically.

For a deliberate change of bot identity, `replacePrivateState` accepts
`confirm: true`, candidate snapshot `id`/`sha256`, and
`expectedCurrentSha256` from a fresh disabled export. Unlike ordinary restore,
this replaces all plugin rows. It first writes a private rollback export and
returns that export's receipt; it refuses changed checkpoints or active
receivers. Settings and store use separate transactions: a process crash or
settings failure requires inspection and a new disabled export before retry;
never enable receivers blindly after a failed call.

Prepare a candidate containing the confirmed owner and destination binding
before starting polling. Without an owner, ordinary pending messages are
ignored during pairing. Never carry the old bot's ingress offset, queued
messages, reply routes or delivery receipts to a different bot. Establish the
destination thread's current event cursor instead of replaying its history.
Keep both receivers disabled until Telegram's own local-server transition and
identity checks are complete. Replacement itself makes no Telegram requests.
To roll back, export the current disabled state, then replace it using the
returned rollback snapshot and the new current checkpoint. This does not undo
external Telegram deliveries or move a bot back between Bot API servers.

## Delegating a Telegram-origin task

For the CURRENT incoming task only, a hidden input block carries
`[bb-telegram-reply-route:<uuid>]`. Do not quote it in answers or reuse a token
from earlier history for a new BB-origin task. It identifies delivery, not a
project, account, memory or permission grant.

Choose the project, environment and worker with the normal BB registry and
dispatch instructions. Preserve the transport identity through RPC JSON input:

- `sendDelegated`: parentThreadId, routeToken (current UUID), threadId of the
  existing direct child, text and stable deliveryId.
- `spawnDelegated`: parentThreadId, routeToken, projectId, environmentId, title,
  text, stable deliveryId, optional providerId/model. Create projects through
  normal BB APIs first. The RPC uses native BB spawn with parent notifications
  enabled and returns threadId.

These methods attach delivery metadata to native send/spawn. BB owns execution,
queue and retries. Successful submission is not completion: wait for the native
child result and verify it. Never bypass an uncertain delivery error by changing
deliveryId; inspect the native queue/thread first to avoid duplicate work.
BB-origin tasks use normal dispatch without a Telegram route token.


## Image delivery

Local image links (PNG, JPEG, WebP, GIF) in the final answer are uploaded as
Telegram photos by default. PDFs and other supported artifacts remain documents.
When the user explicitly requests an image as a file/document or an uncompressed
original, add the standard Markdown link title `"telegram:document"` to that
artifact only: `[Original](</absolute/project/image.png> "telegram:document")`.
Do not add this title unless the current request asks for document delivery.
The title is transport metadata and is removed from the Telegram reply. It does
not change the route, permissions, or format of other artifacts or tasks.
Photos may be recompressed by Telegram; do not promise byte-identical originals.
A rejected/oversized photo is not silently retried as a document. Explain the
failure and offer a resized photo or, with the user's agreement, a document.


A single image is sent without a Telegram caption or a duplicate technical
"file sent above" message. If the image is the entire requested answer, return
only its Markdown link. For several images, use concise descriptive Russian
link labels; they become captions. Do not use filenames, internal paths or test
markers as captions. The bridge supplies a neutral numbered caption when a label
is unsuitable. Document mode remains per-artifact and requires an explicit user
request. A successful image-only response has the image's delivery receipt;
never send an extra message merely to make it count as delivered.
