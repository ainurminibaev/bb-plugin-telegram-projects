# 0.9.84

- С117 / С114: bot rights in a group are checked via `getChatMember` at group connection (`notifyGroupsAdded`), at setup completion, and on demand via `bb telegram-projects check-rights [--chat C] [--json]`. Missing rights (administrator, delete messages, pin messages, and manage topics in forums) are reported in one clear line with the exact Telegram UI path (С77).

# 0.9.83

- Unaddressed group messages via quick decision service (agents-in-chats.md): when `unaddressedFastDecide` is enabled (default `false`), an unaddressed human message in a shared group/topic does not start the main model directly — the bridge asks the server's quick decision service (`vallis-decide`) with chat, topic, message, author, mentions, short topic window, leader info, and the agent's role/zones. A leader joins on `relevant` or `my_zone_only`; a non-leader joins only on `my_zone_only` after waiting a few seconds and verifying no agent has replied yet. Direct mentions skip the quick decision service; service failure or timeout falls back safely to the existing mode table.

# 0.9.82

- С119: people's reactions to the bot's own messages (`message_reaction`) are recorded next to the message in the archive without starting a turn or model call; `bb telegram-projects reactions [--chat] [--topic] [--since 24h|7d|date]` reads reactions from people allowed to write in the place.
- С118: action buttons under a message (`bb telegram-projects send ... --button "Label[=data]"`, up to 6). Pressing a button by a person allowed to write in the place leaves a `✓ Label — Name` mark while keeping the buttons, and feeds an ordinary turn in that conversation; unauthorized clickers only see a short hint.

# 0.9.81

- Promised replies reach the person across turns (inventory № 40): every incoming Telegram message gets an answer label valid for 24 hours in any turn of the same conversation (both owner DM and groups/topics). Turns started outside Telegram (by another thread or a schedule) receive a short agent-only note with the last recent human requests and their labels; unlabelled finals of such turns still never go to Telegram, and place rights / forward protections are unchanged.

Not checked live: label expiration after 24 hours and a non-Telegram turn started by a schedule — covered by unit tests (662/662).

# 0.9.80

- С112: an approved person who is a member of the target group (checked live via `getChatMember` at send time) can ask the agent to write into that group; non-members get a plain refusal. Forwarded messages never grant cross-group send or delete rights to anyone, and a bare forward joining an active turn drops its cross-group rights.
- Owner forum verification (`verifyOwnerForum`): transient Telegram API failures (network, 5xx, 429, timeouts) no longer revoke and drop the owner's message — the job stays queued and retries with exponential backoff; only a definitive audience/membership refusal revokes it.

Not checked live: a non-owner approved person asking to write into another group (member and non-member — on the second stand BB the owner is the second account); an artificial Telegram API failure during `verifyOwnerForum` (cannot be forced against live Telegram API) — both covered by unit tests (657/657).

# 0.9.79

- A turn a person started gets its final: the group's final goes to the verified person who started the turn (a route comparison dropped it); two messages of one person give one final; a message of another thread joining the turn no longer cancels the delivery; when a plugin's request claims the turn's final, the finished result is asked for once and one line goes to the person (inventory № 42).
- Long texts: a message read from the archive by number comes whole; previews say they are cut; a long send is split into any number of parts in order, with all message numbers in the answer; a partial send says what went; Telegram's receipt is compared by length — under 90 % of the characters is flagged and exits 1 (inventory № 41).
- С115 «waiting for the owner» state of an owner's forum topic: an agent's question sets it, the owner's answer clears it, `waiting` lists it, an external command is called on changes. Off by default (setting).

Not checked live: two consecutive messages of one person in an owner's forum topic joining one turn without a busy-answer label (in live tests the second received a busy-answer label; covered by unit tests, and two consecutive messages in private chat gave one answer); the plugin-veto branch (`requestFinal` when a plugin claims the turn final); Telegram receipt loss over 10 % (cannot be forced against live Telegram API) — all covered by unit tests (650/650).

