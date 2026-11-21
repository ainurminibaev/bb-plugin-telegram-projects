# Employee and group setup

This opt-in mode runs in the existing Telegram Bridge poller. Use a training installation for acceptance. The Telegram account that pairs must match the bootstrap owner. Configure the authenticated bot ID and username. Set the profile's settingsTitle to the desired localized button label.

## Server administrator

From the release checkout with dependencies installed, provision from [the example](employee-profile.example.json).

```sh
node_modules/.bin/tsx tools/create-employee-profile.ts /admin/bootstrap.json /admin/employee.json
```

Give the trusted receiver read access to the resulting file. Keep the containing directory, file, socket endpoints, grants and credentials outside the model's writable space. Set BB_TELEGRAM_EMPLOYEE_PROFILE to the absolute published file path in the receiver service and restart. Bootstrap publishes a complete validated file and refuses to replace an existing file. For a maintenance change, prepare and validate a new file, then atomically replace the old one. Validate socket ownership and service reachability on that installation. Use one receiver per bot token.

Only the host administrator installs isolated adapters, credentials, sockets and the outer catalog. Each operation ID names a single target resource, connection reference, required sources and minimum approval requirement. Credentials stay with the action adapter. An allowed connection is a reference, never a token. Adapter services must have only their assigned data and must validate inputs against their fixed resource. The conversation service must enforce the supplied source list and keep contexts separate by group and topic. Give it no direct tracker credentials or alternative execution path.

## Private administration

Ship the bootstrap profile with the employee repository. Catalog assignments in it are active immediately after pairing. The first screen summarizes effective assignments, their origin and missing participants or approvers; it does not require a setup wizard. It describes assignments, not network or credential health. A saved local selection and group versions live in BB storage and remain in effect when the plugin or repository profile is updated. New catalog choices are not added to an existing local selection automatically; removed choices are unavailable immediately.

After owner pairing, or with /start in the paired owner's DM, the keyboard shows the profile settings button and «Мои группы». /employee also opens the owner's profile. The owner selects the active role, administrators, members, sources, connections, operations, approvers and events within the installed catalog. Save checks the current catalog and profile revision. The bootstrap owner retains administration; a server-required approval cannot be removed. Group administrators can modify group cards; only the owner edits the employee-wide profile.

On joining a group, the bot offers its administrators «Мои группы» in their private chats. Telegram requires each admin to start a private conversation before the bot can contact them. Use «Мои группы» or /groups to reopen the directory by group name. An existing unbound group can register via /setup by an employee administrator inside the group. Forum topics become selectable when an update for that topic reaches the bot. In a new group all rule selections start empty. Saved selections include topics, senders, sources, operations, approvers, mention/reply triggers and optional proactive greetings for allowed senders' member-joined and topic-created events. A group can require extra approval for an operation. The note stays in the admin card and never enters a grant or adapter request. A profile or group change invalidates open group drafts and pending action confirmations.

Existing legacy group bindings keep their original handlers and outstanding work. The managed group component does not import or override those policies. Switching an already bound group requires a separate controlled migration. Ordinary private messages retain the original bridge routing. Group privacy settings determine which Telegram events actually reach the bot. Other BB ingress channels and autonomous timers are outside this Telegram release.

## Adapter contract

Both adapters receive HTTP POST / with UTF-8 JSON over local Unix sockets.

- Conversation input includes kind=conversation, role, chat, topic, actor, text, optional event, allowed sources and permitted operations (id and resource). Return either {"kind":"answer","text":"..."} or {"kind":"proposal","operation":"task.create.training","input":"..."}. A proposal may only select an allowed ID. Free text cannot change configuration.
- The action adapter receives kind=execute, operation, resource, connection, input, actor, chat, topic and idempotencyKey. Reply HTTP 200 with a JSON object after verified execution. A required approval is bound to the displayed input and resource, actor eligibility, group and current policy revision. The receiver reserves the execution before calling the socket. An ambiguous write remains started for adapter-side reconciliation by the same key. Do not resend it blindly. The built-in receipt reports completion; use the selection contract below for verified links.

### Versioned multi-item decisions

Configure `resultHost` on the server's operation to enable verified links. Return `{"kind":"selection","operation":"task.create.training","revision":1,"items":["First title","Second title","Third title"]}` from the conversation socket. Items must be printable single lines (1–10 items, at most 300 characters each). Each inbound group message creates one immutable offer. The approver replies to the delivered private list, for instance «первый и третий». Selection uses the shared owner-selection parser. Old offers cannot execute after a group or global policy change. A new offer needs a fresh decision.

