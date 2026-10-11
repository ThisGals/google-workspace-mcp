/**
 * Slides patch: every manage_slides operation is a custom handler.
 *
 * Slides is almost entirely ONE Google method, `presentations.batchUpdate`, whose body is
 * a list of typed requests (createSlide, insertText, replaceAllText, createShape, ...).
 * There is no per-operation method for a manifest entry to point a bare resource op at, so
 * each operation here composes the requests it needs. The manifest still names the method
 * each one ends in, because the account-access policy reads it to decide whether a
 * read-only account may run it.
 *
 * Three habits run through the file, each there because the alternative fails quietly:
 *
 *  - IDs are chosen HERE, not by Google. A createShape that lets Google pick the objectId
 *    cannot be followed by an insertText into it in the same batch, which would make every
 *    "add a text box with this text" two round trips and a half-finished state in between.
 *    Slides accepts a caller-supplied objectId on every create request.
 *
 *  - Text is replaced by inspecting first. deleteText over an empty shape is not a request
 *    this code can promise Google accepts, so setText and setNotes read the current text
 *    and only delete when there is something to delete.
 *
 *  - A step that fails AFTER an earlier one already changed the deck says so in the
 *    response (addSlide), rather than throwing and leaving the caller to guess whether the
 *    slide exists.
 */

import { randomBytes } from 'node:crypto';

import { call } from '../../google/client.js';
import { optionalString, requireString } from '../../server/handlers/validate.js';
import { buildImageBlock } from '../../executor/file-output.js';
import type { ServicePatch } from '../../factory/types.js';
import type { HandlerResponse } from '../../server/formatting/markdown.js';

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The built-in layouts Google accepts, minus PREDEFINED_LAYOUT_UNSPECIFIED. */
export const PREDEFINED_LAYOUTS = [
  'BLANK', 'CAPTION_ONLY', 'TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS', 'TITLE_ONLY',
  'SECTION_HEADER', 'SECTION_TITLE_AND_DESCRIPTION', 'ONE_COLUMN_TEXT', 'MAIN_POINT', 'BIG_NUMBER',
] as const;

const THUMBNAIL_SIZES = ['SMALL', 'MEDIUM', 'LARGE'] as const;

/** A table can be large; show this many rows and say how many were left out. */
const MAX_TABLE_ROWS = 30;

/** Raw batchUpdate replies are echoed up to this many characters, with a notice past it. */
const MAX_REPLY_CHARS = 6000;

// --- small helpers ---------------------------------------------------------------------

