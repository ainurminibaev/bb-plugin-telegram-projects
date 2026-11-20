# Run a group in its own BB instance

The personal bridge receives Telegram updates and sends the replies. The group BB runs the agent, holds the group's files and returns text or a PDF. The worker needs its own BB project, thread and provider access. Keep the owner's bot token, Telegram login, personal projects, BB API credentials and Docker socket on the personal side. Give each independent audience its own execution boundary.

## Worker setup

Install the same compatible bridge build in the isolated BB. Leave Telegram synchronization and chat polling disabled there. Its token settings and Env Catalog must have no Telegram bot token. Create the worker project and thread. In that instance configure the bridge settings:

- `isolatedGroupProject` is the worker project ID.
- `isolatedFileHost` is the BB machine ID that owns the thread's working directory. Run the bridge server on that machine when exporting PDFs.
- `telegramInboxRoot` is the worker's private, writable input cache. Use the same absolute path for `BB_TELEGRAM_ISOLATED_INBOX` in the upload command.

The real provider and any children it starts run inside this boundary. Limit network access to the provider endpoints the worker needs. Keep access to the personal BB and its management endpoints outside that boundary.

## Personal bridge setup

Set `BB_TELEGRAM_GROUP_EXECUTORS` in the personal bridge process environment. Key each entry by Telegram chat ID and topic ID. Use topic ID zero for a group without forum topics. For example:

```json
{"-1001234567890:3":{"projectId":"proj_example","threadId":"thr_example","cli":"/opt/personal-agent/group-launcher"}}
```

For Docker, copy [the supplied launcher](../companion/isolated-docker-cli) to the path you configured and set its container name, BB binary and receiver path at the top. Inside the container install the receiver from this release and set the two upload environment variables below. Keep the launcher and its directory writable only by the administrator. The Docker socket stays on the personal bridge side.

The administrator owns the launcher. Its target must be fixed by the administrator. The bridge uses two operations:

1. For a BB RPC, the launcher receives `plugin rpc call telegram-projects METHOD --input-file LOCAL_JSON --json`. Forward the private JSON over stdin, use a private temporary file inside the worker, run the worker's BB CLI, return its JSON and remove the temporary file. The supported methods are `submitIsolatedGroup`, `readIsolatedGroup` and `readIsolatedPdf`.
2. For an incoming attachment, it receives `isolated-upload THREAD_ID CACHE_ID SHA256 BYTES NAME`. Forward stdin as a binary stream to `node companion/isolated-inbox.mjs` inside the worker. Pass the five arguments unchanged as separate arguments. Set `BB_TELEGRAM_ISOLATED_THREAD` to the administrator-selected thread ID inside the worker. The receiver writes a private cache entry, checks size and SHA-256 and prints its JSON receipt. Telegram credentials and local source paths are absent from this transfer.

Restart the personal bridge with the new environment and bind the group topic to the configured thread ID using the ordinary group binding procedure. Repeat the binding when moving an existing group from local execution. A saved isolated binding whose launcher disappears will not dispatch work to a local agent.

The personal side currently downloads incoming files through its configured local Bot API. A group sees only the files chosen for its request. A PDF reply must link to a regular PDF under the worker environment's `outputs/` directory. The bridge fetches it in bounded chunks and checks its revision across reads. Cache maintenance in each instance uses the ordinary cache age, space and active-work checks.

## Acceptance

Before allowing participants, use a test group and a synthetic document. Ask the group to read an item from the document and return an edited PDF. Verify the source message, topic, worker thread, received file and an independent private request. Test that group work and its children cannot read personal files or reach the personal BB. In a live test, the stock Telegram poller accepted a file in a forum topic. A separate BB running in Docker on macOS returned a PDF containing the value from the file. Replying directly to that PDF without mentioning the bot delivered a revised PDF in the same topic. Both versions were downloaded and checked independently. The same scenario also passed with an online Codex worker and the stock Telegram poller. The test owner used a temporary login on the worker. Configure provider access for your own worker before enabling participant access.

### Owner decisions for a project adapter (0.9.12)

The supported decision surface is an original reply in the paired Telegram owner's private chat. A BB coordinator can prepare the proposal during a validated owner Telegram turn. A model-generated summary or a group message cannot approve it. Direct decisions entered in the BB UI are outside this contract.

