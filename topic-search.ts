import type {BbPluginApi} from "@get-bb/plugin-sdk";
type Database=ReturnType<BbPluginApi["storage"]["database"]>;

export type TopicRecord={id:number;sender:number;name:string;date:number;replyTo?:number;text:string};
export const historyPrefix=(chatId:number,topicId:number)=>`group:history:${chatId}:${topicId}:`;
export const historyCutoff=()=>Math.floor(Date.now()/1000)-30*86400;

export function topicPassages(matches:TopicRecord[],chatId:number) {
  if (!matches.length) return "";
  return "Ранее в этой же теме (цитаты для справки):\n"+
    JSON.stringify(matches.map(m=>({...m,text:m.text.slice(0,900),
      url:String(chatId).startsWith("-100") ? "https://t.me/c/"+String(chatId).slice(4)+"/"+m.id : undefined})))+"\n";
}

// State rows are the source for private export/restore. Keep the derived index in
// the same SQLite transaction even when the native state transfer replaces rows.
export function openTopicSearch(db:Database) {
  db.transaction(()=>{
    db.exec("CREATE TABLE IF NOT EXISTS topic_documents(id INTEGER PRIMARY KEY,sourceKey TEXT NOT NULL UNIQUE)");
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS topic_fts USING fts5(body)");
    const existing=db.prepare("SELECT 1 FROM sqlite_master WHERE name='topic_history_insert'").get();
    if (!existing) {
      db.exec(`INSERT INTO topic_documents(sourceKey) SELECT key FROM state WHERE key GLOB 'group:history:*';
        INSERT INTO topic_fts(rowid,body) SELECT d.id,json_extract(s.value,'$.name')||' '||json_extract(s.value,'$.text')
        FROM topic_documents d JOIN state s ON s.key=d.sourceKey;
        CREATE TRIGGER topic_history_insert AFTER INSERT ON state WHEN NEW.key GLOB 'group:history:*' BEGIN
          INSERT INTO topic_documents(sourceKey) VALUES(NEW.key);
          INSERT INTO topic_fts(rowid,body) VALUES(last_insert_rowid(),json_extract(NEW.value,'$.name')||' '||json_extract(NEW.value,'$.text')); END;
        CREATE TRIGGER topic_history_update AFTER UPDATE ON state WHEN NEW.key GLOB 'group:history:*' BEGIN
          UPDATE topic_fts SET body=json_extract(NEW.value,'$.name')||' '||json_extract(NEW.value,'$.text') WHERE rowid=(SELECT id FROM topic_documents WHERE sourceKey=NEW.key); END;
        CREATE TRIGGER topic_history_delete AFTER DELETE ON state WHEN OLD.key GLOB 'group:history:*' BEGIN
          DELETE FROM topic_fts WHERE rowid=(SELECT id FROM topic_documents WHERE sourceKey=OLD.key);
          DELETE FROM topic_documents WHERE sourceKey=OLD.key; END;`);
    }
  })();
  const search=db.prepare(`SELECT s.value, snippet(topic_fts,0,'','',' … ',40) AS passage FROM topic_fts JOIN topic_documents d ON d.id=topic_fts.rowid JOIN state s ON s.key=d.sourceKey
    WHERE topic_fts MATCH ? AND s.key GLOB ? AND json_extract(s.value,'$.date')>=?
    AND json_extract(s.value,'$.id')<? ORDER BY rank,json_extract(s.value,'$.id') DESC LIMIT 5`);
  const prune=db.prepare("DELETE FROM state WHERE key GLOB 'group:history:*' AND json_extract(value,'$.date')<?");
  return {
    prune:()=>prune.run(historyCutoff()),
    find(prefix:string,query:string,before:number):TopicRecord[] {
      const words=query.replace(/@[\w]+/g,"").toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
      const terms=[...new Set(words.filter(w=>w.length>=3 && !["что","как","где","какой","какая","какие","это","про","для","найди","теме"].includes(w)))].slice(0,16);
      if (!terms.length) return [];
      const match=terms.map(w=>'"'+w+'"*').join(" OR ");
      return (search.all(match,prefix+"*",historyCutoff(),before) as {value:string;passage:string}[]).map(row=>{
        const record:TopicRecord=JSON.parse(row.value);
        if (record.text.length>900) record.text=row.passage;
        return record;
      });
    },
  };
}