The action request carries the trusted `choice` with `actor,taskId,revision,draftHash,selected`, the displayed `items` and the filtered `selectedItems`. The hash is SHA-256 of UTF-8 JSON.stringify(items). Use the stable idempotency key with the item number in the project adapter. Before each external write, use a restricted trusted transport to the read-only `checkEmployeeWrite` RPC with `{...choice,idempotencyKey,item,operation,resource,connection}`. Require `allowed:true` and keep the adapter call synchronous through verification of the external effect. It becomes false once the call completes, if a selection is stale or if the item wasn't selected. Return `{...choice,links:[...verifiedHttpsLinks]}` after independent project verification. The bridge validates the receipt, host, count and uniqueness with the same link checks as the legacy return path, rechecks the policy and sends the links to the original group message. Failure of a socket call after reservation is recorded as unconfirmed and needs reconciliation. The supplied adapter must implement this contract and restrict its own network credentials; no grant is inferred from the note or from returned prose.

Run the offline acceptance from the bridge checkout.

```sh
npm ci --ignore-scripts
node_modules/.bin/tsx --test test/employee-policy.test.ts
npm run check
```

The test sends Telegram-shaped updates through the managed handler and calls a listening Unix socket. It exercises private cards, concurrent saves, an inert note, a second group, source and operation limits, stale approval, current approver and one external operation on the configured training board. Live acceptance on a project bot also requires the two project adapters.


## Direct personal requests from a managed group

Version 0.9.25 adds an optional server-provisioned personal grant. Assign it once per authenticated Telegram user. It applies in every enrolled group with an enabled topic. The grant has no chat or topic field. The normal rule for other group members remains unchanged.

```json
{"personalGrants":[{"subject":103,"operations":["task.create.training"],"conversationSocket":"/run/employee-training/private-conversation.sock","allowHere":true}]}
```

Each operation must already be in the employee catalog with a fixed resource, sources and resultHost. The subject must be an active employee member. For a write requiring confirmation the subject must also be an eligible approver. The subject opens the bot's DM with /start once. A trusted Telegram sender ID, the active topic and a native mention address the request. A single explicit destination phrase such as «ответь мне в личку» or «ответь сюда» selects delivery. Forwarded messages, Telegram quote blocks and quoted instructions cannot initiate the personal lane.

The private conversation adapter receives scope=personal, principal, destination=dm|here, actor, originating chat/topic and its permitted operations/sources. Isolate this conversation from group history and other subjects. For a here request also isolate by audience and allowed source set, including for the same subject. Never retrieve other private material or reuse a DM transcript in the group answer. The adapter validates the specific project record, exact date and request wording. It can answer directly or return a versioned selection. Writes in this lane use a versioned item or selection and checkEmployeeWrite immediately before each write. The action call includes the principal and destination. The checked HTTPS result goes only to the subject's verified DM or the exact original group message. This version does not delegate a personal confirmation to a third person.

For here delivery the subject must have allowHere and the independent administrator-owned BB_TELEGRAM_SOURCE_GRANTS file must allow the operation's sources for the exact bot:chat:topic. The bridge filters operations before reading, rechecks the set of conversational sources after preparing the response, checks before action dispatch, in the adapter's pre-write check, and again before delivery. A missing file or missing audience grant blocks disclosure. Group-wide tool rights are not changed. Test both recipients and the revocation race with `node_modules/.bin/tsx --test test/employee-personal.test.ts`.


A private conversation adapter can return one fully specified instruction as
`{"kind":"direct","operation":"move","revision":1,"item":"Card 17 → 2026-11-28"}`.
The sender's personal grant must include that operation. If effective employee
settings require approval, the bridge asks the eligible sender in their private
chat. Otherwise it executes the single item immediately with the same adapter
write check, verified result link and destination check. Return `selection` for
a draft that needs user choice, even when it currently contains just one item.
Group conversation adapters cannot request direct personal execution.


### Binary personal access

Provision `personalAccess: {"subjects":[123],"conversationSocket":"/run/employee/personal.sock"}` to give a verified subject the active employee profile. The owner can toggle eligible subjects under «Личный доступ». Existing saved limits start with no newly eligible subjects enabled. Legacy personalGrants retain their restricted operations and separate disclosure checks. Remove the legacy entry before explicitly enabling the new profile for that subject.

After /start a personal-access subject can send a request in the bot DM. In an enrolled group a native mention and «ответь сюда» address one result to that exact topic, including when the topic has no access to the source. «Ответь мне в личку» selects the private route. Approval of a write is still required for a versioned selection. Scope the personal adapter to the authenticated principal, and expose only the requested result for public delivery. Ordinary group requests still use their group policy.

«Мои группы» also lists the owner's existing legacy topic bindings as read-only text. Viewing them preserves routing and does not enroll the group.

### Recover a started selection after an uncertain external write

