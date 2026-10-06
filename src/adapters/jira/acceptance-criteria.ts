import type { AcceptanceCriterion } from '../../domain/ticket.js';
import { adfToText, isAdfNode, type AdfNode } from './adf.js';

const AC_LABEL = /acceptance criteria|criterios de aceptaci[oó]n/i;
const BULLET_MARKER = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s+/;
const TEXT_HEADING = /^\s*(?:#{1,6}\s|h[1-6]\.\s)/;

export interface CriteriaSources {
  /** Raw value of the configured custom field (ADF, string, string[] or empty). */
  acField: unknown;
  /** Raw issue description (ADF, string or empty). */
  description: unknown;
}

function cleanLine(line: string): string {
  return line.replace(BULLET_MARKER, '').trim();
}

function linesToItems(text: string): string[] {
  return text.split('\n').map(cleanLine).filter((line) => line.length > 0);
}

function itemsFromAdfBlocks(blocks: AdfNode[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === 'bulletList' || block.type === 'orderedList') {
      return (block.content ?? [])
        .map((item) => adfToText({ type: 'doc', content: item.content ?? [] }))
        .map((itemText) => itemText.trim())
        .filter((itemText) => itemText.length > 0);
    }
    return linesToItems(adfToText(block));
  });
}

function itemsFromField(value: unknown): string[] {
  if (typeof value === 'string') return linesToItems(value);
  if (Array.isArray(value)) return value.flatMap(itemsFromField);
  if (isAdfNode(value)) return itemsFromAdfBlocks(value.content ?? []);
  return [];
}

function itemsFromAdfDescription(doc: AdfNode): string[] {
  const blocks = doc.content ?? [];
  const labelIndex = blocks.findIndex(
    (block) => (block.type === 'heading' || block.type === 'paragraph') && AC_LABEL.test(adfToText(block)),
  );
  if (labelIndex === -1) return [];
  const following = blocks.slice(labelIndex + 1);
  const nextHeading = following.findIndex((block) => block.type === 'heading');
  return itemsFromAdfBlocks(nextHeading === -1 ? following : following.slice(0, nextHeading));
}

function itemsFromTextDescription(text: string): string[] {
  const lines = text.split('\n');
  const labelIndex = lines.findIndex((line) => AC_LABEL.test(line));
  if (labelIndex === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(labelIndex + 1)) {
    if (TEXT_HEADING.test(line)) break;
    const item = cleanLine(line);
    if (item) items.push(item);
  }
  return items;
}

function number(items: string[]): AcceptanceCriterion[] {
  return items.map((text, index) => ({ id: `AC-${index + 1}`, text }));
}

/**
 * Extracts acceptance criteria, preferring the configured custom field and falling
 * back to an "Acceptance criteria" section in the description.
 */
export function extractAcceptanceCriteria(sources: CriteriaSources): AcceptanceCriterion[] {
  const fromField = itemsFromField(sources.acField);
  if (fromField.length > 0) return number(fromField);
  const { description } = sources;
  if (typeof description === 'string') return number(itemsFromTextDescription(description));
  if (isAdfNode(description)) return number(itemsFromAdfDescription(description));
  return [];
}
