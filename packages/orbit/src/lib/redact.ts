import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const REDACTED = "[redacted]";
/** Shorter values are too likely to occur by chance to be replaced safely. */
const MIN_SECRET = 8;

/** Replaces every occurrence of known secrets. */
export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Iterable<string>) {
    this.secrets = [...new Set([...secrets].filter((s) => s.length >= MIN_SECRET))].sort(
      (a, b) => b.length - a.length,
    );
  }

  get empty(): boolean {
    return this.secrets.length === 0;
  }

  /** Maximum UTF-8 byte length, for log windows read by byte offset. */
  get maxLength(): number {
    return Math.max(0, ...this.secrets.map((s) => Buffer.byteLength(s)));
  }

  apply(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(REDACTED);
    return out;
  }

  /** Redact a byte window using its surrounding context, keeping offsets in the original file. */
  applyWindow(buf: Buffer, from: number, to: number): string {
    const matches: [number, number][] = [];
    for (const secret of this.secrets) {
      const value = Buffer.from(secret);
      for (let at = buf.indexOf(value); at >= 0; at = buf.indexOf(value, at + 1))
        if (at < to && at + value.length > from) matches.push([at, at + value.length]);
    }
    matches.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let cursor = from;
    let out = "";
    for (const [start, end] of matches) {
      if (end <= cursor) continue;
      if (start >= cursor) out += buf.subarray(cursor, start).toString("utf8") + REDACTED;
      cursor = end;
    }
    return out + buf.subarray(Math.min(cursor, to), to).toString("utf8");
  }

  /**
   * A streaming redactor. It holds back the last `maxLength - 1` characters of each chunk so a secret
   * split across chunks is still caught.
   */
  stream({ final = true }: { final?: boolean } = {}): Transform {
    let carry = "";
    const keep = Math.max(0, this.maxLength - 1);
    const decoder = new StringDecoder("utf8");
    return new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        const text = this.apply(carry + decoder.write(chunk));
        const cut = Math.max(0, text.length - keep);
        carry = text.slice(cut);
        done(null, text.slice(0, cut));
      },
      flush: (done) => done(null, final ? this.apply(carry + decoder.end()) : ""),
    });
  }
}

/** `sk-…a1b2`-style hint that identifies a secret without revealing it. */
export function maskSecret(secret: string): string {
  const s = secret.trim();
  if (s.length < 12) return "…";
  const prefix = /^[A-Za-z]{2,8}[-_]/.exec(s)?.[0] ?? "";
  return `${prefix}…${s.slice(-4)}`;
}

const PATTERNS = [
  /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]{8,}@/i,
  /\b(?:[A-Za-z0-9]{1,32}[_-]){0,8}(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9_+./=-]{8,}/i,
];

export const hasSecretPattern = (text: string): boolean =>
  PATTERNS.some((pattern) => pattern.test(text));

const SENSITIVE_KEY =
  /^(?:[A-Za-z0-9]{1,32}[_-]){0,8}(?:(?:api|access|auth|refresh)[_-]?(?:key|token)|password|passwd|client[_-]?secret|private[_-]?key|token|secret)$/i;
const PLACEHOLDER = /^(?:\[redacted\]|\$\{[^}]+\}|<[^>]+>)$/i;

export const isSecretField = (key: string, value: unknown): boolean =>
  SENSITIVE_KEY.test(key) &&
  typeof value === "string" &&
  value.length >= 8 &&
  !PLACEHOLDER.test(value);