# 0.9.78

- Fix: in a forum topic a colleague agent bot created, messages addressed to this bot were dropped at the door — the first one (every topic message formally answers the «topic created» root, and that root was the bot's) and the bot's own follow-up replying to its earlier message. The topic root and a reply to one's own message no longer count as «a reply to another bot»; a reply to another bot's message stays not ours, even with this bot mentioned. People writing with a mention in such a topic were dropped the same way and are taken now.

Not checked live: a topic made by another bot needs the second stand bot, which is down; covered by a test on the real update form.

# 0.9.77

- Incoming ledger: what the agent wrote before working on and then wrote again is interim — it never closes a message as its answer (the answer is the turn's final or an explicit send); the first of two messages in one turn gets the turn's final, not a note between calls.
- С113: a bot added to a group by the owner or a person with access starts its conversation there at once and the agent introduces itself in one message (who, what it helps with, how to reach it there, its curator); with privacy mode on and no admin rights it is told that a plain mention never reaches it, and the bridge's greeting says «reply to my message or /ask@bot». On the owner's request a coordination chat writes to any group the bot is in (the first message to a new group); a refusal says why in words. When Telegram does not let the bot write in a group, one line goes to the curator (or the owner) once a day and the answer is not retried forever. The status shows the privacy mode and the groups where the bot sees only what is addressed to it.
- «Отвечаю сам» (no mention needed): a message nobody addressed to the agent gets no 👀 and no live line, also in groups limited to people with access; its answer, if any, is the only sign. The owner's messages keep the sign.
- Owner's chat (case 35): open questions of other conversations are never glued to the owner's text; a question card and its button answer become lines of the owner's chat for the next turn; a reply to the card still answers that question.
- Group settings history: who changed what and when (menu, platform call, the bridge itself) — in the status (last 3 per group); the agent gets one line when people changed its answer mode.
- Sending: the first-of-day hold is a failure in words (exit 1, «НЕ отправлено»), and a send not from a conversation is never held; a text without Telegram's answer is «not confirmed, may have arrived — do not repeat»; an emptied text sends nothing and says so. Every agent text to people goes through one formatting point (a source test keeps the list of direct sends).

Checked live on the stand (3902b34): the introduction when added, the first message to a new group on the owner's request, two open questions from two conversations (case 35), the first-of-day hold from a conversation and a script send, a question while a long task runs (3 of 3, with the long task's result), two messages in a row (3 of 3), group replies, files both ways, a subthread's result.

Not checked live (covered by tests): «отвечаю сам» without 👀 — a third person is needed on the stand; the line to the curator when writing or only files are forbidden — no group with such a ban on the stand; a guest's message joining the owner's turn — a guest needs the first stand BB, which is down; a subthread's question as buttons — the stand's guest guard blocks the subthread (as in 0.9.76).

# 0.9.76

- Topic window (off by default, `topicWindowSinceLast`): a group turn carries only the topic lines its thread has not seen, newest first within a character budget; the agent searches older ones itself.
- A message handed to BB is never lost: an uncertain hand-over is checked after two minutes and given once more; the person is told only if it really failed.
- Memory keeps a message's links and formatting; an edit (`edit`) gives the link and before → after, the answer goes as a reply to the edited message (С106); a file's caption is edited too (editMessageCaption).
- Formatting: a file's or picture's caption is formatted like any message (no raw `**`); a caption too long goes as a formatted text, then the file; refused formatting goes as plain words without marks.
- Sending files: Telegram's own spelling of a name is a confirmed receipt; an unknown outcome (no answer) is said as «possibly delivered — do not repeat»; the same files to the same place within 15 minutes are not sent again without `--again`; an upload waits 120 s.
- Groups: a group that became a supergroup is one group by name; same titles are told apart by number; `--chat=N` works. «Tasks не установлен» is a status, not an error.
- С108: a topic cannot be pinned by a bot — said honestly; `message pin|unpin`.
- An open question never blocks the owner's message: a form question takes the words; a permission request is decided only by its button or the owner's own words equal to a button's label; otherwise the words go to the agent with a note. No service line to the person.
- Guest group memory: only a person nobody approved makes a group guest; the owner gets a notice with «Одобрить <имя>» / «Оставить так»; shared memory comes back only when nobody unknown is left; the owner's own choice of separate memory is kept.
- Answers: a turn not started by a person that already sent here by command posts no report; after a labelled answer the same turn's unlabelled final goes to that person unless another request joined the turn; a follow-up question to the owner names the person who asked and forwards the original once; a voice's reaction is chosen from its transcript; thread links are dropped from texts to people; command errors are not retold (rule line).

Not checked live (covered by tests): a subthread's question as buttons (the stand's guest guard blocks the subthread there); a double final after a subthread in the owner's topics group (no such group on the stand); a task with a reminder to a third person (the stand has no third person).

