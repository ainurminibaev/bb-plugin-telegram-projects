# Telegram Bridge for BB — use BB agent threads from Telegram

Send a file or a follow-up from Telegram to a BB thread and receive the result in the chat where you asked. This fork connects a personal bot to an existing assistant conversation and supports group topics and channel publishing. For the complete assistant, start with [Personal Agent for BB](https://github.com/ainurminibaev/bb-personal-assistant).

**Русский.** Telegram-мост для BB связывает личный чат с рабочим тредом. Отправь документ боту с телефона, получи результат в Telegram и продолжи тот же разговор в BB. Для группы можно подключить отдельную тему. Условия установки и отличия форка описаны в [FORK.md](FORK.md).

## Upstream Telegram Projects documentation

[![BB](https://img.shields.io/badge/BB-%3E%3D0.43-blue.svg)](https://getbb.app)
[![Plugin SDK](https://img.shields.io/badge/Plugin%20SDK-%3E%3D0.4.87-green.svg)](https://getbb.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Work with your BB agents from Telegram. Every BB project gets its own topic in a private chat with your bot: agents report there when they finish, stop or need an answer, Tasks events arrive in the same place, and you can talk to any BB thread by text or voice.

**English** · [Русский](#русский)

## What you get

- **Agent reports.** When an agent finishes a turn, waits for your answer or stops, its project topic gets a card with the project, section, thread, agent and time. The reply is collapsed; Telegram renders its tables, headings, code and lists natively.
- **Summaries.** Instead of the full reply, a BB model of your choice can write 3–6 points: what was done, the result, what needs attention. You pick provider, model and reasoning with BB's own model picker.
- **Connect from the report.** «🔌 Connect here» binds the reported thread to the topic. Your next messages go to that agent, and its answers come back to Telegram.
- **Chat with BB.** Start a new chat or connect an existing one in any project topic. Voice messages are transcribed by BB's transcription service.
- **Tasks events.** New tasks, status changes, completion, due dates and worker errors from the BB Tasks plugin.
- **Event rules.** Turn every agent and Tasks event on or off, with or without sound, for all projects or selected ones.
- **Project Folders aware.** Hiding a project or section in Projects & Sections removes its topic from Telegram.
- **Russian or English.** The plugin page, the bot menu, topic introductions, cards and bot messages follow the selected language.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather). In *Bot Settings → Threads Settings* turn **Threaded Mode** on and **Disallow users to create new threads** off.
2. Install the plugin and open **Telegram** in the BB sidebar.
3. **Connection** tab: paste the bot token and press *Check and save token*. Alternatively store the token in Env Catalog under `TELEGRAM_BOT_TOKEN` (the name is a setting).
4. **General** tab: turn on *Project sync* and save.
5. **Connection** tab → *Owner*: open the shown link or send `/start <code>` to the bot. The bot answers only this Telegram account from then on.
6. **Overview** tab: press *Create topics*. One topic per BB project appears in the bot chat, plus a navigation topic.

## Bot commands

Commands work inside a project topic. The bot menu in Telegram is built from the same list, and the Overview tab shows whether Telegram serves it.

| Command | What it does |
| --- | --- |
| `/menu` | Topic card: connected chat, server, agent, model, section and controls |
| `/project` | Bind this topic to a BB project |
| `/new` | The next message starts a new BB thread |
| `/chats` | Find and connect an existing thread |
| `/history` | Last reply of the connected thread |
| `/stop` | Stop the agent after confirmation |
| `/disconnect` | Unbind the thread; history stays in BB |
| `/model`, `/profile`, `/section`, `/server` | Agent, model, CLI profile, folder and machine for a new chat |
| `/tasks` | Open tasks of the topic's project |
| `/use <thread-id>`, `/say <text>` | Connect a thread by ID; send text that starts with `/` |

## Requirements and costs

- BB 0.43 or later. The bot polls Telegram from the BB server, so the server needs outbound access to `api.telegram.org`. No webhook and no public port.
- Your own Telegram bot. Messages of connected chats, agent reports and task titles are sent to Telegram.
- Optional plugins: **Tasks** for task events, **Projects & Sections** for sections and hiding, **CLI Agents** for native agent profiles, **Env Catalog** for storing the token.
- Summaries and voice use the BB providers and transcription service you configured, with their usage costs.
- Telegram cannot hide a topic in a private bot chat, so hiding a project deletes its topic with its history; showing it again creates a new topic. *Delete topics of deleted projects* works the same way and can be turned off.

## Privacy

The bot token is stored as a secret plugin setting or read from Env Catalog; it is never returned to the plugin page. In a private chat only the paired Telegram account can use the assistant. In a group, the owner configures the topic, who can call the assistant, and whether ordinary messages provide context. Agent output for summaries is sent only to the BB model you choose.

## Advanced

- **Time zone** (General tab): times in cards use the BB server's zone unless you set one, for example `Europe/London`.
- **Companion service** (General → Advanced): a folder where the plugin writes its topic list and reads incoming messages of a companion process, plus an optional SMS topic. Not needed for normal use. The [companion example](companion/aivech/README.md) forwards SMS from a local inbox.
- CLI: `bb telegram-projects status|sync|test <project-id>|bind <project-id|navigation|sms> <topic-id>|chat-status|chat-forget <topic-id>`.

## Development

```sh
npm install
npm run check   # TypeScript
npm test        # unit tests
npm run build   # bb plugin build
```

[Changelog](CHANGELOG.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md) · [License: MIT](LICENSE)

---

## Русский

Работайте с агентами BB из Telegram. У каждого проекта BB своя тема в личном чате с вашим ботом: туда приходят отчёты агентов (закончил, остановился, ждёт ответа) и события Tasks, а с любым тредом BB можно переписываться текстом или голосом.

### Что умеет

- **Отчёты агентов** с проектом, разделом, тредом, агентом и временем; ответ свёрнут, таблицы, заголовки и код Telegram рисует сам.
- **Саммери** вместо полного ответа: выбранная в родном селекторе BB модель пишет 3–6 пунктов.
- **«🔌 Подключить здесь»** подключает тред из отчёта к теме, дальше переписка идёт с этим агентом.
- **Чат с BB**: новый чат или подключение к существующему, голос распознаёт BB.
- **События Tasks** и **правила событий**: каждое событие отдельно, со звуком или без, для всех или выбранных проектов.
- **Связь с Projects & Sections**: скрытый проект или раздел убирает свою тему.
- **Русский или английский**: страница, меню бота, вступления тем, карточки и сообщения бота переключаются вместе.

### Как подключить

1. Создайте бота в [@BotFather](https://t.me/BotFather), включите **Threaded Mode** и выключите **Disallow users to create new threads**.
2. Установите плагин и откройте **Telegram** в боковом меню BB.
3. Вкладка **Подключение**: вставьте токен и нажмите «Проверить и сохранить токен» или положите его в Env Catalog под именем `TELEGRAM_BOT_TOKEN`.
4. Вкладка **Общие**: включите «Синхронизацию проектов».
5. Вкладка **Подключение** → «Владелец»: откройте ссылку или отправьте боту `/start <код>`. Дальше бот отвечает только этому аккаунту.
6. Вкладка **Обзор**: нажмите «Создать темы».

Требования, стоимость и ограничения — в английском разделе выше: свой бот, исходящий доступ сервера BB к Telegram, необязательные плагины Tasks, Projects & Sections, CLI Agents и Env Catalog. В личном чате с ботом Telegram умеет только удалять темы, поэтому скрытие проекта удаляет его тему вместе с историей.

### Recovery routing (personal.4)
Retry notices require the queued retry to belong to the same original Telegram
task; exhausted or unrelated retries do not promise automatic recovery. A late
child completion that produces no public activity no longer creates a generic
progress message. Actual subsequent work and final results still appear.

### Привязка тестовой группы

Для группы подготовьте отдельный рабочий BB-тред в проекте с подходящими для её участников инструкциями и доступами. Владелец личного бота должен быть создателем или администратором группы. Из BB вызовите `bb plugin rpc call telegram-projects bindGroupTopic --input-file group.json --json`. Пример содержимого файла:

```json
{"confirm":true,"chatId":-1001234567890,"topicId":3,"threadId":"thr_example","ownerOnly":true,"requireMention":true}
```

Для обычной группы укажите topicId 0. Параметр ownerOnly ограничивает отправителей владельцем, requireMention требует тег, адресованную команду или ответ на сообщение бота. Telegram определяет, какие сообщения придут боту, с учётом privacy mode и прав администратора. Для отключения вызовите unbindGroupTopic с confirm, chatId и topicId. Другой топик требует другого рабочего треда.

После назначения проекта группе он исчезает из личного меню выбора проекта. Уже выданные кнопки также проверяют назначение при нажатии. Для личных поручений используйте отдельную папку проекта. Отвязка топика сохраняет прежнее назначение проекта, поскольку в нём остаются история и рабочие файлы.

### Контекст рабочей темы

В bindGroupTopic параметр includeTopicContext включает буфер последних 24 текстов и подписей темы (до 600 символов каждый). Обычная реплика сохраняется без вызова модели. Для рабочего чата задайте requireMention=true: только обращение по тегу или ответ боту от разрешённого человека запускает отдельный тред темы. При requireMention=false каждое текстовое сообщение разрешённого человека запускает ход. ownerOnly=true разрешает владельца и пользователей из необязательного allowedSenderIds (числовые Telegram ID). ownerOnly=false разрешает всем участникам. Ранее подключённые темы продолжают без буфера. Для контекста Telegram должен доставлять сообщения людей: проверьте права бота в группе или Privacy Mode. Учтите, что Telegram назначает видимость на уровне группы; плагин сохраняет реплики только явно привязанной темы. Сообщите участникам, какие темы подключены. При смене политики или отключении темы буфер очищается. Уже отправленные в групповой BB-тред вопросы и цитаты остаются в его истории.

Для текстовой или голосовой правки выберите «Ответить» на сообщение бота в теме. В режиме обращения тег повторять не нужно. Мост проверяет право участника и передаёт расшифровку в тред темы вместе с идентификатором исходного сообщения. Голосовые без обращения в этом режиме не обрабатываются.

PDF для групповой темы сохраняйте под новым именем в outputs рабочего окружения и дайте в итоговом ответе Markdown-ссылку с абсолютным путём. Мост отправит документ в тему и сохранит квитанцию с идентификатором сообщения и суммой SHA-256 отправленных байтов. При ответе на PDF тред получит путь и сумму для проверки версии.

Опция политики темы searchableHistory=true вместе с includeTopicContext=true добавляет локальный полнотекстовый поиск SQLite FTS5. По умолчанию поиск выключен. После включения поступившие тексты и подписи сохраняются в индексе только этой темы, до 4096 символов на сообщение. Разрешённый текстовый вопрос автоматически ищет по словам несколько более ранних совпадений вне недавнего буфера. В тред попадают до пяти цитат и ссылки на исходные сообщения супергруппы. У разрешённого голосового вопроса поисковый запрос берётся из расшифровки. Записи старше 30 дней исключаются из выдачи и удаляются из рабочего индекса при запуске и затем раз в час. Отдельные приватные снимки и ранее отправленные цитаты в BB имеют собственный срок жизни. Смена политики и отвязка темы очищают её рабочую историю.

### Примеры для правок в теме

Ответьте на PDF бота голосовым или текстом «Сейчас скину примеры», затем пришлите фото или документы в ту же тему. Бот ждёт до 90 секунд. После последнего вложения достаточно четырёх секунд тишины. Фраза «всё, делай» завершает сбор сразу. Если вы одновременно дали два поручения, отправляйте материалы ответом на сообщение с соответствующим поручением.

При включённом контексте темы можно сначала отправить альбом, затем в течение двух минут ответить голосовым на PDF бота со словами «используй эти примеры». Для одного автора мост учитывает до десяти последних фото и документов. Если подходят несколько отдельных наборов, он попросит указать нужный. Для явно выбранного файла можно ответить на него текстом с тегом бота. Байты поступают через настроенный локальный Bot API на машину привязанного группового треда. Если скачивание не удалось, бот сообщает об ошибке до передачи поручения модели.

В привязанной групповой теме при обработке разрешённого обращения отображается стандартный индикатор Telegram «печатает». Для фонового сбора контекста и ожидания обещанных файлов он не включается.
Перед передачей поручения в BB бот также отвечает «⏳ Готовлю ответ…» в той же теме без звукового уведомления. После результата мост удаляет этот статус.


### Group history, channel administration and attachment storage

The bridge records the project when the owner binds a group thread. If the thread moves to another project, the bridge cancels pending delivery, including a prepared reply. Bind the intended thread again before resending the request. When upgrading an older installation with multiple registered group projects, renew those topic bindings once so the bridge can verify each project.

Bind a normal group with `topicId=0`. Enable `includeTopicContext`, `searchableHistory` and `retainFullHistory` for a searchable archive from the point of observation. Telegram Bot API does not backfill earlier history. The agent in the bound thread can run `bb telegram-projects search-history <words>`. Unbinding removes the scope's local index. Changing its audience or owner resets the index to avoid disclosing previous conversations.

Configure the bot/owner/channel triple under managedChannels and run the inspectChannelRights RPC. The owner needs to be a Telegram channel administrator. For a manually published text post the bot needs can_edit_messages. Give the assistant an unambiguous target. An earlier message, message link or forward may identify it. Manual edits never grant deletion rights to that post.

The local inbox is temporary storage. Save durable files into the project. Hourly maintenance removes completed managed downloads after 30 days, or oldest first above 8 GiB, with a minimum age of one day. Unknown legacy entries and busy thread trees are retained; the storage target is therefore a soft cap.
