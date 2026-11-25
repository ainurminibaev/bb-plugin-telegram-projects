import type {BbPluginApi} from "@get-bb/plugin-sdk";
import {z} from "zod";
type Database=ReturnType<BbPluginApi["storage"]["database"]>;

// The conversation archive: every message the bot sees in every chat, topic and private chat,
// with the real Telegram IDs. Texts are kept without a time limit; files are kept as Telegram
// file IDs (the bytes live in the inbox under its own retention). The agent reads the archive
// with one tool; what a conversation may read is decided here, by the conversation that calls.

/** Voice transcripts made by the bridge, for the archive. Set once by the bridge. */
export const voiceTranscripts:{observe?:(chat:number,message:number,transcript:string)=>void}={};

export type ArchiveRow={chat:number;topic:number;message:number;date:number;sender:number;senderName:string;
  chatType:string;chatTitle:string;replyTo:number|null;album:string|null;fileId:string|null;fileName:string|null;
  fileKind:string|null;fileSize:number|null;text:string};

const LAT="a b v g d e zh z i y k l m n o p r s t u f h c ch sh shch y e yu ya".split(" ");
const CYR="а б в г д е ж з и й к л м н о п р с т у ф х ц ч ш щ ы э ю я".split(" ");
const toLatin=new Map(CYR.map((c,i)=>[c,LAT[i]]));
toLatin.set("ь","").set("ъ","");

/** Lower case, «ё» as «е», letters and digits only. */
export function normalize(text:string) {
  return text.toLowerCase().replaceAll("ё","е").replace(/[^\p{L}\p{N}]+/gu," ").trim();
}
export function cyrToLat(text:string) {
  return [...text].map(ch=>toLatin.get(ch)??ch).join("");
}
/** Latin to Cyrillic, longest letter groups first. */
export function latToCyr(text:string) {
  const pairs=LAT.map((l,i)=>[l,CYR[i]] as const).filter(([l])=>l).sort((a,b)=>b[0].length-a[0].length);
  let out="";
  for (let i=0;i<text.length;) {
    const hit=pairs.find(([l])=>text.startsWith(l,i));
    if (hit) {out+=hit[1];i+=hit[0].length;} else {out+=text[i];i++;}
  }
  return out;
}
/** What the index stores: the text, its name, and the same in the other alphabet. */
export function searchText(text:string,name:string) {
  const base=normalize(name+" "+text);
  return [base,cyrToLat(base),latToCyr(base)].join(" ");
}
const trigrams=(word:string)=>{const t:string[]=[];for (let i=0;i+3<=word.length;i++) t.push(word.slice(i,i+3));return t;};

function fileOf(m:any) {
  const photo=Array.isArray(m.photo) ? m.photo.at(-1) : undefined;
  const doc=m.document ?? m.video ?? m.audio ?? m.voice ?? m.video_note ?? m.animation ?? m.sticker;
  const f=photo ?? doc;
  if (!f?.file_id) return undefined;
  const kind=photo ? "photo" : m.document ? "document" : m.video ? "video" : m.audio ? "audio" : m.voice ? "voice" :
    m.video_note ? "video_note" : m.animation ? "animation" : "sticker";
  return {fileId:String(f.file_id),fileName:typeof f.file_name==="string" ? f.file_name.slice(0,255) : null,
    fileKind:kind,fileSize:Number.isSafeInteger(f.file_size) ? f.file_size : null};
}

/** The archive row of a Telegram update, or undefined for anything that is not a message. */
export function archiveRow(update:any):ArchiveRow|undefined {
  const m=update?.message ?? update?.edited_message;
  if (!m || !Number.isSafeInteger(m.chat?.id) || !Number.isSafeInteger(m.message_id) || !Number.isSafeInteger(m.date)) return;
  if (m.migrate_to_chat_id || m.migrate_from_chat_id) return;
  const sender=m.from ?? m.sender_chat;
  const senderName=[sender?.first_name,sender?.last_name].filter(Boolean).join(" ") || sender?.title || sender?.username || "";
  const file=fileOf(m);
  const text=String(m.text ?? m.caption ?? "");
  if (!text && !file) return;
  // A voice message is archived at once; its transcript is added when the bridge has it.
  return {chat:m.chat.id,topic:m.is_topic_message ? (m.message_thread_id ?? 0) : 0,message:m.message_id,date:m.date,
    sender:Number.isSafeInteger(sender?.id) ? sender.id : 0,senderName:String(senderName).slice(0,128),
    chatType:String(m.chat.type ?? ""),chatTitle:String(m.chat.title ?? senderName ?? "").slice(0,128),
    replyTo:Number.isSafeInteger(m.reply_to_message?.message_id) && m.reply_to_message.message_id!==m.message_thread_id ? m.reply_to_message.message_id : null,
    album:typeof m.media_group_id==="string" ? m.media_group_id : null,
    fileId:file?.fileId??null,fileName:file?.fileName??null,fileKind:file?.fileKind??null,fileSize:file?.fileSize??null,text};
}

