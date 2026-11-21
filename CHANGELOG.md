# 0.9.44

- Admit a single native BB follow-up into the current turn when its sender and the existing reply route are verified. Keep separately addressed work in the durable queue.
- Carry text, photos and documents with or without a caption across authorized group and isolated private routes. Ordinary documents retain their original name and bytes.
- Extend explicit and scheduled outbound posts to text, a supported photo or a document. Keep existing permissions, confirmations, schedule proof, topic scope and duplicate protection.

# 0.9.43

- Accept incoming PDF documents up to 2 MiB through the cloud Telegram Bot API on configured isolated group and approved private routes. Files are checked and staged through the existing isolated inbox and transfer path.
- Keep group and private admission rules, addressed replies and the local Bot API file path.

# 0.9.42

- Deliver private follow-up questions from the paired owner to a busy assistant through BB steering. Send each addressed answer back to its original Telegram message while work continues.
- Allow queued native child notifications without identifiable turn results to join ongoing work. Keep independent requests, delegated results and handoffs subject to their existing routing rules.

# 0.9.41

- Apply explicit forum defaults to new topics and keep individual topic settings. Route each bot by its own address in the same group and use Telegram topic names as reference data.
- Execute direct authorized forum commands without a second card. Deletion requires an exact topic link and separate authorization to delete. Older cards cannot trigger topic operations.
- Keep each topic's BB thread, context and media scoped to its own binding. New work topics require a distinct isolated executor before the bridge starts accepting tasks.

# 0.9.40

- Add paired-owner forum commands in the existing private chat, independent of a restored model session's tool inventory. Create, close and reopen topics from a preview card. Delete a specific topic only after a separate confirmation that warns about permanent loss of its Telegram history.
- Let administrators delegate work forum topic management to an owner project. Private and work forums retain their distinct admission and worker rules. A new work topic requires an explicit worker binding.

# 0.9.39

- Add opt-in private access requests for employee bots with one paired-owner decision card and revocation.
- Route approved private messages separately by Telegram user ID through administrator-provisioned isolated BB workers. Private routes stay disabled by default. Group routes and the paired owner's direct chat retain their prior policy.

# 0.9.38

- Deliver authorized group photos as native agent input, including an explicit same-topic reply and unambiguous recent media explicitly referenced by the paired owner.
- Bind a closed owner-only forum topic to its own thread in an existing assistant project. Keep the paired private chat and project menus available and allow new-topic requests from the paired owner's current private Telegram message.
- Permit an optional exact name address in mention mode and deliver verified PNG and JPEG files from group output directories to the original topic. Isolated image export requires the same bridge version and an updated launcher on the worker side.

# 0.9.37

- Remove standalone bridge markers from outgoing Telegram text, including group replies with attachments, while preserving private reply deduplication.
- Let the paired owner request a new topic from a bound topic in the same private forum. The bridge creates a dedicated BB thread, accepts requests only from the owner, and posts the supplied first message or a fixed confirmation.

# 0.9.36

Single asynchronous Codex questions from direct or delegated Telegram requests can be answered in the original private chat with a choice or a text reply. The bridge checks the originating request and skips forms that already closed or expired. Forms with multiple questions still open in BB.

# 0.9.35

A coordinator can identify the exact worker turn it covered in its final private Telegram reply. The bridge waits for confirmed delivery before closing that result. Launch acknowledgements, undelivered finals, and separate worker turns still allow their own follow-up reports.

# 0.9.34

Rights in three layers. What the bot may do is set once at install (assistant or employee); who may give it tasks is an access list kept by the owner; each group is set up separately with buttons and a note that grants no access. Strangers in a group can address an employee only if the group allows it; their turns run in the restricted mode and actions they ask for wait for consent of a person with access, phrased in plain words and expiring after a set time. Codex installs and the personal assistant never open a group to strangers and say so to the admin. Setup screens replace the old operations menu (the old menu stays only with BB_TELEGRAM_LEGACY_OPERATIONS=1). An employee keeps its private chat and groups in one project and one folder. The welcome screen shows the bot's group privacy mode and asks to turn it off in BotFather; when it is off, the group notice says plainly that the bot sees all messages and handles only what the group settings allow.