# 0.9.75

- Forwards in groups reach the agent. In the owner's topics group every forwarded message (text, voice, file) was dropped at the door with channel posts and «via bot» messages; now a message a person forwarded is an ordinary incoming one, labelled with who wrote the original (С73). Where the agent leads a topic without mentions, a participant's forward is taken too; channel posts, automatic forwards from a channel and «via bot» messages are still dropped.
- Several forwards and a comment are one turn in a group where the agent answers without a mention: a forward waits 10 s for what follows (as in the owner's chat); every message of the same person that comes within the window joins the same turn, voices transcribed.

# 0.9.74

- Fix: a deferred task in a group (a participant's «in N minutes send the result here», `telegram_group_followup`) runs again. In 0.9.73 the check «the bot already replied to this message» saw the confirmation «scheduled» on the same original message and closed the task silently, without a turn. The same check closed the owner's answer to a group's question (it comes under the original message, which the bot had answered «asked the owner»). The check now applies only to real Telegram messages, not to what the bridge gives itself (deferred tasks, subthread results, the owner's answers).

# 0.9.73

- С103: the turn note of a group, a topic, a person's chat and the owner's chat says whether the agent has written there today and the local time («Сегодня ты в этом чате ещё не писал; сейчас 09:12 (Europe/Moscow)»). `send` answers with `firstToday` and `localTime`; the first message of the day into another place waits once (`sent:false` with a hint) so the agent can greet in that chat's style — one wait per place and day, whatever the text, before any question is recorded and before a group's report to the owner is counted; the owner's chat waits too — the first message of the day to him greets him. The day is the organization's: the `timeZone` setting, empty — Europe/Moscow. No word lists: whether to greet is the agent's choice.
- С105 (narrow): a message the bot has already replied to is not given to the agent again (after a pause, a lost submission or a busy turn) and is never called lost. Any other later message of the bot does not count — several messages may wait. The full answer is the incoming ledger (0.9.75).
- С105: `edit` and `delete` of the bot's own message take `--chat` from the owner's conversation and its subthreads; a group's or a person's conversation acts only in its own chat; an unknown chat is refused; someone else's message — as before.
- С76: a conversation folder the bridge makes is trusted by Codex (`trust_level = "trusted"` in the account's config) and Claude (servers of its `.mcp.json`), so a group in its own folder gets the organization's connections. Own folders stay off by default.

# 0.9.72

- A group's or a person's conversation is made in the owner's project even when the owner's chat has no conversation yet (before, an employee whose owner had just started a new chat silently ignored mentions in groups).
- A mention by an agent of the organization (`agentBots`) starts a topic's conversation; other bots never do. The agents' reply guard keeps working.
- `bindOwnerChat {projectId}` (RPC) and `bb telegram-projects bind-owner-chat --project <id>` (only from the owner's conversation or a local call by the installer): the owner's chat to a project, as /project does. `employeeProject`: an employee's install binds the owner's chat there after pairing and when the owner writes first.
- С102: what the bridge itself writes to people is in the organization's words: an employee's pairing says «<name> подключён к организации «…»» (`organizationName`, `employeeName`), no BB, privacy mode or /project hints; where something must be set up, the person hears «I can't answer right now, I've told those who set me up» and the log gets the setup line. Inventory: docs/texts-to-people.md.
- A topic the agent creates with `topic create` gets its conversation at once, as one the owner made (С54): the bot gets no update about its own topic, so such topics stayed silent. Topics made that way earlier come alive with their next message: the creation date is taken from the topic's head. A topic named or renamed by a command no longer blocks later renames by people.
- A participant's /model in a group gets a short refusal (С71).
- «Остановлено.» comes after the stop button too (the cancelled request used to hide the end of the run).
- С101: the turn rule says that after `send` into the same chat the turn ends with exactly NO_REPLY.
- С84: the owner's conversation attaches a file from a link in its answer when it is readable and not in a secret place; otherwise the link stays text, the person sees no service line, and the agent gets the reason.

# 0.9.71

- Group and private conversations in their own folders (С76): a new group or person can get its own project and folder, an existing group can be moved and moved back (schedules follow both ways), with a guard at the account level. Off by default: with `conversationFoldersRoot` empty nothing changes.
- Agents in chats: a topic is led by one agent or answered by mention; the owner's message without a mention goes only to the leader when another agent of the organization is in the chat; a colleague called once; the agent's curator is an addressee of a question (`send --person curator --ask`). Off by default: with `agentBots` empty nothing changes.
- Files a group's or a person's conversation sends — with `send --file` or a link in its answer — are limited to files received in this very chat, results of its own tasks (outputs/<task number>/) and files made during this turn; the refusal names the folder to copy to, and an old file is copied there first. This prevents sending another conversation's file by mistake; it is not a leak barrier while group conversations share a folder with the owner's private chat — that boundary is the conversation's own folder with the account-level guard (С76). The owner's conversation is not limited.

# 0.9.70

- The final answer is hidden only by an exact repeat (words, without spacing, formatting or the answer marker) of a text the agent sent into the same chat and topic during this very turn; «Готово.» after «будет готово через минуту» is posted. A lost answer is worse than a double one.
- С81: when the answered message is not in the conversation's memory, `search-history --message` gives Telegram's short quote (up to 200 characters, kept 30 days) marked as such, or says plainly that the text is unavailable and the agent should ask.
- #5: a free answer in words to a form question reaches the agent (an option named in words is chosen; only free-text questions get the words).
- A stopped run is said in two plain words under the request instead of a service line.
- On the employee's pause (platform 0.4.7 pauseStatus) a waiting message shows only the «seen» sign; an older platform behaves as before.

# 0.9.68

- A thread deleted in BB while its topic stays bound no longer stops the scheduled-results pass (scheduled results of the other threads were not delivered; status showed «sync_failed»).
- A short final answer («Готово.») is never taken for a repeat of an interim message; only texts sent during this task count.
- Agent chains (С74): the limit is 12 replies by default; at the limit the agent asks the person who started the matter whether to go on instead of answering the colleague.
- С90: from an approved person's private chat, `send --chat GROUP --for PERSON` relays words into a group where both are, with the addressee mentioned and «по просьбе …».

# 0.9.67

- Fix of 0.9.66: an interim message the agent sent into its chat («взял, займёт 10 минут») no longer hides the turn's final answer; the answer is skipped only when it repeats a text already sent there, and a failed turn says so.
- С71: the bridge itself hands a new executor the former conversation's latest answers (a guest thread may not read a neighbouring thread).
- С84: when a later album of a multi-file send fails, the agent is told what already went and to send only the rest.
- С82: a topic's conversation edits only its own messages in its own topic.
- An unexpected failure of the polling or group pass is written to the plugin log (status showed only «sync_failed»).

# 0.9.66

- One incoming message, one submission: a service message of another plugin (the limit guard), a schedule's run or a person typing in BB that joins a running Telegram task no longer makes the turn ambiguous. Before, the task never saw its end: «typing» stayed, the answer was late and after 15 minutes the message was submitted again.
- The turn's final answer is not posted again when the agent already wrote into this chat during the turn; the place note tells it to answer this chat in the final reply.
- No service lines: a turn without a text answer stays silent (the reaction remains); a failed one, a lost receipt, /stop, /chats and an unconfirmed answer are said in a person's words.
- С81: a reply reaches the agent as the message number, chat and topic, without the quoted text; `search-history --message [CHAT:]N` returns that message in one call. П5: replies to different messages in a row are one task, each with its own number.
- С82: `edit --message N --text T` corrects the bot's own message in the conversation's chat.
- С84: several files in one send (`--file A --file B …`) go as albums of up to ten; an album in a forum topic is confirmed correctly.
- С83: an ordinary thread doing work a group's conversation handed it writes to the owner in that topic; «Да / Нет» work there.
- С71: /model says what happens to the history; a new executor reads the former conversation and continues its open tasks.
- С80: the owner's word to delete someone else's message lives only in a turn his Telegram message started.
- A file link with a line number (path:44, #L44) sends the file itself.

# 0.9.65

- A group's conversation can delete a message in its own chat (С80): `bb telegram-projects delete --message N` — the bot's own message always (within Telegram's term), anyone else's only on the owner's word; never in another conversation's chat. No right or past the term — the reason and how to ask the owner. Each deletion is logged.
- When Telegram refuses a topic action for want of an admin right (С77), the agent is told which right, in which group, where to switch it on, and how to ask the owner with buttons.
- No service lines about queues and hand-overs in a person's chat (С79): a queued message gets only the «seen» reaction; a subthread result BB gave up handing over is handed over again, and the person hears only when it surely will not come, in plain words.
- A group's conversation may send the owner a short report without a question: text only, marked with the group and topic, at most once in three minutes.
- A thread whose group conversation was moved to another thread is told so in words on send, `--targets` and `search-history`, with the thread to pass the work to; rebinding tells both threads about each other.

# 0.9.64

- A message the owner sends right after another, while the first one's turn is still starting, joins that task too instead of becoming a second request with its own answer (П5). Tests; not yet checked live.
- When a message from another thread joins a running Telegram task, the bridge itself tells the sender thread once that it was passed on and the answer will come separately (С48), also for group and topic threads.
- A long voice or file download in one chat no longer holds up answers in other chats and topics (С50): slow work goes to the background after a short grace. Tests.
- A task's answer no longer comes twice in a topic when a subthread's completion notice joins the running turn.
- Agent bots in groups (С74), off by default: with an empty `agentBots` setting every bot's message is dropped as before. When listed, an agent bot's message addressed to ours is taken like a participant's, without reactions, and a bot-to-bot chain in a topic stops after `agentChainLimit` replies (3 by default) until a person writes. Tests; not checked live.

# 0.9.63

- A message from another thread (the employee, the assistant, a coordinator, a worker) to an agent busy with a Telegram task no longer waits for the end of the turn (С48): it joins the running turn as a service message (the sender's `bb thread tell` reports it delivered at once), and the task's answer still goes to the chat it came from, without that exchange. The place note asks the agent to answer the sender at once with `bb thread tell` and keep it out of the reply to the person.

# 0.9.62

- Far fewer requests to BB (С72). The bridge reads a thread when BB reports it changed (thread:changed), and threads still at work every 2 s for the live status; when everything is quiet a full safety pass runs every 12 s (quiet children once a minute). Without the realtime feed, after a break or with no subscription it reads everything every 2 s as before; after a reconnect a full pass runs at once. Scheduled results read changed threads (all of them once a minute); the consent watch reads only threads with a group turn or an open consent. On the stand: 3716 → 160 requests a minute.
- `send`: General of a forum is a target like any topic; a group's name follows its current Telegram title.

# 0.9.61

- Forwarded messages say whose words they carry (С73): the author of the original and when — a person, a bot, a chat or channel, a hidden author — and the agent's own earlier message is named as its own. The agent never takes a forwarded message for the words or the decision of whoever forwarded it.
- A message the owner sends right after another while that turn still runs (a text, then a screenshot) is one task with it, not a second request with its own answer (П5).
- An ordinary thread of this BB can write to the owner (П28): `send --person owner` says which thread and project it comes from, is cut at 3500 characters, and with `--ask` has «Да / Нет» buttons; the answer comes back to that thread. Groups and people stay out of reach for such threads.
- `sendToOwner` {text, source?} → {ok, reason?}: a plugin of this BB tells the owner something without a model turn.

# 0.9.60

- General of a forum (topic 0) can be bound and is picked up by default, also in the owner's own forum; a reply inside General stays in General, topic messages never reach it.
- Thread titles follow their Telegram place: «<тема> — группа «<короткое имя>»», General the same, «группа «…»», «личка «<имя>»». The short name is a group setting (`shortName`), by default the group's title. A renamed topic or group renames the thread; a title set by hand is kept; the assistant pair's threads are not touched.
- `/model` in a group or topic for the owner: the current provider and model with the choices; a model of this conversation from the next message; another provider — a new thread of it takes the topic. Other topics keep theirs.
- The live status line is the agent's own words about the request; after a few quiet seconds «Думаю над ответом…»; a step only from a short list of plain actions, never service mechanics.
- A new topic gets a fitting standard icon from the quick decision service (`topicIcons`).
- `send --reply-to` (a PDF as a reply to its scheme picture).
- Status: the last chat error with where and when (`chatLastError`), cleared by the next success in the same conversation; a delivery watch of an archived thread is read once more and finished, a deleted thread's at once.
- A mention of a person by id becomes a Telegram mention, not raw brackets.

# 0.9.59

- The rules in force come with every Telegram turn — groups, people's chats and the owner's chat. A running agent session keeps the instructions it started with, so later edits of the rules never reached long conversations. The bridge asks the platform plugin (`turnRules`, personal-assistant 0.4.4) for the rules in force and their fingerprint: a conversation that has not had this version gets the full text, visible to the agent only, marked «rules updated, in force from this turn, earlier wording cancelled»; the same version costs one line. Without the platform's rules nothing changes.
- The live status line never shows the bridge's service marker.

# 0.9.58

- A question to the owner from a group or a person's chat comes with «Да» and «Нет» buttons and without service numbers. It says where it comes from, who asks and their status (the owner, an approved person or a group member), and links the original group message; a person's own message is forwarded before it (quoted, if Telegram does not allow forwarding).
- The answer — a button, or a reply in the owner's chat — comes back to the asking conversation as a turn, so the agent there carries on and reports where the request was made. The same for a person's answer to a question asked from a group («спишись с X»).
- Several open questions are never guessed: a reply to a question names it; otherwise the agent asks the owner to press the button under the right one.
- The place note: «спишись / договорись / реши с X» is a conversation in X's private chat when it is open, the result goes back where it was asked.
- Groups: the reaction is chosen by the person's own words, not the whole turn text.

# 0.9.57

- Reactions and a live status (С45, С46): every message that reaches the agent gets a sign at once, then a chosen reaction; a long turn shows one status message with its current step. The same in private chats, groups and topics.
- Forum topics are picked up by default in every group (С54); a topic whose thread was archived gets a new thread (П29).
- Voice: the agent gets the length of a voice message with its transcript (С56).
- The assistant's name is a setting; conversation titles read «name · state · model».
- Place of the answer (С43, С44): a request in a group is answered in that group, with a mention of the person meant; a person's private chat is written from a group only on the owner's own request. The owner sees in a group who may write privately and whose requests wait; others are told these details are not shown here.
- The owner reaches the agent in a group without a mention (С55), on by default and switched off in the group settings; the agent stays silent when the owner talks to someone else.
- Groups keep the formatting of the private chat: bold, italic, lists, code and links in answers, `send`, scheduled messages and reminders; plain words if Telegram rejects the formatting.
- Anyone who may call the bot in a group may ask it for a later check there, not only the owner.
- Any conversation may ask the owner a question with `send --person owner --ask`; the answer returns to the asking conversation.
- In a group the agent tells apart the owner, an approved person (private access given by the owner) and a group member, who may ask within the group's work. From a group the agent writes privately to an approved person on the owner's request («спишись с X»), even before that person wrote in the group, or to a person who asks it themselves.
- A group message the thread never took up is given once more and then closed with an honest line; "typing" stops after 10 minutes without a turn (it could last for hours).
- The one-time pass over people approved before 0.9.56 sends nothing to whoever already talks to the agent, and no apology.

# 0.9.56

- Employee private chats: when the owner approves a person, the bridge opens the conversation at once and the agent writes first — a short greeting, what it can do, and what the person needs. Nobody has to send another message after "Start".
- People approved before this version get one message once (an apology that they had no answer, then the same); a restart does not repeat it.
- `send --person` reaches an approved person before they write again; a person without access is still refused.
- Before approval the person reads "Запрос отправлен владельцу. Отвечу, как только он подтвердит." instead of "contact the administrator".

# 0.9.55

- Received files can go to a project's own inbox (`projectInboxRoots`: `proj_id=/path`): the file lands in the inbox of the project whose thread gets the message, and the turn names that path. An agent under its own Linux account reads it through the inbox group: folders 0750 (2750 when the inbox has the group bit), files 0640, set explicitly whatever the service umask. Projects without their own inbox keep the shared one.

# 0.9.54

- Local Telegram Bot API server (one per machine, shared by every bot on it): files up to 2 GB are received in groups and private chats and sent back (up to 2000 MB); through api.telegram.org the usual 50 MB stays. Any file type goes out from the owner's chat as a document, as in groups.
- Switching between api.telegram.org and a local server no longer loses the first updates (each server numbers updates on its own); a switch back to the cloud clears the logout mark, so the next switch logs out again.
- Voice transcripts through BB's transcription get the install language as a hint (Russian speech was taken for Polish).
- `send --person owner` reaches the owner's chat (statuses of the owner's tasks from task subthreads).
- The skill tells agents the upload limit depends on the Telegram server.
- A file from the conversation memory is taken from disk when the bridge uses a local Telegram server.
- The same question to the same person from the same place stays one open question: the answer comes back once.
- In groups and people's chats, the result of a turn woken by a finished subthread reaches the same chat, as schedule results do.

# 0.9.53

- A group message that arrives while the agent works joins the running turn and gets its own answer, as in the owner's chat; without that answer it is sent again in turn order.
- Schedules set in a group or a person's chat deliver each run's result back to the same topic or chat; a silent run (NO_REPLY) writes nothing.
- Forum topics by an ordinary request: `bb telegram-projects topic create|rename|close|reopen|delete` — the owner's conversation any group, a group its own topics without deleting, a person's chat none.
- People in Telegram talk to the agent, not to BB: a question is "❓ Question" with its text, a reply is confirmed with "Answer received." The setting "BB links and mentions in Telegram" (auto by install kind: assistant — on, employee — off) removes BB buttons and mentions; guests never get them.
- Conversation memory: texts are kept forever, files for a configurable number of days (183 by default); an expired file is marked "removed by term". The history kept before the archive moves into it on update, without duplicates.
- Sending: names and topics found by the agent (`send --targets`), a topic by its name in any group, a group by its number from before it became a supergroup; reading the text from standard input is refused with a hint.
- Chat pair: on a switch only working subthreads move to the active thread; removing a pair restores thread titles.
- Inbox and archive files are readable by the inbox folder's group (640/750).

# 0.9.52

- Conversation memory: the bridge keeps an archive of every message it sees (owner's chat, people's chats, groups and topics) and agents read it with `bb telegram-projects search-history` — words with typos and transliteration, author, period, last N, files. Who may read what follows the calling conversation; a person's private chat is never shown to anyone else.
- Group setup in three short steps with buttons: who may address the employee, when it answers, and the group's memory (shared or only this group). The first other person in a shared group makes it a guest conversation at once.
- Guest conversations (groups and people's chats) work within their own reach: their thread, its subthreads; schedules for guests stay off until results are delivered back to the topic.
- `bb telegram-projects send`: the agent writes to a topic of any group or to a person who started the bot, by name; `--targets` lists where it may write; with `--ask` the answer comes back where it was asked. No confirmation card.
- People's private chats: a person whose request waits for the owner is told so once; after an hour without a decision the owner gets a fresh card.
- Questions with options from workers reach the owner as buttons, also from a work thread of another project the owner's chat handed a task to; the result reported is the turn after the owner's answer.
- Any file sent in a group or a private chat reaches the agent as a file (not only PDF and images).
- Assistant pair switch: the chat moves to the reserve thread when the main one hits its limit.

# 0.9.51

- Ask Telegram about a possibly upgraded basic group on that group's own transport. 0.9.50 asked through the owner's chat transport, which refused the request before Telegram, so a group upgraded while an older bridge ran was not moved.

# 0.9.50

- Detect a basic group that became a supergroup while an older bridge was running: Telegram names the new chat ID for member requests, not for `getChat`. The binding, its thread, the group settings and the saved conversation move to the new ID.

# 0.9.49

- Employee groups: every member may talk to the employee and give it tasks, on mention or reply, including people added later. A group can still be limited to people with access. The former Codex lock is removed.
- A topic of a group the employee is in gets an ordinary thread in the employee project on its first mention. One group setting covers all topics, including new ones.
- Private chats of other people with an employee: the owner approves a request with one card; the person then talks to an ordinary employee thread with the same agent, instructions and tools. Revoking access unbinds the chat and keeps its history. The separate isolated private worker is removed.
- When an employee joins a group open to all members, it says once in the group how to reach it.
- A basic group that becomes a supergroup (for example when topics are turned on) keeps its binding, thread, settings and saved conversation under the new chat ID.
- Group file replies use the thread's own environment when no file host is configured.

# 0.9.48

- Recover a saved, addressed text reply from the original BB turn journal on native turn completion. Preserve direct delivery for replies observed earlier in the same turn.
- Use one atomic delivery record for both paths. Report unproven results as unconfirmed and do not resend an uncertain Telegram delivery.
- Keep file replies on their existing path and preserve silent replies and late-album warnings.

# 0.9.47

- Collect Telegram photo and document albums into one ordered BB request, preserve captions and the original reply address, and warn when a new album item arrives after dispatch.
- Send addressed photo or document albums without merging neighboring text into the album. Keep repeat updates and uncertain deliveries from producing duplicates.
- Suppress empty and standalone `NO_REPLY` finishes in the paired chat while preserving substantive text and addressed file replies.

# 0.9.46

- Choose the highest-resolution incoming photo within the existing route limit, regardless of variant order.

# 0.9.45

- Reply with a single photo or document directly to the originating message in the paired owner's chat, in both a new and a running BB turn. Keep the requested caption on the file and omit the extra delivery notice.
- Reuse the existing response receipt when a busy-turn reply is repeated.

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