1. In the trusted receiver environment configure BB_TELEGRAM_DECISION_OUTBOXES as a JSON map from the originating BB project ID to a unique absolute local directory. Give each project its own directory. The receiver is its only writer. The project adapter can list and read its own directory. On Linux a receiver-owned directory with the adapter's group, mode 2750, and receiver umask 0027 gives the adapter read access to 0640 receipts. Keep the receiver database, credentials and outbox outside every model shell. A shell running as the receiver UID can forge receipts. Separate these identities before using this transport for real external writes.
2. The adapter stores the immutable operations of the draft under taskId and a monotonically increasing integer revision. Each numbered item is a one-line, exact human-readable description of its effect, including target and material fields. Persist the complete mapping before presentation. Compute draftHash as lowercase SHA-256 of UTF-8 JSON.stringify(items), an ordered array of strings. The adapter must never change hidden fields under an existing revision, even when the displayed text is identical.
3. From a current owner coordinator turn call presentOwnerProposal through the same trusted RPC path as inspectGroupTask. Supply threadId, routeToken, taskId, revision and items. The bridge derives the executor from the task origin. It sends the numbered draft to the paired owner and returns messageId and draftHash. Re-presenting the same version returns the same message ID. If a presentation races or Telegram loses the send acknowledgement, only the currently registered message can approve the draft.
4. The owner replies directly to the proposal in ordinary language, for example «сделай первый и третий» or «сделай всё». Telegram opens a reply field for the proposal. A bare «да» on a multi-item list prompts for the selection; the reply to that question is bound to the same proposal revision. A free-form change or conditional answer continues the conversation without publishing a decision. The legacy `/approve 1,3` syntax also works. The bridge validates the private sender, replied-to message, current task binding, project and draft. For the accepted reply it publishes one immutable TASK_UUID.json containing exactly actor (paired Telegram user ID), taskId, revision, draftHash and selected (sorted positive item numbers). Repeating the decision retains those bytes. A changed selection after acceptance requires a new task.
5. The adapter scans only final *.json receipts in its assigned directory. It matches the task, revision and hash against its current stored draft and rechecks its resource rights **before any external call**. It persists results per (taskId, revision, draftHash, item), with a uniqueness constraint and reconciliation for uncertain writes. Keep the input receipt in place across restarts. Adapter results and Telegram delivery receipts are separate. A receipt attests the explicit owner selection; it does not grant extra service permissions.

Synthetic acceptance from the bridge checkout:

```sh
node_modules/.bin/tsx --test test/owner-selection.test.ts
```

During a current paired owner turn, resolveOwnerGroupMessage accepts threadId, routeToken and the original message link in the form https://t.me/c/CHAT/TOPIC/MESSAGE. It returns taskId and projectId after checking the active binding. Use the returned task for inspectGroupTask or presentOwnerProposal. The lookup performs no delivery.

For automatic delivery configure BB_TELEGRAM_DECISION_RESULTS as a JSON map from projectId to {"directory":"/results","host":"example.org"}. Mount this dedicated adapter output directory read-only in the receiver. After verifying external writes, the adapter atomically publishes TASKID.json with the original five decision fields and links, one distinct HTTPS URL per selected operation in the same order. The bridge matches the receipt to the approved version and uses the ordinary durable group delivery queue.

To present a proposal without a private lookup, set BB_TELEGRAM_AUTO_PROPOSALS on the receiver to a JSON map from "CHAT:TOPIC" to {"projectId":"PROJECT","directory":"/proposals"}. The trusted project adapter atomically publishes TASKID.json with taskId, revision and items to this dedicated read-only mount. The bridge registers newly accepted tasks in that binding, rechecks its revision and presents one numbered list to the paired owner. An interrupted ambiguous Telegram send requires the ordinary owner lookup for recovery.

For plain Telegram mentions with Guest Mode, configure BB_TELEGRAM_GUEST_TOPICS as a comma-separated list of chatId:topicId pairs. The bot must already be a member of each forum and the binding must require a mention. The receiver accepts guest text with an explicit mention, uses the original group access policy and deduplicates ordinary and guest updates for the same source message.


### Recover an unanswered direct mention

An administrator with the original conversation open can select a single unanswered
text mention in the bridge's retained history before migrating the binding. Review
the message and later replies first. An answer under a different owner's request
has a separate receipt. Use the bot's Telegram message ID, which may differ from
the ID in a user's history for a basic group.

    bb telegram-projects recover-mention select CHAT TOPIC MESSAGE

The selection uses the stored sender and text. For older history without entity
metadata, select only after verifying the original direct address in Telegram.
Legacy support requires the text to begin with the bot's handle followed by
whitespace and a request. A selection expires in 24 hours and can be discarded
with the same command using `discard`. No message is sent during selection.

After the isolated executor is installed, bound to this topic and verified:

    bb telegram-projects recover-mention queue CHAT TOPIC MESSAGE

Queueing rechecks the owner, bot, current binding, executor, sender permission,
source grants and existing jobs or receipts. It leaves the live Telegram update
offset untouched. The ordinary group worker records the task and delivers its
reply under the original message. A queued selection is single-use, including
when delivery is uncertain. Thread-originated calls are refused.
