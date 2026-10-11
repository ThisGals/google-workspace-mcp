/**
 * Tests for the slides service patch.
 *
 * Slides is one Google method (presentations.batchUpdate) with a list of typed requests as
 * its body, so almost everything worth asserting is "which requests did we send, in what
 * order". The failure modes here are quiet ones: a deleteText over an empty shape that
 * Google rejects, a slide that exists but is empty because a later step threw, a slide
 * number that silently falls back to the whole deck.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../google/client.js');
import { mockCall } from '../server/handlers/__mocks__/client.js';
import { queryOf, requestFor } from '../support/request.js';
import { slidesPatch } from '../../services/slides/patch.js';

const ACCOUNT = 'user@test.com';
const h = slidesPatch.customHandlers!;

/** The requests array of the Nth presentations.batchUpdate call. */
function batchRequests(n = 0): Array<Record<string, unknown>> {
  const calls = mockCall.mock.calls.filter((c) => c[1] === 'presentations.batchUpdate');
  return (calls[n][2] as { requests: Array<Record<string, unknown>> }).requests;
}
const batchCount = (): number => mockCall.mock.calls.filter((c) => c[1] === 'presentations.batchUpdate').length;

const shapeEl = (objectId: string, text: string, placeholderType?: string): Record<string, unknown> => ({
  objectId,
  shape: {
    shapeType: 'TEXT_BOX',
    ...(placeholderType ? { placeholder: { type: placeholderType } } : {}),
    text: text ? { textElements: [{ textRun: { content: text + '\n' } }] } : { textElements: [{ paragraphMarker: {} }] },
  },
});

function deck(): Record<string, unknown> {
  return {
    presentationId: 'pres-1',
    title: 'Client deck',
    pageSize: { width: { magnitude: 9144000, unit: 'EMU' }, height: { magnitude: 5143500, unit: 'EMU' } },
    layouts: [{ objectId: 'lay-1', layoutProperties: { displayName: 'Title and body' } }],
    slides: [
      {
        objectId: 'slide-a',
        slideProperties: {
          layoutObjectId: 'lay-1',
          notesPage: {
            notesProperties: { speakerNotesObjectId: 'notes-a' },
            pageElements: [shapeEl('notes-a', 'Say hello')],
          },
        },
        pageElements: [
          shapeEl('title-a', 'Welcome', 'TITLE'),
          shapeEl('empty-a', ''),
          { objectId: 'img-a', image: { sourceUrl: 'https://example.com/a.png' } },
          { objectId: 'tbl-a', table: { columns: 2, tableRows: [
            { tableCells: [{ text: { textElements: [{ textRun: { content: 'A\n' } }] } }, { text: { textElements: [{ textRun: { content: 'B\n' } }] } }] },
          ] } },
        ],
      },
      {
        objectId: 'slide-b',
        slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: 'notes-b' }, pageElements: [shapeEl('notes-b', '')] } },
        pageElements: [shapeEl('body-b', 'Second slide')],
      },
    ],
  };
}

beforeEach(() => {
  mockCall.mockReset();
});