/** A number the caller may omit. A value that is present but not a number is an error. */
function optionalNumber(params: Json, field: string): number | undefined {
  const v = params[field];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${field} must be a number`);
  return n;
}

/**
 * Text the caller may omit, NOT trimmed. Slide text carries meaningful newlines and
 * indentation; optionalString's trim would eat them. Whitespace-only counts as absent.
 */
function optionalText(params: Json, field: string): string | undefined {
  const v = params[field];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** A string the caller must supply but may leave EMPTY (clearing a shape is a real request). */
function requireTextAllowEmpty(params: Json, field: string): string {
  const v = params[field];
  if (typeof v !== 'string') throw new Error(`${field} is required`);
  return v;
}

/**
 * An object ID for something we are about to create. Slides requires 5 to 50 characters,
 * starting with a word character, so a short prefix plus 12 hex digits always qualifies.
 */
function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

const points = (magnitude: number): Json => ({ magnitude, unit: 'PT' });

export const presentationUrl = (id: string): string => `https://docs.google.com/presentation/d/${id}/edit`;

async function readPresentation(presentationId: string, account: string): Promise<Json> {
  return asObj(await call('slides', 'presentations.get', { presentationId }, { account }));
}

async function batch(presentationId: string, requests: unknown[], account: string): Promise<Json> {
  return asObj(await call('slides', 'presentations.batchUpdate', { presentationId, requests }, { account }));
}

/** Depth-first over page elements, descending into groups. */
function* walk(elements: unknown): Generator<Json> {
  for (const e of asArr(elements)) {
    const el = asObj(e);
    yield el;
    yield* walk(asObj(el.elementGroup).children);
  }
}

/** The text of a shape, without the paragraph terminator Slides always appends. */
function shapeText(shape: unknown): string {
  const runs = asArr(asObj(asObj(shape).text).textElements).map((e) => {
    const el = asObj(e);
    const run = asObj(el.textRun);
    if (typeof run.content === 'string') return run.content;
    const auto = asObj(el.autoText);
    return typeof auto.content === 'string' ? auto.content : '';
  });
  const text = runs.join('');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function kindOf(el: Json): string {
  for (const k of ['shape', 'image', 'video', 'line', 'table', 'wordArt', 'sheetsChart', 'elementGroup', 'speakerSpotlight']) {
    if (el[k]) return k;
  }
  return 'unknown';
}

/** A slide's speaker-notes shape id, or undefined if the slide has none. */
function notesShapeId(slide: Json): string | undefined {
  const id = asObj(asObj(asObj(slide.slideProperties).notesPage).notesProperties).speakerNotesObjectId;
  return typeof id === 'string' && id ? id : undefined;
}

function notesText(slide: Json): string {
  const id = notesShapeId(slide);
  if (!id) return '';
  for (const el of walk(asObj(asObj(slide.slideProperties).notesPage).pageElements)) {
    if (el.objectId === id) return shapeText(el.shape);
  }
  return '';
}

/** Find a shape by id on any slide or in any slide's speaker notes. */
function findShape(pres: Json, objectId: string): Json | undefined {
  for (const s of asArr(pres.slides)) {
    const slide = asObj(s);
    for (const el of walk(slide.pageElements)) if (el.objectId === objectId) return el;
    for (const el of walk(asObj(asObj(slide.slideProperties).notesPage).pageElements)) {
      if (el.objectId === objectId) return el;
    }
  }
  return undefined;
}

function pageSizeText(pres: Json): string | undefined {
  const size = asObj(pres.pageSize);
  const w = asObj(size.width);
  const h = asObj(size.height);
  if (typeof w.magnitude !== 'number' || typeof h.magnitude !== 'number') return undefined;
  // Slides reports EMU (914400 per inch, 12700 per point). Points are what x/y/width/height take.
  const toPt = (m: number, unit: unknown): number => (unit === 'EMU' ? m / 12700 : m);
  return `${Math.round(toPt(w.magnitude, w.unit))} x ${Math.round(toPt(h.magnitude, h.unit))} pt`;
}

// --- rendering the outline ------------------------------------------------------------

function cellText(cell: unknown): string {
  return shapeText(asObj(cell)).replace(/\n/g, ' / ');
}

function describeElement(el: Json, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const id = String(el.objectId ?? '?');
  const kind = kindOf(el);

  switch (kind) {
    case 'shape': {
      const shape = asObj(el.shape);
      const placeholder = asObj(shape.placeholder);
      const label = placeholder.type ? `PLACEHOLDER ${String(placeholder.type)}` : String(shape.shapeType ?? 'SHAPE');
      const text = shapeText(shape);
      return [`${pad}- \`${id}\` ${label}${text ? `: ${JSON.stringify(text)}` : ''}`];
    }
    case 'image': {
      const src = asObj(el.image).sourceUrl;
      return [`${pad}- \`${id}\` IMAGE${typeof src === 'string' ? ` (source: ${src})` : ''}`];
    }
    case 'video': {
      const url = asObj(el.video).url;
      return [`${pad}- \`${id}\` VIDEO${typeof url === 'string' ? ` ${url}` : ''}`];
    }
    case 'table': {
      const table = asObj(el.table);
      const rows = asArr(table.tableRows);
      const lines = [`${pad}- \`${id}\` TABLE ${rows.length} rows x ${String(table.columns ?? '?')} columns`];
      for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
        lines.push(`${pad}  | ${asArr(asObj(row).tableCells).map((c) => cellText(c)).join(' | ')} |`);
      }
      if (rows.length > MAX_TABLE_ROWS) lines.push(`${pad}  (${rows.length - MAX_TABLE_ROWS} more rows not shown)`);
      return lines;
    }
    case 'wordArt': {
      const text = asObj(el.wordArt).renderedText;
      return [`${pad}- \`${id}\` WORD_ART${typeof text === 'string' ? `: ${JSON.stringify(text)}` : ''}`];
    }
    case 'elementGroup': {
      const children = asArr(asObj(el.elementGroup).children);
      return [
        `${pad}- \`${id}\` GROUP of ${children.length}`,
        ...children.flatMap((c) => describeElement(asObj(c), depth + 1)),
      ];
    }
    default:
      return [`${pad}- \`${id}\` ${kind.toUpperCase()}`];
  }
}

function layoutNames(pres: Json): Map<string, string> {
  const names = new Map<string, string>();
  for (const l of asArr(pres.layouts)) {
    const layout = asObj(l);
    const props = asObj(layout.layoutProperties);
    const name = props.displayName ?? props.name;
    if (typeof layout.objectId === 'string' && typeof name === 'string') names.set(layout.objectId, name);
  }
  return names;
}

// --- choosing the slide an operation acts on -------------------------------------------

/**
 * pageObjectId wins; otherwise slideNumber (counting from 1) is looked up. A slideNumber
 * costs one read of the deck, asking Google for slide ids only.
 */
async function resolveSlideId(params: Json, account: string): Promise<string> {
  const given = optionalString(params, 'pageObjectId');
  if (given) return given;

  const n = optionalNumber(params, 'slideNumber');
  if (n === undefined) {
    throw new Error('Name the slide: pass pageObjectId (as `get` prints it) or slideNumber (counting from 1).');
  }
  if (!Number.isInteger(n) || n < 1) throw new Error('slideNumber counts from 1 and must be a whole number.');

  const presentationId = requireString(params, 'presentationId');
  const pres = asObj(await call('slides', 'presentations.get',
    { presentationId, fields: 'slides(objectId)' }, { account }));
  const slides = asArr(pres.slides);
  if (n > slides.length) {
    throw new Error(`The deck has ${slides.length} slide(s), so slide ${n} does not exist.`);
  }
  return String(asObj(slides[n - 1]).objectId);
}

// --- replacing text -------------------------------------------------------------------

/**
 * The requests that make a shape's text exactly `text`. deleteText is included only when
 * there is existing text to delete, and insertText only when there is new text to insert.
 */
function replaceTextRequests(objectId: string, existing: string, text: string): unknown[] {
  const requests: unknown[] = [];
  if (existing.length > 0) requests.push({ deleteText: { objectId, textRange: { type: 'ALL' } } });
  if (text.length > 0) requests.push({ insertText: { objectId, insertionIndex: 0, text } });
  return requests;
}

// --- the patch ------------------------------------------------------------------------

export const slidesPatch: ServicePatch = {
  customHandlers: {
    get: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const pres = await readPresentation(presentationId, account);

      const title = typeof pres.title === 'string' ? pres.title : '(untitled)';
      const slides = asArr(pres.slides).map(asObj);
      const names = layoutNames(pres);

      const wantId = optionalString(params, 'pageObjectId');
      const wantNumber = optionalNumber(params, 'slideNumber');

      // A slide that is named but does not exist must fail loudly. Falling back to the whole
      // deck would hand back far more than was asked for and let the caller believe it was
      // the one slide they named.
      let selected = slides.map((slide, i) => ({ slide, number: i + 1 }));
      if (wantId) {
        selected = selected.filter((s) => s.slide.objectId === wantId);
        if (selected.length === 0) {
          throw new Error(
            `No slide with objectId "${wantId}". Slide ids in this deck: ` +
            `${slides.map((s) => String(s.objectId)).join(', ') || '(none)'}.`,
          );
        }
      } else if (wantNumber !== undefined) {
        if (!Number.isInteger(wantNumber) || wantNumber < 1 || wantNumber > slides.length) {
          throw new Error(`slideNumber must be a whole number from 1 to ${slides.length}.`);
        }
        selected = [selected[wantNumber - 1]];
      }
      const scoped = selected.length !== slides.length;

      const out: string[] = [
        `## ${title}`,
        '',
        `**Presentation ID:** ${presentationId}`,
        `**URL:** ${presentationUrl(presentationId)}`,
        `**Slides:** ${slides.length}`,
      ];
      const size = pageSizeText(pres);
      if (size) out.push(`**Slide size:** ${size}`);

      // Layout ids are what addSlide's layoutId takes, so list them (whole-deck reads only).
      if (!scoped && names.size > 0) {
        out.push(`**Layouts:** ${[...names].map(([id, name]) => `${name} (\`${id}\`)`).join(', ')}`);
      }

      for (const { slide, number } of selected) {
        const layoutId = asObj(slide.slideProperties).layoutObjectId;
        const layout = typeof layoutId === 'string' ? names.get(layoutId) : undefined;
        out.push('', `### Slide ${number} (id: \`${String(slide.objectId)}\`${layout ? `, layout: ${layout}` : ''})`);

        const lines = asArr(slide.pageElements).flatMap((e) => describeElement(asObj(e), 0));
        out.push(...(lines.length > 0 ? lines : ['_(no elements)_']));

        const notes = notesText(slide);
        if (notes) out.push('', `Speaker notes: ${JSON.stringify(notes)}`);
      }

      return {
        text: out.join('\n') + '\n',
        refs: {
          presentationId,
          title,
          slideCount: slides.length,
          slides: selected.map(({ slide, number }) => ({ number, objectId: slide.objectId })),
        },
      };
    },

    create: async (params, account): Promise<HandlerResponse> => {
      const title = optionalString(params, 'title') ?? 'Untitled presentation';

      const pres = asObj(await call('slides', 'presentations.create', { title }, { account }));
      const presentationId = String(pres.presentationId ?? '');
      const first = asObj(asArr(pres.slides)[0]);

      return {
        text:
          `Created presentation: **${title}**\n\n` +
          `**Presentation ID:** ${presentationId}\n` +
          `**URL:** ${presentationUrl(presentationId)}\n` +
          (first.objectId ? `**First slide:** \`${String(first.objectId)}\` (new decks start with one slide)\n` : ''),
        refs: { presentationId, title, firstSlideId: first.objectId, url: presentationUrl(presentationId) },
      };
    },

    viewSlide: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const pageObjectId = await resolveSlideId(params, account);
      const size = optionalString(params, 'size') ?? 'MEDIUM';
      if (!(THUMBNAIL_SIZES as readonly string[]).includes(size)) {
        throw new Error(`size must be one of: ${THUMBNAIL_SIZES.join(', ')}.`);
      }

      const thumb = asObj(await call('slides', 'presentations.pages.getThumbnail', {
        presentationId,
        pageObjectId,
        'thumbnailProperties.mimeType': 'PNG',
        'thumbnailProperties.thumbnailSize': size,
      }, { account }));

      if (typeof thumb.contentUrl !== 'string' || !thumb.contentUrl) {
        throw new Error('Google returned no image for that slide.');
      }

      // contentUrl is a short-lived signed URL (about 30 minutes). It needs no auth header.
      const res = await fetch(thumb.contentUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Could not download the slide image (HTTP ${res.status}).`);
      const buffer = Buffer.from(await res.arrayBuffer());

      const header = `## Slide \`${pageObjectId}\`\n\n**Size:** ${String(thumb.width ?? '?')} x ${String(thumb.height ?? '?')} px (${size})\n`;
      const block = buildImageBlock(buffer, 'slide.png', 'image/png');
      if (!block) {
        return {
          text: header + `\nThe image is ${(buffer.length / 1e6).toFixed(1)} MB, too large to show inline. Ask for size SMALL or MEDIUM.`,
          refs: { presentationId, pageObjectId, size },
        };
      }
      return {
        text: header + '\n_Image displayed inline below._',
        refs: { presentationId, pageObjectId, size, width: thumb.width, height: thumb.height },
        content: [block],
      };
    },

    addSlide: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const layoutId = optionalString(params, 'layoutId');
      const layout = optionalString(params, 'layout') ?? 'TITLE_AND_BODY';
      if (!layoutId && !(PREDEFINED_LAYOUTS as readonly string[]).includes(layout)) {
        throw new Error(`Unknown layout "${layout}". Use one of: ${PREDEFINED_LAYOUTS.join(', ')}.`);
      }
      const insertionIndex = optionalNumber(params, 'insertionIndex');
      if (insertionIndex !== undefined && (!Number.isInteger(insertionIndex) || insertionIndex < 0)) {
        throw new Error('insertionIndex counts from 0 and must be a whole number.');
      }
      const title = optionalText(params, 'title');
      const body = optionalText(params, 'body');

      const slideId = newId('slide');
      await batch(presentationId, [{
        createSlide: {
          objectId: slideId,
          ...(insertionIndex !== undefined ? { insertionIndex } : {}),
          slideLayoutReference: layoutId ? { layoutId } : { predefinedLayout: layout },
        },
      }], account);

      // Everything below runs AFTER the slide exists. A failure from here on is reported in
      // the response, not thrown: throwing would tell the caller "nothing happened" while
      // an empty slide sits in their deck.
      const notes: string[] = [];
      const placeholders: Array<{ id: string; type: string; filled: boolean }> = [];
      try {
        const page = asObj(await call('slides', 'presentations.pages.get',
          { presentationId, pageObjectId: slideId }, { account }));

        for (const el of walk(page.pageElements)) {
          const type = asObj(asObj(el.shape).placeholder).type;
          if (typeof type === 'string' && typeof el.objectId === 'string') {
            placeholders.push({ id: el.objectId, type, filled: false });
          }
        }

        const targets: Array<{ want: string | undefined; types: string[]; label: string }> = [
          { want: title, types: ['TITLE', 'CENTERED_TITLE'], label: 'title' },
          { want: body, types: ['BODY', 'SUBTITLE'], label: 'body' },
        ];
        const inserts: unknown[] = [];
        for (const { want, types, label } of targets) {
          if (!want) continue;
          const slot = placeholders.find((p) => types.includes(p.type));
          if (!slot) {
            notes.push(`This layout has no ${label} placeholder, so the ${label} text was not placed. Use \`addTextBox\` to put it on the slide.`);
            continue;
          }
          inserts.push({ insertText: { objectId: slot.id, insertionIndex: 0, text: want } });
          slot.filled = true;
        }
        if (inserts.length > 0) await batch(presentationId, inserts, account);
      } catch (err) {
        // Whatever we marked as filled before the failure was not necessarily written.
        for (const p of placeholders) p.filled = false;
        notes.push(`The slide was created, but filling it failed: ${(err as Error).message}`);
      }

      const where = insertionIndex !== undefined ? `at position ${insertionIndex + 1}` : 'at the end of the deck';
      const lines = [
        `Added a slide ${where}, layout ${layoutId ? `\`${layoutId}\`` : layout}.`,
        '',
        `**Slide ID:** \`${slideId}\``,
      ];
      if (placeholders.length > 0) {
        lines.push('**Placeholders:** ' + placeholders.map((p) => `\`${p.id}\` ${p.type}${p.filled ? ' (filled)' : ''}`).join(', '));
      }
      for (const n of notes) lines.push('', `> ${n}`);

      return {
        text: lines.join('\n') + '\n',
        refs: { presentationId, slideId, pageObjectId: slideId, placeholders },
      };
    },

    setText: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const objectId = requireString(params, 'objectId');
      const text = requireTextAllowEmpty(params, 'text');

      const pres = await readPresentation(presentationId, account);
      const el = findShape(pres, objectId);
      if (!el) {
        throw new Error(`No element with objectId "${objectId}" in this presentation. Run \`get\` to list the ids.`);
      }
      if (kindOf(el) !== 'shape') {
        throw new Error(`"${objectId}" is a ${kindOf(el).toUpperCase()}, not a shape or text box, so it has no text to set.`);
      }

      const existing = shapeText(el.shape);
      const requests = replaceTextRequests(objectId, existing, text);
      if (requests.length === 0) {
        return { text: `\`${objectId}\` was already empty; nothing to change.\n`, refs: { presentationId, objectId, changed: false } };
      }
      await batch(presentationId, requests, account);

      return {
        text: text.length > 0
          ? `Set the text of \`${objectId}\` (${existing.length} characters replaced by ${text.length}).\n`
          : `Cleared the text of \`${objectId}\` (${existing.length} characters removed).\n`,
        refs: { presentationId, objectId, changed: true, characters: text.length },
      };
    },

    replaceText: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const findText = requireString(params, 'findText');
      const replaceWith = requireTextAllowEmpty(params, 'replaceWith');
      const matchCase = params.matchCase !== false;
      const pageObjectIds = (optionalString(params, 'pageObjectIds') ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      const res = await batch(presentationId, [{
        replaceAllText: {
          containsText: { text: findText, matchCase },
          replaceText: replaceWith,
          ...(pageObjectIds.length > 0 ? { pageObjectIds } : {}),
        },
      }], account);

      const changed = Number(asObj(asObj(asArr(res.replies)[0]).replaceAllText).occurrencesChanged ?? 0);
      return {
        text: changed > 0
          ? `Replaced ${changed} occurrence(s) of ${JSON.stringify(findText)}${pageObjectIds.length ? ` on ${pageObjectIds.length} slide(s)` : ' across the deck'}.\n`
          : `No occurrences of ${JSON.stringify(findText)} found${matchCase ? ' (case-sensitive)' : ''}; nothing changed.\n`,
        refs: { presentationId, occurrencesChanged: changed },
      };
    },

    addTextBox: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const text = requireTextAllowEmpty(params, 'text');
      if (text.length === 0) throw new Error('text is required');
      const pageObjectId = await resolveSlideId(params, account);

      const x = optionalNumber(params, 'x') ?? 50;
      const y = optionalNumber(params, 'y') ?? 50;
      const width = optionalNumber(params, 'width') ?? 400;
      const height = optionalNumber(params, 'height') ?? 100;
      const fontSize = optionalNumber(params, 'fontSize');
      if (width <= 0 || height <= 0) throw new Error('width and height must be greater than 0.');
      if (fontSize !== undefined && fontSize <= 0) throw new Error('fontSize must be greater than 0.');

      const objectId = newId('textbox');
      await batch(presentationId, [
        {
          createShape: {
            objectId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId,
              size: { width: points(width), height: points(height) },
              transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'PT' },
            },
          },
        },
        { insertText: { objectId, insertionIndex: 0, text } },
        ...(fontSize !== undefined
          ? [{ updateTextStyle: { objectId, textRange: { type: 'ALL' }, style: { fontSize: points(fontSize) }, fields: 'fontSize' } }]
          : []),
      ], account);

      return {
        text: `Added a text box \`${objectId}\` to slide \`${pageObjectId}\` at (${x}, ${y}) pt, ${width} x ${height} pt.\n`,
        refs: { presentationId, objectId, pageObjectId },
      };
    },

    addImage: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const imageUrl = requireString(params, 'imageUrl').trim();
      if (!/^https?:\/\//i.test(imageUrl)) throw new Error('imageUrl must be a public http(s) URL.');
      const pageObjectId = await resolveSlideId(params, account);

      const x = optionalNumber(params, 'x');
      const y = optionalNumber(params, 'y');
      const width = optionalNumber(params, 'width');
      const height = optionalNumber(params, 'height');
      if ((width === undefined) !== (height === undefined)) {
        throw new Error('Give both width and height to size the image, or neither to let Google fit it.');
      }
      if ((width !== undefined && width <= 0) || (height !== undefined && height <= 0)) {
        throw new Error('width and height must be greater than 0.');
      }

      const objectId = newId('image');
      await batch(presentationId, [{
        createImage: {
          objectId,
          url: imageUrl,
          elementProperties: {
            pageObjectId,
            ...(width !== undefined && height !== undefined ? { size: { width: points(width), height: points(height) } } : {}),
            ...(x !== undefined || y !== undefined
              ? { transform: { scaleX: 1, scaleY: 1, translateX: x ?? 0, translateY: y ?? 0, unit: 'PT' } }
              : {}),
          },
        },
      }], account);

      return {
        text: `Added image \`${objectId}\` to slide \`${pageObjectId}\`.\n`,
        refs: { presentationId, objectId, pageObjectId },
      };
    },

    setNotes: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const text = requireTextAllowEmpty(params, 'text');
      const pageObjectId = await resolveSlideId(params, account);

      const pres = await readPresentation(presentationId, account);
      const slide = asArr(pres.slides).map(asObj).find((s) => s.objectId === pageObjectId);
      if (!slide) {
        throw new Error(`No slide with objectId "${pageObjectId}". Run \`get\` to list the slide ids.`);
      }
      const notesId = notesShapeId(slide);
      if (!notesId) throw new Error(`Slide "${pageObjectId}" has no speaker notes shape to write to.`);

      const existing = notesText(slide);
      const requests = replaceTextRequests(notesId, existing, text);
      if (requests.length === 0) {
        return { text: `Slide \`${pageObjectId}\` had no speaker notes; nothing to change.\n`, refs: { presentationId, pageObjectId, changed: false } };
      }
      await batch(presentationId, requests, account);

      return {
        text: text.length > 0
          ? `Set the speaker notes on slide \`${pageObjectId}\`${existing ? ' (replacing the existing notes)' : ''}.\n`
          : `Cleared the speaker notes on slide \`${pageObjectId}\`.\n`,
        refs: { presentationId, pageObjectId, changed: true },
      };
    },

    batchUpdate: async (params, account): Promise<HandlerResponse> => {
      const presentationId = requireString(params, 'presentationId');
      const raw = requireString(params, 'requests');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`requests must be valid JSON: ${(err as Error).message}`);
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('requests must be a non-empty JSON array of Slides requests.');
      }
      // Each entry is one typed request: an object with exactly one key naming the request.
      parsed.forEach((r, i) => {
        const keys = r && typeof r === 'object' && !Array.isArray(r) ? Object.keys(r as Json) : [];
        if (keys.length !== 1) {
          throw new Error(`requests[${i}] must be an object with exactly one key naming the request, e.g. {"deleteObject": {...}}.`);
        }
      });

      const res = await batch(presentationId, parsed, account);
      const replies = JSON.stringify(res.replies ?? [], null, 2);
      const shown = replies.length > MAX_REPLY_CHARS
        ? replies.slice(0, MAX_REPLY_CHARS) + `\n... (${replies.length - MAX_REPLY_CHARS} more characters; the full replies are in refs)`
        : replies;

      return {
        text: `Applied ${parsed.length} request(s).\n\n**Replies:**\n\n\`\`\`json\n${shown}\n\`\`\`\n`,
        refs: { presentationId, requestCount: parsed.length, replies: res.replies ?? [] },
      };
    },
  },
};
