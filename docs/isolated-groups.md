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

Before allowing participants, use a test group and a synthetic document. Ask the group to read an item from the document and return an edited PDF. Verify the source message, topic, worker thread, received file and an independent private request. Test that group work and its children cannot read personal files or reach the personal BB. The local fixture covers the BB runtime, PDF export and receipt checks. Live Telegram delivery with this deployment is still under acceptance.