describe('slidesPatch.get', () => {
  it('prints an outline with ids, text, notes, layouts and size in points', async () => {
    mockCall.mockResolvedValue(deck());
    const { text } = await h.get({ presentationId: 'pres-1' }, ACCOUNT);

    expect(text).toContain('## Client deck');
    expect(text).toContain('**Slides:** 2');
    expect(text).toContain('720 x 405 pt');
    expect(text).toContain('Title and body (`lay-1`)');
    expect(text).toContain('### Slide 1 (id: `slide-a`, layout: Title and body)');
    expect(text).toContain('`title-a` PLACEHOLDER TITLE: "Welcome"');
    expect(text).toContain('`img-a` IMAGE (source: https://example.com/a.png)');
    expect(text).toContain('| A | B |');
    expect(text).toContain('Speaker notes: "Say hello"');
    expect(text).toContain('### Slide 2');
  });

  it('scopes to one slide by slideNumber and by pageObjectId', async () => {
    mockCall.mockResolvedValue(deck());
    const byNumber = await h.get({ presentationId: 'pres-1', slideNumber: 2 }, ACCOUNT);
    expect(byNumber.text).toContain('### Slide 2');
    expect(byNumber.text).not.toContain('### Slide 1');
    expect(byNumber.text).not.toContain('**Layouts:**');

    const byId = await h.get({ presentationId: 'pres-1', pageObjectId: 'slide-a' }, ACCOUNT);
    expect(byId.text).toContain('### Slide 1');
    expect(byId.text).not.toContain('### Slide 2');
  });

  it('fails loudly for a slide that does not exist, rather than returning the whole deck', async () => {
    mockCall.mockResolvedValue(deck());
    await expect(h.get({ presentationId: 'pres-1', pageObjectId: 'nope' }, ACCOUNT)).rejects.toThrow(/No slide with objectId "nope".*slide-a, slide-b/);
    await expect(h.get({ presentationId: 'pres-1', slideNumber: 3 }, ACCOUNT)).rejects.toThrow(/1 to 2/);
    await expect(h.get({ presentationId: 'pres-1', slideNumber: 0 }, ACCOUNT)).rejects.toThrow(/1 to 2/);
  });

  it('requires a presentationId', async () => {
    await expect(h.get({}, ACCOUNT)).rejects.toThrow();
  });
});

describe('slidesPatch.create', () => {
  it('creates with the given title and reports id, url and first slide', async () => {
    mockCall.mockResolvedValue({ presentationId: 'new-1', slides: [{ objectId: 'p' }] });
    const res = await h.create({ title: 'Roadmap' }, ACCOUNT);
    expect(mockCall).toHaveBeenCalledWith('slides', 'presentations.create', { title: 'Roadmap' }, { account: ACCOUNT });
    expect(res.text).toContain('https://docs.google.com/presentation/d/new-1/edit');
    expect(res.text).toContain('`p`');
  });

  it('defaults the title', async () => {
    mockCall.mockResolvedValue({ presentationId: 'new-1' });
    await h.create({}, ACCOUNT);
    expect(mockCall).toHaveBeenCalledWith('slides', 'presentations.create', { title: 'Untitled presentation' }, { account: ACCOUNT });
  });
});

