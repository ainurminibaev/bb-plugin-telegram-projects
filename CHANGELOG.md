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
