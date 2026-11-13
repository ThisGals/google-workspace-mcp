/**
 * MIME: type lookup, and the RFC 5322 message builder.
 *
 * Two constraints worth stating, because getting either wrong is silent:
 *
 * 1. **Header injection.** A `To:` or `Subject:` carrying CR or LF splits the
 *    header block and lets a caller forge headers (Bcc, From) or inject a body.
 *    Every header value is stripped of control characters. This is not
 *    theoretical: the values come from an LLM, through a tool call.
 *
 * 2. **Inline images belong in multipart/related, not multipart/mixed.** Gmail
 *    rewrites `Content-Disposition: inline` to `attachment` when a CID part sits
 *    in a `mixed` container, so an inline image silently becomes a dangling
 *    attachment.
 */

/** Common extension → MIME type map. Falls back to application/octet-stream. */
const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.js': 'application/javascript',
  '.ts': 'text/x-typescript',
  '.py': 'text/x-python',
  '.sh': 'application/x-sh',
};

/** Look up MIME type by filename extension. */
export function lookupMimeType(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return 'application/octet-stream';
  const ext = filename.slice(dotIndex).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// --- RFC 5322 message construction ---

const CRLF = '\r\n';

/**
 * Strip CR/LF and other control characters from a header value.
 *
 * A newline in a header value ENDS THE HEADER and starts a new one. A caller who
 * gets `\r\nBcc: attacker@evil.com` into a subject has forged a Bcc. Values here
 * originate from a model's tool call, so this is a real input, not a hypothetical.
 */
function sanitizeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]/g, '');
}

// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7F]/;

/** Folding whitespace between encoded-words. Decoders drop it between adjacent words. */
const FOLD = `${CRLF} `;

/**
 * RFC 2047 caps an encoded-word at 75 characters. `=?UTF-8?B?` + `?=` is 12, which
 * leaves 63 base64 characters: 15 groups of 4, so 45 bytes of UTF-8 per word.
 */
const MAX_WORD_BYTES = 45;

/**
 * Encode text as one or more RFC 2047 encoded-words, each at most 75 characters.
 *
 * Chunks are cut on code-point boundaries, never inside a UTF-8 sequence: RFC 2047
 * requires every encoded-word to hold whole characters, and a split sequence
 * decodes to replacement characters in most clients.
 */
