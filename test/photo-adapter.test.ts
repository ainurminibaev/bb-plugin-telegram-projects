import test from "node:test";
import assert from "node:assert/strict";
import { telegram } from "../adapters";

test("multipart photo and document retain filename and hide transport-only fields", async () => {
  const original = globalThis.fetch;
  try {
    for (const field of ["photo", "document"]) {
      globalThis.fetch = async (url, init) => {
        assert.ok(String(url).endsWith(field === "photo" ? "/sendPhoto" : "/sendDocument"));
        const form = init!.body as FormData;
        assert.equal(form.get("chat_id"), "123");
        const file = form.get(field) as File;
        assert.equal(file.name, "triangle.png");
        assert.equal(file.type, "image/png");
        assert.equal(await file.text(), "image-fixture");
        assert.equal(form.has(`${field}_filename`), false);
        return new Response(JSON.stringify({ok:true,result:{message_id:7}}));
      };
      const api = telegram(async()=>"test-token", new AbortController().signal, 1000, ()=>123);
      await api(field === "photo" ? "sendPhoto" : "sendDocument", {
        [field]: new Blob(["image-fixture"], {type:"image/png"}),
        [`${field}_filename`]: "triangle.png",
      });
    }
  } finally { globalThis.fetch = original; }
});
