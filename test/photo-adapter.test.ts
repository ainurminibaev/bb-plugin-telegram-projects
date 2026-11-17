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

test("album multipart sends attach references and named files without filename fields", async()=>{
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async(url,init)=>{
   assert.ok(String(url).endsWith('/sendMediaGroup'));
   const form=init!.body as FormData;const media=JSON.parse(String(form.get('media')));
   assert.equal(media.length,2);assert.equal(media[0].media,'attach://media0');
   assert.equal(media[0].caption,'Снимок <&>');assert.equal(form.get('chat_id'),'123');
   for(let i=0;i<2;i++) {assert.equal((form.get(`media${i}`) as File).name,`${i}.png`);assert.equal(form.has(`media${i}_filename`),false);}
   return new Response(JSON.stringify({ok:true,result:[{message_id:1,media_group_id:'g'},{message_id:2,media_group_id:'g'}]}));
  };
  const api=telegram(async()=>"test-token",new AbortController().signal,1000,()=>123);
  const result=await api('sendMediaGroup',{media:[{type:'photo',media:'attach://media0',caption:'Снимок <&>'},{type:'photo',media:'attach://media1'}],media0:new Blob(['a']),media0_filename:'0.png',media1:new Blob(['b']),media1_filename:'1.png'});
  assert.equal(result.length,2);
 }finally{globalThis.fetch=original;}
});
