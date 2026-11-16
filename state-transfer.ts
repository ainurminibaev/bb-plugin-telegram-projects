import {createHash, randomUUID} from "node:crypto";
import {constants, mkdirSync, lstatSync, openSync, closeSync, writeFileSync, readFileSync, fstatSync, fsyncSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";
import {z} from "zod";
import type {Store} from "./model";

const snapshotSchema = z.object({
  version: z.literal(1), pluginId: z.literal("telegram-projects"),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  rows: z.array(z.object({key: z.string(), value: z.unknown()})),
}).strict();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const restoreKey = "migration:state-restore";

// Outside BB's plugin directory: normal plugin removal must not delete this
// private recovery copy. Neither credentials nor state are returned over RPC.
export class StateTransfer {
  constructor(private store: Store, private root = join(homedir(), ".bb-plugin-backups")) {}
  private secureDirectory() {
    for (const dir of [this.root, join(this.root, "telegram-projects")]) {
      try { mkdirSync(dir, {mode: 0o700}); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
          (process.getuid && stat.uid !== process.getuid())) throw Error("backup_directory_not_private");
    }
    return join(this.root, "telegram-projects");
  }
  export(settings: Record<string, string | number | boolean | undefined | null>) {
    if (settings.enabled || settings.chatEnabled) throw Error("disable_receivers_before_transfer");
    const data = snapshotSchema.parse({version: 1, pluginId: "telegram-projects",
      settings: Object.fromEntries(Object.entries(settings).filter(([,v]) => v !== undefined)),
      rows: this.store.list("").filter(row => row.key !== restoreKey)});
    const text = JSON.stringify(data);
    const id = randomUUID();
    const path = join(this.secureDirectory(), id + ".json");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    return {id, sha256: digest(text), rows: data.rows.length};
  }
  async restore(id: string, sha256: string, setSettings: (value: z.infer<typeof snapshotSchema>["settings"]) => Promise<unknown>) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha256)) throw Error("invalid_backup_identity");
    const fd = openSync(join(this.secureDirectory(), id + ".json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 100 * 1024 * 1024 || (stat.mode & 0o077) ||
          (process.getuid && stat.uid !== process.getuid())) throw Error("backup_file_not_private");
      text = readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
    if (digest(text) !== sha256) throw Error("backup_checksum_mismatch");
    const data = snapshotSchema.parse(JSON.parse(text));
    if (data.settings.enabled || data.settings.chatEnabled) throw Error("backup_receivers_must_be_disabled");
    if (new Set(data.rows.map(r => r.key)).size !== data.rows.length || data.rows.some(r => r.key === restoreKey))
      throw Error("invalid_backup_rows");
    const previous = this.store.get<{sha256:string}>(restoreKey);
    if (previous && previous.sha256 !== sha256) throw Error("different_backup_already_restored");
    if (!previous && this.store.list("").length) throw Error("restore_requires_empty_state");
    if (previous) {
      const current = this.store.list("").filter(r => r.key !== restoreKey);
      if (current.length !== data.rows.length || data.rows.some(row =>
          JSON.stringify(this.store.get(row.key)) !== JSON.stringify(row.value)))
        throw Error("restored_state_has_changed");
    }
    await setSettings({...data.settings, enabled:false, chatEnabled:false});
    this.store.atomic(() => {
      for (const row of data.rows) this.store.put(row.key, row.value);
      this.store.put(restoreKey, {sha256, id});
    });
    return {restored: true as const, rows: data.rows.length, sha256};
  }
}