export const archiveQuery=z.object({
  words:z.string().max(500).optional().describe("Words to look for. Case, «ё», typos in long words and Latin/Cyrillic spelling do not matter."),
  author:z.string().max(128).optional().describe("Messages of one person: part of the name or the Telegram ID."),
  from:z.string().max(40).optional().describe("Start, ISO date or date-time, for example 2026-11-22 or 2026-11-22T09:00."),
  to:z.string().max(40).optional().describe("End, ISO date or date-time; a date alone means the whole day."),
  timeZone:z.string().max(64).optional().describe("Time zone of from/to, for example Europe/Moscow. Default: the bridge setting."),
  last:z.number().int().min(1).max(200).optional().describe("Only the last N matching messages."),
  files:z.boolean().optional().describe("Only messages with a file or photo."),
  chat:z.string().max(128).optional().describe("Limit to one chat: part of its title or its chat ID."),
  topic:z.number().int().min(0).optional().describe("Limit to one topic of that chat (0: General or no topics)."),
}).strict();
export type ArchiveQuery=z.infer<typeof archiveQuery>;

function zoneOffset(date:Date,timeZone:string) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone,hourCycle:"h23",year:"numeric",month:"2-digit",
    day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}).formatToParts(date).map(p=>[p.type,p.value]));
  const local=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
  return local-date.getTime();
}
/** Seconds since epoch for a local date or date-time in a time zone; a date alone ends at the end of the day. */
export function localSeconds(value:string,timeZone:string,end:boolean) {
  const m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) throw Error("invalid_date");
  const dateOnly=m[4]===undefined;
  const utc=Date.UTC(+m[1],+m[2]-1,+m[3],dateOnly ? (end?23:0) : +m[4],dateOnly ? (end?59:0) : +m[5],dateOnly ? (end?59:0) : +(m[6]??0));
  const guess=new Date(utc);
  return Math.floor((utc-zoneOffset(guess,timeZone))/1000);
}

export const FILE_REMOVED="файл удалён по сроку";

/** A stored message as the agent sees it in search results. */
function toResult(r:any) {
  return {chat:r.chat,chatTitle:r.chat_title,topic:r.topic,message:r.message,
        date:new Date(r.date*1000).toISOString(),author:r.sender_name,authorId:r.sender,replyTo:r.reply_to??undefined,
        album:r.album??undefined,file:r.file_id ? {kind:r.file_kind,name:r.file_name??undefined,size:r.file_size??undefined} :
          r.file_removed ? {kind:r.file_kind,name:r.file_name??undefined,removed:FILE_REMOVED} : undefined,
        text:String(r.text).slice(0,2000),transcript:r.transcript ? String(r.transcript).slice(0,2000) : undefined,
        link:String(r.chat).startsWith("-100") && r.message>0 ? `https://t.me/c/${String(r.chat).slice(4)}/${r.topic ? r.topic+"/" : ""}${r.message}` : undefined};
}