# 0.9.33

A group answer of exactly NO_REPLY stays silent in any group turn. A scheduled check does exactly its own task, re-reads its tools first and ignores the conditions of other requests in the topic.

# 0.9.32

Explicit delivery from BB sends images (also without alt text or by a short file name), videos and files like a routed answer, reports each file in `telegramDeliveryStatus`, and status shows a bound private chat as ready.

# 0.9.31

Let the owner ask an employee in a group to check something later: at the due time the employee's own turn re-reads the topic and its tools, then answers under the original message or stays silent.

# 0.9.30

Evaluate group task checkpoints against a project read adapter at the deadline and deliver one reply to the original topic or finish silently.

# 0.9.29

Show Telegram Privacy Mode in setup and notify the administrator about group visibility changes. Recover a started action by reading its verified receipt and returning one result to the original destination.

# 0.9.28

Give a verified user binary personal access to an employee across direct messages and enrolled groups. Honor the requested reply destination for that one result and keep older restricted grants intact.

# 0.9.27

The owner can view existing legacy topic bindings in My groups. The list preserves existing topic routing.

# 0.9.26

- Execute an explicitly requested, fully specified personal action from a managed group without an extra DM when the operation permits immediate execution. Preserve private selection and configured approvals, source visibility checks, and write-time revocation.

# 0.9.25

- Apply per-person resource grants across managed groups, with explicit private or group delivery and an independent audience source check.

# 0.9.24

- Show active packaged or local assignments and missing assignments immediately after pairing and on /start.

# 0.9.23

- Add opt-in employee limits, private group settings cards, scoped conversation and action adapters, selective approvals and verified return links. See [setup and adapter contract](docs/employee-policy.md).

# 0.9.22

- Set `BB_TELEGRAM_FORUM_TOPIC_SCOPE=<negative-chat-id>:<positive-topic-id>` on the receiver to process only that topic in one supergroup. The poller discards other topics before routing or storing content, including guest mentions and edits. Other groups and saved bindings keep their existing policy. Unset the variable and restart the receiver to restore the previous routing. An invalid setting suppresses all supergroup ingress.

# 0.9.21

- Carry the private assistant’s current project and one-off task routing into a provider handoff. The successor can use the existing project and child threads even when the old conversation is abbreviated.

# 0.9.20

- Keep the personal coordinator’s instructions and skills bound to the private chat after changing providers. Pending messages wait for the binding to be saved, including after a restart.

# 0.9.19

- Retain the latest structural guest delivery metadata for configured forums to diagnose topic routing.

# 0.9.18

- Receive explicitly addressed guest text messages in assigned forum topics.

# 0.9.17

- Include the original forum message, task ID and revision in automatically presented proposals.

# 0.9.16

- Automatically present a project-prepared proposal in the paired owner chat for an explicitly assigned forum topic.

# 0.9.15

- Deliver verified project result links after a selected owner proposal completes.

# 0.9.14

- Resolve an original private forum message link to its active group task from a verified owner turn.

# 0.9.13

- Accept ordinary Russian replies to numbered proposals and ask which items to execute when a reply only confirms a multi-item list.

# 0.9.12

- Present versioned group-task proposals in the paired owner’s private chat and publish an immutable selection receipt to the assigned project adapter.

# 0.9.11

- Recheck configured source grants for the destination before delivering group results and attachments.

# 0.9.10

- Keep commands intact when Telegram references the forum topic root. Preserve the context of replies to ordinary messages.

# 0.9.9

- Treat a forwarded message, including a forwarded post with a photo, and the owner's question about it as one task. After a forward the bridge waits up to 10 seconds for a comment instead of 4. The agent receives one request structured as «Пересланное: … / Вопрос пользователя: …».
- If the second half arrives after the first was already dispatched, within 30 seconds and while that turn is verifiably still running, it is added to the running turn under the same Telegram reply instead of starting a separate turn. Otherwise it remains an ordinary separate request.

