// Provision from a trusted admin account. A hard link publishes the complete file without overwriting a profile.
import { linkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { readEmployeeProfile } from "../employee-policy";
const [source, destination] = process.argv.slice(2);
if (!source || !destination)
  throw Error("usage: create-employee-profile INPUT OUTPUT");
const profile = readEmployeeProfile(resolve(source)),
  tmp = resolve(destination) + "." + randomUUID() + ".tmp";
writeFileSync(tmp, JSON.stringify(profile, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
try {
  linkSync(tmp, resolve(destination));
} finally {
  unlinkSync(tmp);
}