export function openArchive(db:Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS archive(
      bot INTEGER NOT NULL, chat INTEGER NOT NULL, topic INTEGER NOT NULL, message INTEGER NOT NULL, date INTEGER NOT NULL,
      sender INTEGER NOT NULL, sender_name TEXT NOT NULL, chat_type TEXT NOT NULL, chat_title TEXT NOT NULL,
      reply_to INTEGER, album TEXT, file_id TEXT, file_name TEXT, file_kind TEXT, file_size INTEGER,
      text TEXT NOT NULL, search TEXT NOT NULL, PRIMARY KEY(bot,chat,message));
    CREATE INDEX IF NOT EXISTS archive_by_date ON archive(bot,chat,topic,date);
    CREATE INDEX IF NOT EXISTS archive_by_sender ON archive(bot,sender,date);`);
  const columns=(db.prepare("PRAGMA table_info(archive)").all() as {name:string}[]).map(c=>c.name);
  if (!columns.includes("transcript")) db.exec("ALTER TABLE archive ADD COLUMN transcript TEXT");
  if (!columns.includes("file_removed")) db.exec("ALTER TABLE archive ADD COLUMN file_removed INTEGER");
  let fts=true;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(search, content='archive', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS archive_ai AFTER INSERT ON archive BEGIN INSERT INTO archive_fts(rowid,search) VALUES(NEW.rowid,NEW.search); END;
      CREATE TRIGGER IF NOT EXISTS archive_ad AFTER DELETE ON archive BEGIN INSERT INTO archive_fts(archive_fts,rowid,search) VALUES('delete',OLD.rowid,OLD.search); END;
      CREATE TRIGGER IF NOT EXISTS archive_au AFTER UPDATE ON archive BEGIN INSERT INTO archive_fts(archive_fts,rowid,search) VALUES('delete',OLD.rowid,OLD.search); INSERT INTO archive_fts(rowid,search) VALUES(NEW.rowid,NEW.search); END;`);
  } catch { fts=false; }
  const upsert=db.prepare(`INSERT INTO archive(bot,chat,topic,message,date,sender,sender_name,chat_type,chat_title,reply_to,album,file_id,file_name,file_kind,file_size,text,search)
    VALUES(@bot,@chat,@topic,@message,@date,@sender,@senderName,@chatType,@chatTitle,@replyTo,@album,@fileId,@fileName,@fileKind,@fileSize,@text,@search)
    ON CONFLICT(bot,chat,message) DO UPDATE SET text=excluded.text,search=excluded.search,file_id=COALESCE(excluded.file_id,archive.file_id),
      file_name=COALESCE(excluded.file_name,archive.file_name),file_kind=COALESCE(excluded.file_kind,archive.file_kind)`);
  const moveChat=db.prepare("UPDATE OR IGNORE archive SET chat=? WHERE bot=? AND chat=?");
  return {
    record(bot:number,update:any) {
      const row=archiveRow(update);
      if (row) upsert.run({bot,...row,search:searchText(row.text+" "+(row.fileName??""),row.senderName)});
      return row;
    },
    /** The bridge's transcript of a voice message: kept with the message and searchable. */
    transcript(bot:number,chat:number,message:number,transcript:string) {
      const row=db.prepare("SELECT text,file_name,sender_name FROM archive WHERE bot=? AND chat=? AND message=?").get(bot,chat,message) as
        {text:string;file_name:string|null;sender_name:string}|undefined;
      if (!row) return false;
      db.prepare("UPDATE archive SET transcript=?, search=? WHERE bot=? AND chat=? AND message=?")
        .run(transcript,searchText(row.text+" "+transcript+" "+(row.file_name??""),row.sender_name),bot,chat,message);
      return true;
    },
    /** A basic group that became a supergroup keeps its archive under the new chat ID. */
    moveChat(bot:number,from:number,to:number) { moveChat.run(to,bot,from); },
    find(bot:number,chats:(chat:number)=>boolean,q:ArchiveQuery,defaultZone:string) {
      const where=["a.bot=?"]; const args:unknown[]=[bot];
      const zone=q.timeZone||defaultZone||"UTC";
      if (q.from) {where.push("a.date>=?");args.push(localSeconds(q.from,zone,false));}
      if (q.to) {where.push("a.date<=?");args.push(localSeconds(q.to,zone,true));}
      if (q.files) where.push("(a.file_id IS NOT NULL OR a.file_removed=1)");
      if (q.topic!==undefined) {where.push("a.topic=?");args.push(q.topic);}
      if (q.author) {
        if (/^\d+$/.test(q.author.trim())) {where.push("a.sender=?");args.push(Number(q.author.trim()));}
        // SQLite lower() is ASCII only: names are compared after normalization below.
      }
      if (q.chat) {
        if (/^-?\d+$/.test(q.chat.trim())) {where.push("a.chat=?");args.push(Number(q.chat.trim()));}

      }
      const words=normalize(q.words??"").split(" ").filter(Boolean);
      const grams=[...new Set(words.flatMap(w=>[w,cyrToLat(w),latToCyr(w)]).flatMap(trigrams))];
      let sql:string;
      if (grams.length && fts) {
        sql=`SELECT a.* FROM archive_fts f JOIN archive a ON a.rowid=f.rowid WHERE archive_fts MATCH ? AND ${where.join(" AND ")}`;
        args.unshift(grams.map(g=>'"'+g.replaceAll('"','""')+'"').join(" OR "));
      } else {
        sql=`SELECT a.* FROM archive a WHERE ${where.join(" AND ")}`;
        for (const w of words) {sql+=" AND a.search LIKE ?";args.push("%"+w+"%");}
      }
      const rows=(db.prepare(sql+" ORDER BY a.date DESC, a.message DESC LIMIT 5000").all(...args) as any[])
        .filter(r=>chats(r.chat))
        .filter(r=>!q.author || /^\d+$/.test(q.author.trim()) || normalize(r.sender_name).includes(normalize(q.author)))
        .filter(r=>!q.chat || /^-?\d+$/.test(q.chat.trim()) || normalize(r.chat_title).includes(normalize(q.chat)));
      // Each word must match with most of its trigrams in one of the spellings: tolerant to a typo or two.
      const matches=(r:any)=>words.every(w=>{
        if (w.length<3) return r.search.includes(w);
        return [w,cyrToLat(w),latToCyr(w)].some(v=>{const t=trigrams(v);return t.length && t.filter(g=>r.search.includes(g)).length>=Math.ceil(t.length*0.6);});
      });
      const found=(words.length ? rows.filter(matches) : rows).slice(0,q.last ?? 30);
      return found.reverse().map(toResult);
    },
    /** С81: one message by its number, as a search result; the agent reads the text of a message it was answered to. */
    message(bot:number,chat:number,message:number) {
      const r=db.prepare("SELECT * FROM archive WHERE bot=? AND chat=? AND message=?").get(bot,chat,message) as any;
      return r ? toResult(r) : undefined;
    },
    /** С103: when the bot itself last wrote in this chat (and topic, when given), in Telegram seconds. */
    lastSent(bot:number,chat:number,topic?:number) {
      const row=(topic===undefined
        ? db.prepare("SELECT max(date) AS d FROM archive WHERE bot=? AND chat=? AND sender=?").get(bot,chat,bot)
        : db.prepare("SELECT max(date) AS d FROM archive WHERE bot=? AND chat=? AND topic=? AND sender=?").get(bot,chat,topic,bot)) as {d:number|null}|undefined;
      return row?.d ?? undefined;
    },
    /** С105: the bot itself wrote in this chat and topic after message N (a final, send, reply or a subthread's message). */
    wroteAfter(bot:number,chat:number,topic:number,message:number) {
      return (db.prepare("SELECT message,reply_to FROM archive WHERE bot=? AND chat=? AND topic=? AND sender=? AND message>? ORDER BY message LIMIT 50")
        .all(bot,chat,topic,bot,message) as {message:number;reply_to:number|null}[]).map(r=>({message:r.message,replyTo:r.reply_to ?? undefined}));
    },
    /** Who sent a message, for С80 (own or someone else's). */
    sender(bot:number,chat:number,message:number) {
      return (db.prepare("SELECT sender FROM archive WHERE bot=? AND chat=? AND message=?").get(bot,chat,message) as {sender:number}|undefined)?.sender;
    },
    file(bot:number,chat:number,message:number) {
      return db.prepare("SELECT file_id,file_name,file_kind,file_size,file_removed FROM archive WHERE bot=? AND chat=? AND message=?").get(bot,chat,message) as
        {file_id:string|null;file_name:string|null;file_kind:string|null;file_size:number|null;file_removed:number|null}|undefined;
    },
    /**
     * Retention (В2): texts stay forever; files older than the term are no longer kept. The message keeps
     * its text and file name with a "removed by term" mark. Returns the messages whose files went.
     */
    expireFiles(before:number) {
      const gone=db.prepare("SELECT bot,chat,message FROM archive WHERE file_id IS NOT NULL AND date<?").all(before) as
        {bot:number;chat:number;message:number}[];
      if (gone.length) db.prepare("UPDATE archive SET file_id=NULL,file_removed=1 WHERE file_id IS NOT NULL AND date<?").run(before);
      return gone;
    },
    /**
     * The history the bridge kept before the archive existed (group:history). Imported once on update and safe
     * to repeat: a message already in the archive (same chat, time, author and text) is not added again. Imported
     * messages get negative numbers: before a group became a supergroup Telegram numbered them separately, so
     * they must not collide with the group's current messages.
     */
    importHistory(bot:number,items:{chat:number;topic:number;id:number;sender:number;name:string;date:number;replyTo?:number;text:string;title?:string}[]) {
      const exists=db.prepare("SELECT 1 FROM archive WHERE bot=? AND chat=? AND date=? AND sender=? AND (text=? OR message=?)");
      const insert=db.prepare(`INSERT OR IGNORE INTO archive(bot,chat,topic,message,date,sender,sender_name,chat_type,chat_title,reply_to,album,file_id,file_name,file_kind,file_size,text,search)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`);
      let added=0;
      db.transaction(()=>{
        for (const h of items) {
          if (!h.text || !Number.isSafeInteger(h.id) || !Number.isSafeInteger(h.date)) continue;
          if (exists.get(bot,h.chat,h.date,h.sender,h.text,-h.id)) continue;
          const type=String(h.chat).startsWith("-100") ? "supergroup" : h.chat<0 ? "group" : "private";
          added+=insert.run(bot,h.chat,h.topic,-h.id,h.date,h.sender,h.name.slice(0,128),type,(h.title ?? h.name).slice(0,128),
            h.replyTo ? -h.replyTo : null,h.text,searchText(h.text,h.name)).changes;
        }
      })();
      return added;
    },
    /** Groups where a person has written: their memberships as the archive knows them. */
    groupsOf(bot:number,person:number) {
      return (db.prepare("SELECT DISTINCT chat FROM archive WHERE bot=? AND sender=? AND chat<0").all(bot,person) as {chat:number}[]).map(r=>r.chat);
    },
  };
}
export type Archive=ReturnType<typeof openArchive>;