# 0.9.8

- Return a delegated worker's result to Telegram when notices about the worker's own child threads, or a message from its coordinator, joined its running turn. These no longer make the turn's destination ambiguous.
- When one delegated turn mixes separate submissions, still report it to the coordinator, marked as mixed, instead of dropping the Telegram return.

# 0.9.7

- Report each failed Telegram coordinator turn, including failures followed by another task before the bridge polls. Reply to the originating message for new requests.
- Show the retry state for the affected task. Retain the final response from its successful turn and avoid resubmitting the original operation from the bridge.

# 0.9.6

- Schedule a conditional group reminder from a direct user turn in the paired BB coordinator. Confirmation stays in BB and the reminder replies to the original Telegram group task.
- When binding a group, report whether Telegram privacy settings may prevent ordinary mentions from reaching the bot. The owner can grant visibility in that group.

# 0.9.4

- The paired owner can schedule a reminder about a group task from the private bot chat. A PDF received in reply to the task, a PDF delivered by the bot, or a registered decision can satisfy its matching reminder.
- Pending reminders survive restarts. Before sending, the bridge rechecks the group binding and sender permissions. After an uncertain Telegram send, it retains the receipt for reconciliation.

# 0.9.3

- Return valid RPC receipts for queued, revoked, rejected and uncertain outcomes without a Telegram message ID.

# 0.9.2

- Return an approved text result from the paired owner's private Telegram request to the original group message. The bridge retains the destination, checks the current binding and records the delivery receipt. Interrupted sends with an unknown outcome stay available for reconciliation.

# 0.9.1-personal.29

- Isolated workers receive the PDF output directory and link format with each group request. A reply requesting changes produces a separate file.
- Tested in a Telegram forum topic with an online Codex worker in a separate BB instance. The original PDF contained the value from the incoming file, and the revised PDF preserved that value and added the requested change.

# 0.9.1-personal.28

- Run participant tasks in a separately configured BB instance. The personal bridge keeps the bot token, sender permissions and original Telegram destination. The group worker receives the task and selected attachments. A PDF linked in its final answer returns to the originating message.
- Before enabling a participant allowlist or invoking the assistant as any group member, follow [isolated group setup](docs/isolated-groups.md) and bind the topic again. Existing participant jobs in local queues are revoked. Local group invocations by the paired owner and private chat bindings continue to work.
- Verified a real test-group document and PDF reply with an isolated Mac Docker runtime and deterministic model fixture. Online provider sign-in and independent onboarding remain under acceptance.

# 0.9.1-personal.27

- Group topic bindings record their BB project. The bridge checks the thread before submission and before delivering a prepared reply or opening a PDF.
- After updating an installation that previously registered multiple group projects, bind the group topics again to confirm their project IDs.

# 0.9.1-personal.26

- Send `/work` in a connected assistant chat to list active direct child tasks across all pages. The command reads BB thread status without starting a model turn.

# 0.9.1-personal.25

- The bridge CLI restricts commands issued from a registered group project or its bound thread to topic-scoped history search. This also covers child threads in the same group project. OS-level isolation remains necessary for untrusted participants.
- Updated the public description and linked the assistant installer. The plugin ID remains `telegram-projects`.

# 0.9.1-personal.24

- Inspect administrator permissions of the paired owner and the bot in a configured channel. An owner can request an edit to a manually published text post. This never grants a receipt for deletion.
- Optionally retain all received group text for scoped full-text retrieval. The existing 30-day mode remains available. Use topic ID zero for plain groups.
- Reclaim completed Telegram cache entries after 30 days or above 8 GiB. Entries younger than one day, active work, legacy unattributed downloads and files outside the managed cache are retained.

# 0.9.1-personal.23

- Show Telegram’s native typing indicator in the originating group topic while the assistant handles an authorized request. A silent progress reply stays visible in the topic until completion and is then deleted.

# 0.9.1-personal.22

