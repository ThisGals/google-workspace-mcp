/**
 * Tests for gmail attachment name matching. An exact name wins; otherwise a
 * single match after Unicode normalization (NFC, every Zs space to plain space,
 * collapsed, trimmed) is used. macOS screenshot names carry U+202F before
 * AM/PM, which a caller can't reliably type, so the forgiving match exists.
 */
import { describe, expect, it } from 'vitest';

import { matchAttachment, normalizeAttachmentName } from '../../../services/gmail/attachments.js';

// Built from code points so the special characters survive editors and lint.
const NNBSP = String.fromCharCode(0x202f); // narrow no-break space
const NBSP = String.fromCharCode(0x00a0); // no-break space
const THIN = String.fromCharCode(0x2009); // thin space
const ACUTE = String.fromCharCode(0x0301); // combining acute accent
const E_ACUTE = String.fromCharCode(0x00e9); // precomposed e-acute
const MSG = 'msg123';

const att = (filename: string, id = filename) => ({ filename, attachmentId: id });

describe('normalizeAttachmentName', () => {
  it('turns Unicode spaces into plain spaces, collapses runs and trims', () => {
    expect(normalizeAttachmentName(` a${NNBSP}${NBSP} b${THIN}c `)).toBe('a b c');
  });
});

describe('matchAttachment', () => {
  it('finds a U+202F name requested with a plain space', () => {
    const real = `Screenshot 2026-11-02 at 6.37.57${NNBSP}PM.png`;
    const list = [att(real), att('other.pdf')];
    expect(matchAttachment(list, 'Screenshot 2026-11-02 at 6.37.57 PM.png', MSG).filename).toBe(real);
  });

  it('finds a U+00A0 name requested with a plain space', () => {
    const real = `Q3${NBSP}report.pdf`;
    expect(matchAttachment([att(real)], 'Q3 report.pdf', MSG).filename).toBe(real);
  });

  it('finds an NFD-composed name requested as NFC', () => {
    const nfd = `Cafe${ACUTE} menu.pdf`;
    const nfc = `Caf${E_ACUTE} menu.pdf`;
    expect(nfd).not.toBe(nfc);
    expect(matchAttachment([att(nfd)], nfc, MSG).filename).toBe(nfd);
  });

  it('prefers an exact match over a normalized one', () => {
    const plain = 'shot 1 PM.png';
    const special = `shot 1${NNBSP}PM.png`;
    const list = [att(special, 'special'), att(plain, 'plain')];
    expect(matchAttachment(list, plain, MSG).attachmentId).toBe('plain');
    expect(matchAttachment(list, special, MSG).attachmentId).toBe('special');
  });

  it('refuses when two attachments normalize to the requested name', () => {
    const a = `shot${NNBSP}PM.png`;
    const b = `shot${NBSP}PM.png`;
    expect(() => matchAttachment([att(a), att(b)], 'shot PM.png', MSG))
      .toThrow(/ambiguous in message msg123: it matches 2 attachments/);
  });

  it('keeps the same not-found error for a name that matches nothing', () => {
    expect(() => matchAttachment([att('a.png'), att('b.pdf')], 'c.png', MSG))
      .toThrow("Attachment 'c.png' not found in message msg123. Available attachments: a.png, b.pdf");
    expect(() => matchAttachment([], 'c.png', MSG))
      .toThrow("Attachment 'c.png' not found in message msg123. Available attachments: (none)");
  });
});
