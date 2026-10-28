import { object } from "./tokens/values";
import { ZcodeSessions, type ZcodeSessionOptions } from "./zcode-session";

/** Pure provider id decoding. Reading ZCode's bridge map belongs to the owning service's TokenSessions. */
export function tokenSessionId(provider: unknown, persistence: unknown): string | null {
  const record = object(persistence);
  if (typeof record.sessionId !== "string") return null;
  const id = record.sessionId.trim();
  if (provider !== "zcode" || !id.startsWith("plugin:")) return id.slice(0, 256) || null;
  if (id.length > 8192) return null;
  try {
    const envelope = object(JSON.parse(id.slice(7))), session = envelope.version === 1 ? object(envelope.data).sessionId : null;
    return typeof session === "string" && session.trim().length > 0 && session.length <= 256 ? session.trim() : null;
  } catch { return null; }
}

export class TokenSessions {
  private readonly zcode: ZcodeSessions;
  constructor(options: ZcodeSessionOptions = {}) { this.zcode = new ZcodeSessions(options); }
  async resolve(provider: unknown, persistence: unknown): Promise<string | null> {
    const id = tokenSessionId(provider, persistence);
    return provider === "zcode" && id ? this.zcode.resolve(id) : id;
  }
}