- Collect example photos and documents for an addressed group request, including voice replies to a PDF. Match the sender, topic and pending request. Reuse the local Bot API file receiver on the bound host.

# 0.9.1-personal.21

- Optionally search up to 30 days of received text in the addressed group topic. Include up to five matched passages with links for authorized text and transcribed voice requests.

# 0.9.1-personal.20

- Deliver local PDF exports to the originating Telegram group topic. A reply to a delivered document identifies its original path and content hash in the bound thread.

# 0.9.1-personal.19

- Accept authorized voice corrections in group topics and preserve the target Telegram message of text and voice replies. Use the configured transcription service before dispatch.

# 0.9.1-personal.18

- Allow selected Telegram participants to invoke a dedicated group thread. Optionally collect recent text in one topic without starting the model until addressed. Verify group visibility before enabling context.

# 0.9.1-personal.17

- Collect nearby private Telegram messages into one ordered BB request after four seconds of quiet. Preserve forwarded text, files, photos, transcribed voice and reply excerpts. An explicit request to wait for material extends the window to 90 seconds.
- Preserve a multipart request across a restart during attachment or voice preparation.
- Tie confirmed stop actions to the observed turn. Suppress delayed results and unsent queued answers belonging to the cancelled Telegram request while allowing subsequent tasks to complete.

# 0.9.1-personal.16

- On stock BB, route delegated results using the child's own run events. A worker can handle successive Telegram requests while each result keeps its original destination.
- Reconcile late pickup retries after handoff cancellation. First-time delegation can use a registered project that has no environment yet.
- Bind a group topic to a dedicated workspace and restrict requests by sender and topic. The personal chat menu also checks existing buttons before opening a project reserved for a group.
- Support posting, editing and deleting posts in an explicitly configured channel from the owner's private chat.
- Check the length of voice files copied from a remote local Bot API before transcription.

# 0.9.1-personal.15

- Cancelling or rolling back a handoff removes its pending native pickup retries by exact request identity; unrelated queued work is preserved.
- Reconcile a lost deletion response by rereading the queue, without replaying a turn or clearing other messages.
- Validation: 165 tests and TypeScript pass. This cleans up pending retries; it does not interrupt an already running target turn.

# 0.9.1-personal.14

- Leave inline retries of failed handoff pickups to BB's native scheduler, avoiding a short bridge wait replacing the provider reset deadline on BB 0.49.
- Keep source/worker dispatch holds; unrelated work in the new target cancels the switch before moving children or the Telegram binding.
- Report structured provider limits without claiming a retry is pending when the native queue is empty.
- Validation: 163 tests and TypeScript check pass. Live quota acceptance remains required.

# 0.9.1-personal.10

- Optional bot-only local voice router via voiceRouterPath. Empty keeps the BB ASR service; configuring it never changes global BB voice settings.
- Private temporary recordings, bounded output and timeout, cancellation, cleanup, and sanitized failures. No external ASR fallback on local-router failure.
- Voice failure text explicitly states that the message was not sent to the assistant.

# 0.9.1-personal.9

- Fix Telegram voice transcription: preserve voice.ogg filename in BB multipart upload.
- Regression coverage for cloud and local Bot API; filename-less upload reproduced HTTP 502, named upload succeeded on Tru.

# Changelog

## 0.9.1-personal.8 — unreleased

- Show connected personal chats without a false empty-database/topics warning.
- Resolve child outcomes by native `turnId` when BB supplies it, preserving the originating task after a worker is reused. Ambiguous legacy notifications still fail closed; BB-origin replies remain in BB.
- A failure before any turn starts (`turnId: null`) cannot inherit an older task result.
- The outcome fix requires the corresponding BB core change. Installing this plugin alone does not repair ambiguous notifications on stock BB 0.49.0.
- Validation: 114 plugin tests, TypeScript check; BB core change separately passed 12 server tests and 4 compatibility tests. Live acceptance of the combined update remains pending.


## 0.9.0 — 2026-10-02

