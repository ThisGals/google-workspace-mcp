import { describe, expect, it } from 'vitest';
import {
  buildMimeMessage,
  encodeAddressHeader,
  encodeUnstructuredHeader,
  lookupMimeType,
} from '../../../services/gmail/mime.js';

describe('lookupMimeType', () => {
  it('returns correct MIME type for known extensions', () => {
    expect(lookupMimeType('report.pdf')).toBe('application/pdf');
    expect(lookupMimeType('invoice.md')).toBe('text/markdown');
    expect(lookupMimeType('photo.jpg')).toBe('image/jpeg');
    expect(lookupMimeType('data.csv')).toBe('text/csv');
    expect(lookupMimeType('archive.zip')).toBe('application/zip');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(lookupMimeType('file.xyz')).toBe('application/octet-stream');
    expect(lookupMimeType('noext')).toBe('application/octet-stream');
  });

  it('is case-insensitive for extensions', () => {
    expect(lookupMimeType('FILE.PDF')).toBe('application/pdf');
    expect(lookupMimeType('image.PNG')).toBe('image/png');
  });

  it('handles filenames without extensions', () => {
    expect(lookupMimeType('Makefile')).toBe('application/octet-stream');
    expect(lookupMimeType('README')).toBe('application/octet-stream');
  });
});

// --- helpers: an independent decoder, so the tests don't trust the encoder ---

const WORD = /=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g;

/** Every encoded-word in a header, as written. */
function encodedWords(header: string): string[] {
  return header.match(WORD) ?? [];
}

/** Unfold (RFC 5322 2.2.3), then decode encoded-words, dropping whitespace between adjacent ones. */
function decode2047(header: string): string {
  const unfolded = header.replace(/\r\n(?=[ \t])/g, '');
  return unfolded
    .replace(/(=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=)\s+(?==\?UTF-8\?B\?)/g, '$1')
    .replace(WORD, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf-8'));
}

/** Split an address header into mailboxes, respecting quotes and angle brackets. */
function parseMailboxes(header: string): Array<{ name: string; address: string }> {
  const unfolded = header.replace(/\r\n(?=[ \t])/g, '');
  const parts: string[] = [];
  let buf = '';
  let q = false;
  let a = false;
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i];
    if (q && ch === '\\') {
      buf += ch + unfolded[++i];
      continue;
    }
    if (ch === '"') q = !q;
    if (!q && ch === '<') a = true;
    if (!q && ch === '>') a = false;
    if (ch === ',' && !q && !a) {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf.trim());
  return parts.map((p) => {
    const m = /^(.*?)\s*<([^>]+)>$/.exec(p);
    if (!m) return { name: '', address: p };
    let name = m[1];
    if (/^".*"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    else name = decode2047(name);
    return { name, address: m[2] };
  });
}

/** Pull one header (with its folded continuation lines) out of a built message. */
function header(raw: Buffer, name: string): string | undefined {
  const head = raw.toString('utf-8').split('\r\n\r\n')[0];
  const m = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, 'm').exec(head);
  return m?.[1];
}

/** Every encoded-word is legal: at most 75 characters, and decodes to valid UTF-8 on its own. */
function expectWordsValid(h: string): void {
  for (const w of encodedWords(h)) {
    expect(w.length).toBeLessThanOrEqual(75);
    const b64 = w.slice('=?UTF-8?B?'.length, -2);
    const text = Buffer.from(b64, 'base64').toString('utf-8');
    expect(text).not.toContain('�');
  }
}

/** The address must sit outside every encoded-word, as plain ASCII in angle brackets. */
function expectAddressOutside(h: string, address: string): void {
  expect(h).toContain(`<${address}>`);
  for (const w of encodedWords(h)) expect(w).not.toContain(address);
  for (const w of encodedWords(h)) {
    const text = Buffer.from(w.slice(10, -2), 'base64').toString('utf-8');
    expect(text).not.toContain(address);
  }
}