An administrator calls `bb plugin rpc call telegram-projects reconcileEmployeeTicket --input-file ticket.json --json`. Supply only the original `{"idempotencyKey":"<32 lowercase hex characters>"}`. The bridge loads the actor, destination, selection and route from the original ticket. The same action socket receives the original payload with kind `reconcile`. Implement this as a read-only lookup of the external effects and original reservation. Return the verified receipt in the same format as execute; return an error if the effect cannot be verified. The bridge rechecks current grants before lookup and delivery and reserves one Telegram send. A confirmed delivery returns sent and messageId, including on repetition. An ambiguous delivery or interruption after reserving the send requires independent Telegram readback. The RPC never reissues execute.

### Group Privacy Mode

Token setup displays getMe's Privacy Mode. When a bot joins a group the bridge checks the actual Telegram administrator list and sends a private summary to the inviting administrator or group creator. It describes the global setting, the bot's role, ordinary message visibility, addressing and group rules. Membership and visibility transitions are tracked independently per group. A denied DM is recorded as unavailable. No group posting or permission changes are performed by this notification.

### Project checkpoint at a group task deadline

For an existing task with an active group binding, the paired owner schedules `telegram_group_reminder` in the direct BB thread or calls the existing owner-turn RPC `scheduleGroupReminder`. Supply taskId, dueAt (Unix milliseconds), waitingFor="checkpoint"; omit text. The RPC also requires the authenticated threadId and routeToken. One reminder slot belongs to each task. Repeating the identical request returns its current state.

Set BB_TELEGRAM_CHECKPOINT_ADAPTERS to an absolute path to an administrator-owned JSON file. Each project ID maps to {"socket":"/run/team/checkpoint.sock","sources":["meeting","tracker"]}. Assign all sources to the originating bot/chat/topic in BB_TELEGRAM_SOURCE_GRANTS. The bridge derives the route and calls the project socket with HTTP POST / and JSON {kind:"checkpoint",taskId,projectId,threadId,chatId,topicId,messageId,dueAt}. The adapter looks up the card by the stored task ID and reads the current authorized topic and card. Return HTTP 200 with {"kind":"reply","text":"..."} or {"kind":"complete"}. A read failure must return a non-success status. Read-only calls may be repeated. Responses cannot override the recipient.

An unsuccessful read leaves the reminder queued for retry after 30 seconds. A successful read is followed by a fresh thread, binding, adapter and source check. The bridge replies under the original message or records cancelled for a silent completion. Revoked access prevents delivery. A Telegram send with an uncertain outcome remains unknown and is never automatically repeated. The bridge supplies no project-specific readers or decision logic.

Run `node_modules/.bin/tsx --test test/group-result.test.ts` from the plugin checkout for the Unix-socket and restart fixture.

### Private requests with separate BB workers

The current employee installation can use the opt-in setting `employeePrivateRequests`. It defaults to false and applies only to employee installations with chat enabled and legacy operations disabled. The paired owner's direct chat and group settings keep their existing routes. Legacy `personalAccess` and `personalGrants` still apply in legacy mode. Their entitlements do not enable the separate BB inbox.

A new user receives one access notice. The paired owner receives one decision card with the display name, username when provided, and Telegram user ID. The bridge accepts a decision only from the paired owner, in the owner's private chat, on the original card for this bot. The same card permits revocation. The bridge drops pre-approval messages. An approved user can queue work only when a separate worker is assigned.

Provision a separate BB instance, project, root thread, history, attachment cache and administrator-owned launcher for each user. Configure `BB_TELEGRAM_PRIVATE_EXECUTORS` on the receiver as a JSON object keyed by `BOT_ID:OWNER_ID:TELEGRAM_USER_ID`. Each target has `projectId`, `threadId` and an absolute `cli` path. The bridge rejects shared targets across private and group routes. Set `isolatedPrivateProject` and `isolatedPrivateThread` on the worker. Keep polling, Telegram credentials and owner pairing absent on workers. Forward `submitIsolatedPrivate`, `readIsolatedPrivate` and the standard isolated attachment upload through that worker's launcher.

Give each worker only its assigned role, read-only shared project knowledge and authorized tools. Keep private histories and upload caches in separate worker storage. Keep provider and integration credentials outside the model's shell. Keep the owner's BB, sibling instances and the host Docker socket inaccessible. Test these restrictions in the actual model's tool environment with synthetic data before activation. Tool adapters must enforce their resource and action scopes independently of the model. The receiver rechecks the subject and worker before submission and reply. Revocation stops future submissions and pending replies.

Cloud and local Bot API support incoming photos. Other documents use the configured local Bot API and a scoped inbox. Private messages are excluded from shared topic history search. The bridge retains in-flight messages until handoff and discards delivered answers from the queue.
