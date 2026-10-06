import { describe, expect, it } from 'vitest';
import { adfToText, type AdfNode } from '../../../src/adapters/jira/adf.js';

const text = (value: string): AdfNode => ({ type: 'text', text: value });
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const item = (...content: AdfNode[]): AdfNode => ({ type: 'listItem', content });

describe('adfToText', () => {
  it('renders paragraphs and headings as separate lines', () => {
    const doc: AdfNode = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
        paragraph(text('Hello '), { type: 'text', text: 'world', marks: [{ type: 'strong' }] }),
      ],
    };
    expect(adfToText(doc)).toBe('Title\nHello world');
  });

  it('renders hard breaks as new lines', () => {
    expect(adfToText(paragraph(text('a'), { type: 'hardBreak' }, text('b')))).toBe('a\nb');
  });

  it('renders bullet and ordered lists with markers, including nesting', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            item(paragraph(text('one')), {
              type: 'bulletList',
              content: [item(paragraph(text('nested')))],
            }),
            item(paragraph(text('two'))),
          ],
        },
        {
          type: 'orderedList',
          attrs: { order: 3 },
          content: [item(paragraph(text('three'))), item(paragraph(text('four')))],
        },
      ],
    };
    expect(adfToText(doc)).toBe('- one\n  - nested\n- two\n3. three\n4. four');
  });

  it('renders code blocks as their raw text', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;\nconst b = 2;')] }],
    };
    expect(adfToText(doc)).toBe('const a = 1;\nconst b = 2;');
  });

  it('recurses into unknown nodes', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        { type: 'panel', attrs: { panelType: 'info' }, content: [paragraph(text('inside panel'))] },
        paragraph({ type: 'mention', attrs: { text: '@Ana' } }, text(' please check')),
      ],
    };
    expect(adfToText(doc)).toBe('inside panel\n@Ana please check');
  });

  it('returns an empty string for null or empty documents', () => {
    expect(adfToText(null)).toBe('');
    expect(adfToText({ type: 'doc', content: [] })).toBe('');
  });
});
