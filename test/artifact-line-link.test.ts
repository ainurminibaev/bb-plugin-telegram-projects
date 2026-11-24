import test from "node:test";
import assert from "node:assert/strict";
import { localArtifacts } from "../telegram-ux";

// #14 (employee): a link to a line of a file still sends the file.
test("a file link with a line number becomes the file itself", () => {
  for (const link of ["/work/out/report.pdf:44", "/work/out/report.pdf:44:3", "/work/out/report.pdf#L44", "/work/out/report.pdf#L10-L20"])
    assert.equal(localArtifacts(`[отчёт](${link})`)[0]?.path, "/work/out/report.pdf", link);
  assert.equal(localArtifacts("[план](/work/out/plan-2026.md)")[0]?.path, "/work/out/plan-2026.md");
});
