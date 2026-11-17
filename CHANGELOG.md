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
