import test from "node:test";
import assert from "node:assert/strict";
import {runBb} from "../adapters";

test("0.9.74: a BB without the Tasks command is «not installed», not a failure; other failures stay failures", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(runBb("/bin/sh", "http://127.0.0.1:1", ["-c", "echo \"error: unknown command 'tasks'\" >&2; exit 1"], signal),
    /tasks_not_installed/);
  await assert.rejects(runBb("/bin/sh", "http://127.0.0.1:1", ["-c", "echo boom >&2; exit 1"], signal), /tasks_cli_unavailable/);
  assert.deepEqual(await runBb("/bin/sh", "http://127.0.0.1:1", ["-c", "echo '{\"ok\":true}'"], signal), {ok: true});
});