describe('encodeAddressHeader — display names are encoded, addresses never', () => {
  it('"Brandhaüs" <heather@brandhaus8.com>', () => {
    const h = encodeAddressHeader('"Brandhaüs" <heather@brandhaus8.com>');
    expect(h).toBe('=?UTF-8?B?QnJhbmRoYcO8cw==?= <heather@brandhaus8.com>');
    expectAddressOutside(h, 'heather@brandhaus8.com');
    expect(parseMailboxes(h)).toEqual([{ name: 'Brandhaüs', address: 'heather@brandhaus8.com' }]);
  });

  it('an unquoted accented name', () => {
    const h = encodeAddressHeader('José Núñez <jose@example.com>');
    expectAddressOutside(h, 'jose@example.com');
    expectWordsValid(h);
    expect(parseMailboxes(h)).toEqual([{ name: 'José Núñez', address: 'jose@example.com' }]);
  });

  it('a quoted name containing a comma stays one mailbox', () => {
    const h = encodeAddressHeader('"Müller, Hans" <hans@example.de>');
    expectAddressOutside(h, 'hans@example.de');
    expect(parseMailboxes(h)).toEqual([{ name: 'Müller, Hans', address: 'hans@example.de' }]);
  });

  it('a quoted ASCII name with a comma stays quoted and readable', () => {
    const h = encodeAddressHeader('"Thompson, Michelle" <m@example.com>');
    expect(h).toBe('"Thompson, Michelle" <m@example.com>');
  });

  it('two addresses where only one has an accented name', () => {
    const h = encodeAddressHeader('Plain Name <plain@example.com>, "Brandhaüs" <heather@brandhaus8.com>');
    expect(h.startsWith('Plain Name <plain@example.com>, ')).toBe(true);
    expectAddressOutside(h, 'heather@brandhaus8.com');
    expect(parseMailboxes(h)).toEqual([
      { name: 'Plain Name', address: 'plain@example.com' },
      { name: 'Brandhaüs', address: 'heather@brandhaus8.com' },
    ]);
  });

  it('a bare address is left as it is', () => {
    expect(encodeAddressHeader('heather@brandhaus8.com')).toBe('heather@brandhaus8.com');
    expect(encodeAddressHeader('a@b.com, c@d.com')).toBe('a@b.com, c@d.com');
  });

  it('an emoji name', () => {
    const h = encodeAddressHeader('"Sunny 🌞 Days 👩‍💻" <sunny@example.com>');
    expectAddressOutside(h, 'sunny@example.com');
    expectWordsValid(h);
    expect(parseMailboxes(h)).toEqual([{ name: 'Sunny 🌞 Days 👩‍💻', address: 'sunny@example.com' }]);
  });

  it('a long name is split into several encoded-words of 75 characters or fewer', () => {
    const name = 'Ångström Ünïversïtät für Ökologische Forschung — Département Général Ééé';
    const h = encodeAddressHeader(`"${name}" <research@example.org>`);
    expect(encodedWords(h).length).toBeGreaterThan(1);
    expectWordsValid(h);
    expectAddressOutside(h, 'research@example.org');
    expect(parseMailboxes(h)).toEqual([{ name, address: 'research@example.org' }]);
  });

  it('a long name of multi-byte characters never splits a character across words', () => {
    const name = '日本語の表示名'.repeat(6) + ' 🌞🌞🌞🌞🌞';
    const h = encodeAddressHeader(`${name} <jp@example.jp>`);
    expectWordsValid(h);
    expect(parseMailboxes(h)).toEqual([{ name, address: 'jp@example.jp' }]);
  });

  it('an ASCII name with RFC 5322 specials is quoted, with quotes escaped', () => {
    expect(encodeAddressHeader('Dr. Smith <s@example.com>')).toBe('"Dr. Smith" <s@example.com>');
    expect(encodeAddressHeader('"Say \\"hi\\"" <h@example.com>')).toBe('"Say \\"hi\\"" <h@example.com>');
  });
});