describe('slidesPatch.addSlide', () => {
  function pageWith(...els: Array<Record<string, unknown>>): Record<string, unknown> {
    return { pageElements: els };
  }

  it('creates the slide with a chosen id and fills title and body placeholders', async () => {
    mockCall.mockImplementation(async (_s, method) => {
      if (method === 'presentations.pages.get') {
        return pageWith(shapeEl('ph-t', '', 'TITLE'), shapeEl('ph-b', '', 'BODY'));
      }
      return {};
    });

    const res = await h.addSlide({ presentationId: 'pres-1', title: 'Hello', body: 'Line 1\n  indented' }, ACCOUNT);

    const create = batchRequests(0)[0].createSlide as Record<string, unknown>;
    expect(String(create.objectId)).toMatch(/^slide_[0-9a-f]{12}$/);
    expect(create.slideLayoutReference).toEqual({ predefinedLayout: 'TITLE_AND_BODY' });
    expect(create).not.toHaveProperty('insertionIndex');

    expect(batchRequests(1)).toEqual([
      { insertText: { objectId: 'ph-t', insertionIndex: 0, text: 'Hello' } },
      // untrimmed: indentation and newlines are content
      { insertText: { objectId: 'ph-b', insertionIndex: 0, text: 'Line 1\n  indented' } },
    ]);
    expect(res.text).toContain('(filled)');
    expect(res.text).toContain('at the end of the deck');
  });

  it('uses insertionIndex, layoutId over layout, and SUBTITLE for body on title layouts', async () => {
    mockCall.mockImplementation(async (_s, method) =>
      method === 'presentations.pages.get' ? pageWith(shapeEl('ph-c', '', 'CENTERED_TITLE'), shapeEl('ph-s', '', 'SUBTITLE')) : {});

    await h.addSlide({ presentationId: 'pres-1', layoutId: 'lay-9', layout: 'BLANK', insertionIndex: 0, title: 'T', body: 'S' }, ACCOUNT);

    const create = batchRequests(0)[0].createSlide as Record<string, unknown>;
    expect(create.slideLayoutReference).toEqual({ layoutId: 'lay-9' });
    expect(create.insertionIndex).toBe(0);
    expect(batchRequests(1).map((r) => (r.insertText as { objectId: string }).objectId)).toEqual(['ph-c', 'ph-s']);
  });

  it('with no text, creates the slide and makes no second write', async () => {
    mockCall.mockImplementation(async (_s, method) =>
      method === 'presentations.pages.get' ? pageWith(shapeEl('ph-t', '', 'TITLE')) : {});
    const res = await h.addSlide({ presentationId: 'pres-1', layout: 'TITLE_ONLY' }, ACCOUNT);
    expect(batchCount()).toBe(1);
    expect(res.text).toContain('TITLE');
  });

  it('says so when the layout has no placeholder for the text, and still reports the slide', async () => {
    mockCall.mockImplementation(async (_s, method) =>
      method === 'presentations.pages.get' ? pageWith() : {});
    const res = await h.addSlide({ presentationId: 'pres-1', layout: 'BLANK', title: 'Lost?' }, ACCOUNT);
    expect(res.text).toMatch(/no title placeholder/);
    expect(res.text).toContain('**Slide ID:**');
    expect(batchCount()).toBe(1);
  });

  it('reports a failure AFTER the slide exists instead of throwing', async () => {
    mockCall.mockImplementation(async (_s, method) => {
      if (method === 'presentations.pages.get') throw new Error('quota exceeded');
      return {};
    });
    const res = await h.addSlide({ presentationId: 'pres-1', title: 'T' }, ACCOUNT);
    expect(res.text).toMatch(/slide was created, but filling it failed: quota exceeded/);
    expect(res.text).toContain('**Slide ID:**');
  });

  it('does not claim a placeholder was filled when the fill write failed', async () => {
    let writes = 0;
    mockCall.mockImplementation(async (_s, method) => {
      if (method === 'presentations.pages.get') return pageWith(shapeEl('ph-t', '', 'TITLE'));
      if (++writes === 2) throw new Error('boom');
      return {};
    });
    const res = await h.addSlide({ presentationId: 'pres-1', title: 'T' }, ACCOUNT);
    expect(res.text).toMatch(/filling it failed: boom/);
    expect(res.text).not.toContain('(filled)');
  });

  it('creating the slide failing IS an error, and nothing else is attempted', async () => {
    mockCall.mockRejectedValue(new Error('403'));
    await expect(h.addSlide({ presentationId: 'pres-1' }, ACCOUNT)).rejects.toThrow('403');
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown layout and a bad insertionIndex before calling Google', async () => {
    await expect(h.addSlide({ presentationId: 'pres-1', layout: 'FANCY' }, ACCOUNT)).rejects.toThrow(/Unknown layout "FANCY"/);
    await expect(h.addSlide({ presentationId: 'pres-1', insertionIndex: -1 }, ACCOUNT)).rejects.toThrow(/from 0/);
    await expect(h.addSlide({ presentationId: 'pres-1', insertionIndex: 1.5 }, ACCOUNT)).rejects.toThrow(/whole number/);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('slidesPatch.setText', () => {
  it('deletes the old text and inserts the new', async () => {
    mockCall.mockResolvedValueOnce(deck()).mockResolvedValue({});
    await h.setText({ presentationId: 'pres-1', objectId: 'title-a', text: 'Hi' }, ACCOUNT);
    expect(batchRequests()).toEqual([
      { deleteText: { objectId: 'title-a', textRange: { type: 'ALL' } } },
      { insertText: { objectId: 'title-a', insertionIndex: 0, text: 'Hi' } },
    ]);
  });

  it('skips deleteText on a shape that is already empty', async () => {
    mockCall.mockResolvedValueOnce(deck()).mockResolvedValue({});
    await h.setText({ presentationId: 'pres-1', objectId: 'empty-a', text: 'Fill me' }, ACCOUNT);
    expect(batchRequests()).toEqual([{ insertText: { objectId: 'empty-a', insertionIndex: 0, text: 'Fill me' } }]);
  });

  it('clears a shape with an empty string, and does nothing if it was already empty', async () => {
    mockCall.mockResolvedValueOnce(deck()).mockResolvedValue({});
    await h.setText({ presentationId: 'pres-1', objectId: 'title-a', text: '' }, ACCOUNT);
    expect(batchRequests()).toEqual([{ deleteText: { objectId: 'title-a', textRange: { type: 'ALL' } } }]);

    mockCall.mockReset();
    mockCall.mockResolvedValueOnce(deck());
    const res = await h.setText({ presentationId: 'pres-1', objectId: 'empty-a', text: '' }, ACCOUNT);
    expect(res.text).toMatch(/already empty/);
    expect(batchCount()).toBe(0);
  });

  it('errors for a missing id and for a non-shape element', async () => {
    mockCall.mockResolvedValue(deck());
    await expect(h.setText({ presentationId: 'pres-1', objectId: 'ghost', text: 'x' }, ACCOUNT)).rejects.toThrow(/No element with objectId "ghost"/);
    await expect(h.setText({ presentationId: 'pres-1', objectId: 'img-a', text: 'x' }, ACCOUNT)).rejects.toThrow(/IMAGE, not a shape/);
    expect(batchCount()).toBe(0);
  });

  it('requires text, but allows it to be empty', async () => {
    await expect(h.setText({ presentationId: 'pres-1', objectId: 'title-a' }, ACCOUNT)).rejects.toThrow(/text is required/);
  });
});

describe('slidesPatch.replaceText', () => {
  it('sends replaceAllText, case-sensitive by default, and reports the count', async () => {
    mockCall.mockResolvedValue({ replies: [{ replaceAllText: { occurrencesChanged: 3 } }] });
    const res = await h.replaceText({ presentationId: 'pres-1', findText: '2025', replaceWith: '2026' }, ACCOUNT);
    expect(batchRequests()).toEqual([{ replaceAllText: { containsText: { text: '2025', matchCase: true }, replaceText: '2026' } }]);
    expect(res.text).toContain('Replaced 3 occurrence(s)');
  });

  it('limits to chosen slides, honors matchCase false, and allows deleting matches', async () => {
    mockCall.mockResolvedValue({ replies: [{ replaceAllText: {} }] });
    const res = await h.replaceText(
      { presentationId: 'pres-1', findText: 'DRAFT', replaceWith: '', matchCase: false, pageObjectIds: 'slide-a, slide-b ,' }, ACCOUNT);
    expect(batchRequests()).toEqual([{
      replaceAllText: { containsText: { text: 'DRAFT', matchCase: false }, replaceText: '', pageObjectIds: ['slide-a', 'slide-b'] },
    }]);
    expect(res.text).toMatch(/No occurrences/);
  });
});

describe('slidesPatch.addTextBox', () => {
  it('creates the box, inserts the text and styles it, all in one batch', async () => {
    mockCall.mockResolvedValue({});
    await h.addTextBox({ presentationId: 'pres-1', pageObjectId: 'slide-a', text: 'Note', x: 10, y: 20, width: 200, height: 50, fontSize: 14 }, ACCOUNT);

    const [shape, insert, style] = batchRequests();
    const create = shape.createShape as { objectId: string; shapeType: string; elementProperties: Record<string, unknown> };
    expect(create.shapeType).toBe('TEXT_BOX');
    expect(create.objectId).toMatch(/^textbox_[0-9a-f]{12}$/);
    expect(create.elementProperties).toEqual({
      pageObjectId: 'slide-a',
      size: { width: { magnitude: 200, unit: 'PT' }, height: { magnitude: 50, unit: 'PT' } },
      transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: 'PT' },
    });
    expect(insert).toEqual({ insertText: { objectId: create.objectId, insertionIndex: 0, text: 'Note' } });
    expect(style).toEqual({ updateTextStyle: { objectId: create.objectId, textRange: { type: 'ALL' }, style: { fontSize: { magnitude: 14, unit: 'PT' } }, fields: 'fontSize' } });
    expect(mockCall).toHaveBeenCalledTimes(1); // pageObjectId given: no extra read
  });

  it('applies defaults, resolves slideNumber, and omits the style request without a fontSize', async () => {
    mockCall.mockResolvedValueOnce({ slides: [{ objectId: 'slide-a' }, { objectId: 'slide-b' }] }).mockResolvedValue({});
    await h.addTextBox({ presentationId: 'pres-1', slideNumber: 2, text: 'x' }, ACCOUNT);

    expect(mockCall.mock.calls[0][2]).toEqual({ presentationId: 'pres-1', fields: 'slides(objectId)' });
    const requests = batchRequests();
    expect(requests).toHaveLength(2);
    const props = (requests[0].createShape as { elementProperties: Record<string, unknown> }).elementProperties;
    expect(props.pageObjectId).toBe('slide-b');
    expect(props.size).toEqual({ width: { magnitude: 400, unit: 'PT' }, height: { magnitude: 100, unit: 'PT' } });
  });

  it('validates before calling Google', async () => {
    await expect(h.addTextBox({ presentationId: 'p', pageObjectId: 's', text: '' }, ACCOUNT)).rejects.toThrow(/text is required/);
    await expect(h.addTextBox({ presentationId: 'p', pageObjectId: 's', text: 'x', width: 0 }, ACCOUNT)).rejects.toThrow(/greater than 0/);
    await expect(h.addTextBox({ presentationId: 'p', pageObjectId: 's', text: 'x', fontSize: -1 }, ACCOUNT)).rejects.toThrow(/fontSize/);
    await expect(h.addTextBox({ presentationId: 'p', pageObjectId: 's', text: 'x', x: 'left' }, ACCOUNT)).rejects.toThrow(/x must be a number/);
    await expect(h.addTextBox({ presentationId: 'p', text: 'x' }, ACCOUNT)).rejects.toThrow(/Name the slide/);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('rejects a slideNumber past the end of the deck', async () => {
    mockCall.mockResolvedValue({ slides: [{ objectId: 'only' }] });
    await expect(h.addTextBox({ presentationId: 'p', slideNumber: 4, text: 'x' }, ACCOUNT)).rejects.toThrow(/1 slide\(s\), so slide 4 does not exist/);
  });

  it('pageObjectId wins over slideNumber', async () => {
    mockCall.mockResolvedValue({});
    await h.addTextBox({ presentationId: 'p', pageObjectId: 'mine', slideNumber: 9, text: 'x' }, ACCOUNT);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(((batchRequests()[0].createShape as Record<string, any>).elementProperties).pageObjectId).toBe('mine');
  });
});

describe('slidesPatch.addImage', () => {
  it('sends createImage with size and position when given', async () => {
    mockCall.mockResolvedValue({});
    await h.addImage({ presentationId: 'p', pageObjectId: 's', imageUrl: 'https://x.test/a.png', x: 5, y: 6, width: 100, height: 80 }, ACCOUNT);
    const create = batchRequests()[0].createImage as Record<string, any>;
    expect(create.url).toBe('https://x.test/a.png');
    expect(create.objectId).toMatch(/^image_[0-9a-f]{12}$/);
    expect(create.elementProperties.size).toEqual({ width: { magnitude: 100, unit: 'PT' }, height: { magnitude: 80, unit: 'PT' } });
    expect(create.elementProperties.transform).toMatchObject({ translateX: 5, translateY: 6, unit: 'PT' });
  });

  it('with no size or position, leaves both for Google to decide', async () => {
    mockCall.mockResolvedValue({});
    await h.addImage({ presentationId: 'p', pageObjectId: 's', imageUrl: 'http://x.test/a.png' }, ACCOUNT);
    expect((batchRequests()[0].createImage as Record<string, any>).elementProperties).toEqual({ pageObjectId: 's' });
  });

  it('only x or only y still places the image, defaulting the other to 0', async () => {
    mockCall.mockResolvedValue({});
    await h.addImage({ presentationId: 'p', pageObjectId: 's', imageUrl: 'https://x.test/a.png', y: 30 }, ACCOUNT);
    expect((batchRequests()[0].createImage as Record<string, any>).elementProperties.transform).toMatchObject({ translateX: 0, translateY: 30 });
  });

  it('requires width and height together, a positive size, and an http(s) url', async () => {
    const base = { presentationId: 'p', pageObjectId: 's', imageUrl: 'https://x.test/a.png' };
    await expect(h.addImage({ ...base, width: 100 }, ACCOUNT)).rejects.toThrow(/both width and height/);
    await expect(h.addImage({ ...base, height: 100 }, ACCOUNT)).rejects.toThrow(/both width and height/);
    await expect(h.addImage({ ...base, width: 0, height: 10 }, ACCOUNT)).rejects.toThrow(/greater than 0/);
    await expect(h.addImage({ ...base, imageUrl: 'file:///etc/passwd' }, ACCOUNT)).rejects.toThrow(/http\(s\)/);
    await expect(h.addImage({ ...base, imageUrl: 'ftp://x.test/a.png' }, ACCOUNT)).rejects.toThrow(/http\(s\)/);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('slidesPatch.setNotes', () => {
  it('replaces existing notes in the notes shape, not on the slide', async () => {
    mockCall.mockResolvedValueOnce(deck()).mockResolvedValue({});
    await h.setNotes({ presentationId: 'pres-1', pageObjectId: 'slide-a', text: 'New notes' }, ACCOUNT);
    expect(batchRequests()).toEqual([
      { deleteText: { objectId: 'notes-a', textRange: { type: 'ALL' } } },
      { insertText: { objectId: 'notes-a', insertionIndex: 0, text: 'New notes' } },
    ]);
  });

  it('skips deleteText when the notes are empty', async () => {
    mockCall.mockResolvedValueOnce(deck()).mockResolvedValue({});
    await h.setNotes({ presentationId: 'pres-1', pageObjectId: 'slide-b', text: 'First notes' }, ACCOUNT);
    expect(batchRequests()).toEqual([{ insertText: { objectId: 'notes-b', insertionIndex: 0, text: 'First notes' } }]);
  });

  it('works by slideNumber, and clearing empty notes is a no-op', async () => {
    mockCall
      .mockResolvedValueOnce({ slides: [{ objectId: 'slide-a' }, { objectId: 'slide-b' }] })
      .mockResolvedValueOnce(deck());
    const res = await h.setNotes({ presentationId: 'pres-1', slideNumber: 2, text: '' }, ACCOUNT);
    expect(res.text).toMatch(/nothing to change/);
    expect(batchCount()).toBe(0);
  });

  it('errors for an unknown slide and for a slide with no notes shape', async () => {
    mockCall.mockResolvedValue(deck());
    await expect(h.setNotes({ presentationId: 'pres-1', pageObjectId: 'zzz', text: 'x' }, ACCOUNT)).rejects.toThrow(/No slide with objectId "zzz"/);

    const noNotes = deck();
    ((noNotes.slides as Array<Record<string, any>>)[0].slideProperties as Record<string, unknown>).notesPage = {};
    mockCall.mockReset();
    mockCall.mockResolvedValue(noNotes);
    await expect(h.setNotes({ presentationId: 'pres-1', pageObjectId: 'slide-a', text: 'x' }, ACCOUNT)).rejects.toThrow(/no speaker notes shape/);
  });
});

describe('slidesPatch.batchUpdate', () => {
  it('passes parsed requests through and echoes the replies', async () => {
    mockCall.mockResolvedValue({ replies: [{}] });
    const res = await h.batchUpdate({ presentationId: 'p', requests: '[{"deleteObject":{"objectId":"g1"}}]' }, ACCOUNT);
    expect(batchRequests()).toEqual([{ deleteObject: { objectId: 'g1' } }]);
    expect(res.text).toContain('Applied 1 request(s)');
  });

  it.each([
    ['not json', /valid JSON/],
    ['{"deleteObject":{}}', /non-empty JSON array/],
    ['[]', /non-empty JSON array/],
    ['[{}]', /exactly one key/],
    ['[{"a":1,"b":2}]', /exactly one key/],
    ['["deleteObject"]', /exactly one key/],
    ['[[1]]', /exactly one key/],
  ])('rejects %s before calling Google', async (requests, message) => {
    await expect(h.batchUpdate({ presentationId: 'p', requests }, ACCOUNT)).rejects.toThrow(message);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('truncates a huge reply echo but keeps the full replies in refs', async () => {
    const replies = Array.from({ length: 400 }, (_, i) => ({ createShape: { objectId: `shape-${i}-padding-padding` } }));
    mockCall.mockResolvedValue({ replies });
    const res = await h.batchUpdate({ presentationId: 'p', requests: '[{"createSlide":{}}]' }, ACCOUNT);
    expect(res.text).toMatch(/more characters/);
    expect((res.refs as { replies: unknown[] }).replies).toHaveLength(400);
  });
});

describe('slidesPatch.viewSlide', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the thumbnail and returns it as an inline image block', async () => {
    mockCall.mockResolvedValue({ contentUrl: 'https://lh3.example/thumb', width: 800, height: 450 });
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

    const res = await h.viewSlide({ presentationId: 'pres-1', pageObjectId: 'slide-a' }, ACCOUNT);

    expect(mockCall).toHaveBeenCalledWith('slides', 'presentations.pages.getThumbnail', {
      presentationId: 'pres-1',
      pageObjectId: 'slide-a',
      'thumbnailProperties.mimeType': 'PNG',
      'thumbnailProperties.thumbnailSize': 'MEDIUM',
    }, { account: ACCOUNT });
    expect(fetchMock.mock.calls[0][0]).toBe('https://lh3.example/thumb');
    expect(res.content).toHaveLength(1);
    expect(res.content![0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') });
    expect(res.text).toContain('800 x 450 px (MEDIUM)');
  });

  it('passes the requested size through', async () => {
    mockCall.mockResolvedValue({ contentUrl: 'https://lh3.example/thumb' });
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    await h.viewSlide({ presentationId: 'p', pageObjectId: 's', size: 'LARGE' }, ACCOUNT);
    expect(mockCall.mock.calls[0][2]).toMatchObject({ 'thumbnailProperties.thumbnailSize': 'LARGE' });
  });

  it('errors on a bad size, a missing contentUrl, and a failed download', async () => {
    await expect(h.viewSlide({ presentationId: 'p', pageObjectId: 's', size: 'HUGE' }, ACCOUNT)).rejects.toThrow(/SMALL, MEDIUM, LARGE/);
    expect(mockCall).not.toHaveBeenCalled();

    mockCall.mockResolvedValue({});
    await expect(h.viewSlide({ presentationId: 'p', pageObjectId: 's' }, ACCOUNT)).rejects.toThrow(/no image/);

    mockCall.mockResolvedValue({ contentUrl: 'https://lh3.example/thumb' });
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    await expect(h.viewSlide({ presentationId: 'p', pageObjectId: 's' }, ACCOUNT)).rejects.toThrow(/HTTP 404/);
  });
});

describe('wire placement', () => {
  it('thumbnailProperties.* land in the query string, not the body', async () => {
    const req = await requestFor('slides', 'presentations.pages.getThumbnail', {
      presentationId: 'pres-1',
      pageObjectId: 'slide-a',
      'thumbnailProperties.mimeType': 'PNG',
      'thumbnailProperties.thumbnailSize': 'SMALL',
    });
    expect(req.url).toContain('/presentations/pres-1/pages/slide-a/thumbnail');
    expect(queryOf(req)).toMatchObject({
      'thumbnailProperties.mimeType': 'PNG',
      'thumbnailProperties.thumbnailSize': 'SMALL',
    });
  });

  it('batchUpdate sends requests in the body, not the query', async () => {
    const req = await requestFor('slides', 'presentations.batchUpdate', {
      presentationId: 'pres-1',
      requests: [{ deleteObject: { objectId: 'x' } }],
    });
    expect(queryOf(req)).not.toHaveProperty('requests');
    expect(JSON.stringify(req.body)).toContain('deleteObject');
  });

  it('get with fields puts fields in the query', async () => {
    const req = await requestFor('slides', 'presentations.get', { presentationId: 'pres-1', fields: 'slides(objectId)' });
    expect(queryOf(req)).toMatchObject({ fields: 'slides(objectId)' });
  });
});
