import { describe, expect, it } from 'vitest';
import type { AdfNode } from '../../../src/adapters/jira/adf.js';
import { extractAcceptanceCriteria } from '../../../src/adapters/jira/acceptance-criteria.js';

const text = (value: string): AdfNode => ({ type: 'text', text: value });
const paragraph = (value: string): AdfNode => ({ type: 'paragraph', content: [text(value)] });
const heading = (value: string): AdfNode => ({ type: 'heading', attrs: { level: 3 }, content: [text(value)] });
const bullets = (...items: string[]): AdfNode => ({
  type: 'bulletList',
  content: items.map((value) => ({ type: 'listItem', content: [paragraph(value)] })),
});
const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content });

describe('extractAcceptanceCriteria', () => {
  it('uses the custom field when it is ADF with content', () => {
    const criteria = extractAcceptanceCriteria({
      acField: doc(bullets('User can log in', 'Error is shown on bad password')),
      description: doc(heading('Acceptance criteria'), bullets('ignored')),
    });
    expect(criteria).toEqual([
      { id: 'AC-1', text: 'User can log in' },
      { id: 'AC-2', text: 'Error is shown on bad password' },
    ]);
  });

  it('uses the custom field when it is a plain string, stripping bullet markers', () => {
    const criteria = extractAcceptanceCriteria({
      acField: '* First\n- Second\n\n1. Third\n2) Fourth',
      description: null,
    });
    expect(criteria.map((criterion) => criterion.text)).toEqual(['First', 'Second', 'Third', 'Fourth']);
    expect(criteria.map((criterion) => criterion.id)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4']);
  });

  it('falls back to the description when the custom field is empty', () => {
    const criteria = extractAcceptanceCriteria({
      acField: doc(),
      description: doc(
        paragraph('Context paragraph'),
        heading('Acceptance Criteria'),
        bullets('Banner is visible', 'Banner links to /promo'),
        heading('Notes'),
        bullets('not a criterion'),
      ),
    });
    expect(criteria).toEqual([
      { id: 'AC-1', text: 'Banner is visible' },
      { id: 'AC-2', text: 'Banner links to /promo' },
    ]);
  });

  it('accepts a Spanish label in a paragraph followed by paragraphs', () => {
    const criteria = extractAcceptanceCriteria({
      acField: undefined,
      description: doc(paragraph('Criterios de aceptación:'), paragraph('El botón se muestra'), paragraph('El total se actualiza')),
    });
    expect(criteria.map((criterion) => criterion.text)).toEqual(['El botón se muestra', 'El total se actualiza']);
  });

  it('parses a plain-text description until the next heading', () => {
    const criteria = extractAcceptanceCriteria({
      acField: undefined,
      description: 'Intro\n\nAcceptance criteria\n- A works\n- B works\n\n## Out of scope\n- C',
    });
    expect(criteria.map((criterion) => criterion.text)).toEqual(['A works', 'B works']);
  });

  it('returns no criteria when nothing is labelled', () => {
    expect(extractAcceptanceCriteria({ acField: undefined, description: doc(paragraph('Just a description')) })).toEqual(
      [],
    );
    expect(extractAcceptanceCriteria({ acField: null, description: null })).toEqual([]);
  });
});