describe('encodeUnstructuredHeader — Subject', () => {
  it('plain ASCII stays plain', () => {
    expect(encodeUnstructuredHeader('Invoice for February')).toBe('Invoice for February');
  });

  it('a short non-ASCII subject is one encoded-word', () => {
    const h = encodeUnstructuredHeader('Rechnung für Februar');
    expect(encodedWords(h)).toHaveLength(1);
    expect(decode2047(h)).toBe('Rechnung für Februar');
  });

  it('a long non-ASCII subject is split into valid encoded-words that decode to the original', () => {
    const subject =
      'Re: Überarbeitung der Website — neue Entwürfe für die Startseite, Öffnungszeiten und Kontaktformular 🌞';
    const h = encodeUnstructuredHeader(subject);
    expect(encodedWords(h).length).toBeGreaterThan(1);
    expectWordsValid(h);
    expect(decode2047(h)).toBe(subject);
  });
});

describe('buildMimeMessage — headers', () => {
  it('writes address headers per mailbox and the subject as encoded-words', () => {
    const raw = buildMimeMessage({
      from: 'Michelle <michelle@example.com>',
      to: '"Brandhaüs" <heather@brandhaus8.com>',
      cc: '"Müller, Hans" <hans@example.de>, plain@example.com',
      bcc: 'Zoë <zoe@example.com>',
      subject: 'Re: Brandhaüs',
      body: 'Hello',
    });
    expect(header(raw, 'From')).toBe('Michelle <michelle@example.com>');
    expect(header(raw, 'To')).toBe('=?UTF-8?B?QnJhbmRoYcO8cw==?= <heather@brandhaus8.com>');
    expect(parseMailboxes(header(raw, 'Cc')!)).toEqual([
      { name: 'Müller, Hans', address: 'hans@example.de' },
      { name: '', address: 'plain@example.com' },
    ]);
    expect(parseMailboxes(header(raw, 'Bcc')!)).toEqual([{ name: 'Zoë', address: 'zoe@example.com' }]);
    expect(decode2047(header(raw, 'Subject')!)).toBe('Re: Brandhaüs');
  });

  it('keeps every header line a header: folded lines start with whitespace', () => {
    const raw = buildMimeMessage({
      to: `"${'Ünïcödé '.repeat(12)}" <long@example.com>`,
      subject: 'Ü'.repeat(100),
      body: 'x',
    });
    const head = raw.toString('utf-8').split('\r\n\r\n')[0];
    for (const line of head.split('\r\n')) {
      expect(/^[ \t]/.test(line) || /^[A-Za-z-]+: /.test(line)).toBe(true);
    }
  });
});

describe('buildMimeMessage — header injection', () => {
  const headerNames = (raw: Buffer) =>
    raw
      .toString('utf-8')
      .split('\r\n\r\n')[0]
      .split('\r\n')
      .filter((l) => !/^[ \t]/.test(l))
      .map((l) => l.split(':')[0]);

  it('strips CRLF from the subject, so no Bcc can be forged', () => {
    const raw = buildMimeMessage({
      to: 'victim@example.com',
      subject: 'Hello\r\nBcc: attacker@evil.com',
      body: 'x',
    });
    expect(headerNames(raw)).not.toContain('Bcc');
    expect(header(raw, 'Subject')).toBe('HelloBcc: attacker@evil.com');
  });

  it('strips CRLF from an address header, including inside a display name', () => {
    const raw = buildMimeMessage({
      to: '"Brandhaüs\r\nBcc: attacker@evil.com" <heather@brandhaus8.com>',
      subject: 'Hi',
      body: 'x',
    });
    expect(headerNames(raw)).not.toContain('Bcc');
    expect(parseMailboxes(header(raw, 'To')!)[0].address).toBe('heather@brandhaus8.com');
  });

  it('strips CRLF from a non-ASCII subject before encoding', () => {
    const raw = buildMimeMessage({
      to: 'victim@example.com',
      subject: 'Grüße\r\nBcc: attacker@evil.com',
      body: 'x',
    });
    expect(headerNames(raw)).not.toContain('Bcc');
    expect(decode2047(header(raw, 'Subject')!)).toBe('GrüßeBcc: attacker@evil.com');
  });

  it('strips CRLF from In-Reply-To and References', () => {
    const raw = buildMimeMessage({
      to: 'a@example.com',
      subject: 'Hi',
      body: 'x',
      inReplyTo: '<id@x>\r\nBcc: attacker@evil.com',
      references: '<id@x>\nBcc: attacker@evil.com',
    });
    expect(headerNames(raw)).not.toContain('Bcc');
  });
});
