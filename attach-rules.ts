import {sep} from "node:path";

/**
 * С84: a file the owner's own conversation may attach by a link — any file this account can read, except places
 * of secrets (access stores, hidden folders such as .secrets, .codex, .claude, .ssh, .config/.local, .env files,
 * login and key files). Channel-free: the channel only sends what this allows.
 */
const SECRET_NAMES=/^(\.env.*|auth\.json|credentials.*|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|.*token.*)$/i;
export function ownerMayAttach(realPath:string):{ok:true}|{ok:false;reason:string} {
  const parts=realPath.split(sep).filter(Boolean);
  if (parts.some(p=>p.startsWith("."))) return {ok:false,reason:"файл в скрытой служебной папке (там лежат настройки и входы)"};
  if (SECRET_NAMES.test(parts.at(-1) ?? "")) return {ok:false,reason:"файл похож на секрет (вход, ключ, токен)"};
  return {ok:true};
}