function toEncodedWords(text: string): string[] {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf-8');
    if (bytes + n > MAX_WORD_BYTES && chunk) {
      words.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf-8').toString('base64')}?=`);
}

/**
 * Encode an unstructured header value (Subject), per RFC 2047.
 * A bare UTF-8 subject is not legal in a header; Gmail tolerates it, other
 * receivers mangle it. Encode only when needed, so plain subjects stay readable.
 * The whole value is encoded, split into words of 75 characters or fewer.
 */
export function encodeUnstructuredHeader(value: string): string {
  const clean = sanitizeHeader(value);
  if (!NON_ASCII.test(clean)) return clean;
  return toEncodedWords(clean).join(FOLD);
}

/**
 * Split an address list on the commas that separate mailboxes.
 *
 * `"Thompson, Michelle" <m@x.com>` is ONE mailbox: commas inside a quoted string
 * (with backslash escapes honoured) or inside angle brackets don't separate.
 */
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quoted = false;
  let angle = false;
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (quoted && ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') angle = true;
    else if (!quoted && ch === '>') angle = false;
    else if (ch === ',' && !quoted && !angle) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** RFC 5322 specials: an ASCII display name containing any of these must be quoted. */
function nameNeedsQuoting(name: string): boolean {
  return /[()<>[\]:;@\\,."]/.test(name);
}

function quoteName(name: string): string {
  return `"${name.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Encode ONE mailbox, encoding only its display name.
 *
 * `"Brandhaüs" <heather@brandhaus8.com>` becomes
 * `=?UTF-8?B?QnJhbmRoYcO8cw==?= <heather@brandhaus8.com>`. The quotes go: RFC 2047
 * section 5 forbids an encoded-word inside a quoted-string, so the encoded-word
 * replaces the quoted-string instead of sitting in it.
 */
function encodeMailbox(mailbox: string): string {
  const m = /^(.*)<([^<>]*)>\s*$/.exec(mailbox);
  // A bare addr-spec has no display name, so nothing to encode.
  if (!m) return mailbox;
  const rawName = m[1].trim();
  const spec = m[2].trim();
  if (!rawName) return `<${spec}>`;
  const name = /^".*"$/.test(rawName) ? rawName.slice(1, -1).replace(/\\(.)/g, '$1') : rawName;
  if (!NON_ASCII.test(name)) {
    return `${nameNeedsQuoting(name) ? quoteName(name) : name} <${spec}>`;
  }
  return `${toEncodedWords(name).join(FOLD)} <${spec}>`;
}

/**
 * Encode an address header (From/To/Cc/Bcc) per RFC 2047.
 *
 * **Only display names may be encoded; every address stays literal ASCII.**
 * Encoding the whole value as one word hides the addr-spec inside base64, Gmail
 * finds no address and rejects the message with "Invalid To header". This is the
 * same rule In-Reply-To and References follow below.
 */
export function encodeAddressHeader(value: string): string {
  return splitAddressList(sanitizeHeader(value)).map(encodeMailbox).join(', ');
}

/** Wrap base64 at 76 chars, as RFC 2045 requires. */
function wrapBase64(data: Buffer): string {
  return data.toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
}

/**
 * A boundary that cannot collide with the content it delimits.
 *
 * If a boundary string happens to occur inside an attachment's base64 (or inside
 * a body), the message silently truncates at that point. Random suffix, and the
 * marker is not something base64 can produce (it contains `=` only at the end and
 * `_`), so a collision would have to be deliberate.
 */
function makeBoundary(tag: string): string {
  return `----gwsmcp_${tag}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export interface MimeAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
  /** Present for inline images. Forces a multipart/related container — see the header note. */
  contentId?: string;
}

export interface MimeMessage {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  html?: boolean;
  attachments?: MimeAttachment[];
  /** Threading (reply/forward). */
  inReplyTo?: string;
  references?: string;
}

/**
 * Build an RFC 5322 message, base64url-encoded for Gmail's `raw` field or for a
 * `message/rfc822` media upload.
 *
 * Structure is chosen by content, not by habit:
 *   body only                  -> text/plain or text/html
 *   body + inline images       -> multipart/related   (NOT mixed — Gmail rewrites inline->attachment in mixed)
 *   body + attachments         -> multipart/mixed
 *   body + inline + attachments-> multipart/mixed [ multipart/related [ body, inline… ], attachments… ]
 */
export function buildMimeMessage(msg: MimeMessage): Buffer {
  const headers: string[] = [];
  // Address headers encode per mailbox (display name only); Subject is
  // unstructured text, where encoding the whole value is correct.
  const addAddress = (name: string, value?: string) => {
    if (value) headers.push(`${name}: ${encodeAddressHeader(value)}`);
  };

  addAddress('From', msg.from);
  addAddress('To', msg.to);
  addAddress('Cc', msg.cc);
  addAddress('Bcc', msg.bcc);
  if (msg.subject) headers.push(`Subject: ${encodeUnstructuredHeader(msg.subject)}`);
  // Message-ID / References must NOT be RFC-2047 encoded — they are addr-spec
  // tokens, not display text. Sanitize only.
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${sanitizeHeader(msg.inReplyTo)}`);
  if (msg.references) headers.push(`References: ${sanitizeHeader(msg.references)}`);
  headers.push('MIME-Version: 1.0');

  const bodyType = msg.html ? 'text/html' : 'text/plain';
  const bodyPart = (): string =>
    `Content-Type: ${bodyType}; charset="UTF-8"${CRLF}` +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrapBase64(Buffer.from(msg.body, 'utf-8'));

  const attachmentPart = (a: MimeAttachment): string =>
    `Content-Type: ${a.contentType}; name="${sanitizeHeader(a.filename)}"${CRLF}` +
    (a.contentId
      ? `Content-Disposition: inline; filename="${sanitizeHeader(a.filename)}"${CRLF}` +
        `Content-ID: <${sanitizeHeader(a.contentId)}>${CRLF}`
      : `Content-Disposition: attachment; filename="${sanitizeHeader(a.filename)}"${CRLF}`) +
    `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
    wrapBase64(a.data);

  const all = msg.attachments ?? [];
  const inline = all.filter((a) => a.contentId);
  const files = all.filter((a) => !a.contentId);

  let content: string;

  if (all.length === 0) {
    headers.push(`Content-Type: ${bodyType}; charset="UTF-8"`);
    headers.push('Content-Transfer-Encoding: base64');
    content = wrapBase64(Buffer.from(msg.body, 'utf-8'));
  } else {
    // The body, possibly wrapped with its inline images in a `related` container.
    let bodyBlock: string;
    if (inline.length > 0) {
      const rel = makeBoundary('rel');
      bodyBlock =
        `Content-Type: multipart/related; boundary="${rel}"${CRLF}${CRLF}` +
        `--${rel}${CRLF}${bodyPart()}${CRLF}` +
        inline.map((a) => `--${rel}${CRLF}${attachmentPart(a)}${CRLF}`).join('') +
        `--${rel}--`;
    } else {
      bodyBlock = bodyPart();
    }

    if (files.length === 0) {
      // Inline images only: the related container IS the message.
      const rel = makeBoundary('rel');
      headers.push(`Content-Type: multipart/related; boundary="${rel}"`);
      content =
        `--${rel}${CRLF}${bodyPart()}${CRLF}` +
        inline.map((a) => `--${rel}${CRLF}${attachmentPart(a)}${CRLF}`).join('') +
        `--${rel}--`;
    } else {
      const mixed = makeBoundary('mix');
      headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
      content =
        `--${mixed}${CRLF}${bodyBlock}${CRLF}` +
        files.map((a) => `--${mixed}${CRLF}${attachmentPart(a)}${CRLF}`).join('') +
        `--${mixed}--`;
    }
  }

  return Buffer.from(headers.join(CRLF) + CRLF + CRLF + content + CRLF, 'utf-8');
}

/** Gmail's `raw` field wants base64url with no padding. */
export function toRawField(message: Buffer): string {
  return message.toString('base64url');
}