Ready for any BB user. The bot owner is linked with a one-time `/start <code>` from the Connection tab instead of a built-in account; the bot identity is learned from its first token. No personal paths remain: the plugin's own receiver writes incoming messages straight to plugin storage, and the companion folder, SMS topic and time zone are optional settings. The default Env Catalog name is `TELEGRAM_BOT_TOKEN`. Every bot text has an English translation, checked by a test, so English switches the bot menu, topic introductions, cards and messages. README and overview rewritten in English and Russian; MIT license.

Готов для любого пользователя BB. Владелец бота привязывается одноразовой командой `/start <код>` с вкладки «Подключение», а не зашит в код; бот определяется по первому токену. Личных путей больше нет: приёмник плагина пишет входящие прямо в хранилище плагина, а папка компаньона, тема SMS и часовой пояс стали необязательными настройками. Имя токена в Env Catalog по умолчанию — `TELEGRAM_BOT_TOKEN`. У каждого текста бота есть английский перевод, это проверяет тест. README и обзор переписаны на английском и русском; лицензия MIT.

## 0.8.0 — 2026-10-02

Отчёты агентов отправляются нативными Rich Messages: шапка с проектом, разделом, агентом и временем, ответ агента — свёрнутым блоком, где Telegram сам рисует таблицы, заголовки, код и списки; при отказе Rich Messages уходит HTML-версия. Кнопка «🔌 Подключить здесь» подключает тред из отчёта к теме, не затирая сам отчёт. Режим саммери: модель BB, выбранная родным селектором провайдера и модели BB, пишет 3–6 пунктов в скрытом треде; саммери тоже свёрнуто, при задержке больше 3 минут приходит полный ответ. Инфоблок команд на вкладке «Обзор» и меню бота строятся из одного списка, меню сверяется с Telegram. Темы проектов называются без «📂», кнопка «Открыть BB» ведёт на страницу проекта. Исправлено: задача, созданная и закрытая между двумя опросами, теперь даёт и «Задача завершена».

## 0.7.0 — 2026-10-02

Отчёты агентов в темы проектов по событиям BB `thread:changed`: закончил ход, ждёт ответа, остановлен или упал — с подписью проекта, раздела, треда и агента. Вкладка «События» заменяет флаги notifyTasks / notifyWorkerErrors / soundOnReview: каждое событие со своим звуком и фильтром проектов, прежние значения переносятся автоматически. Скрытие проекта или раздела в Project Folders удаляет его тему из Telegram. Страница плагина разделена на вкладки «Обзор», «События», «Темы», «Подключение», «Общие».

## 0.6.0 — 2026-10-02

Работа на хабе после переезда BB. Токен бота берётся из Env Catalog (`TG_AIVECH_BOT`) или задаётся вручную как секретная настройка плагина; закрытый файл `aivech.json` плагину больше не нужен. Плагин сам принимает updates (`telegram-ingress`) и отвечает на `/tasks`; companion переведён в режим только отправки SMS. Пустая база плагина больше не создаёт полный набор тем рядом с существующими: создание ждёт явного подтверждения, `bind` принимает существующую тему. Страница плагина оформлена в стиле Pokecut.

## 0.2.0 — 2026-09-12

Двусторонний транспорт через единственный companion-poller и постоянную очередь. Меню проектов, дополнительные темы, создание и подключение сессий BB, выбор разделов/агентов/моделей, остановка, последний ответ, голос через BB transcription, native Rich Messages, обновляемый статус и обработка простых вопросов/разрешений. Старые кнопки и ответы из прежней привязки больше не выполняют действие в новом разговоре. Сквозной тест текста, повторного подключения и голоса пройден.


## 0.1.0 — 2026-09-12

Первая персональная версия: синхронизация проектов с темами Telegram, уведомления Tasks, постоянная очередь доставки, страница BB и CLI для диагностики/восстановления. Снимок companion-сервиса с командами и маршрутизацией SMS. Документированы исследование рынка, архитектура двустороннего транспорта и этапы развития.

Общение с BB, управление сессиями, разрешения из Telegram, транскрибация и native Rich Messages ещё не входят в эту версию.
