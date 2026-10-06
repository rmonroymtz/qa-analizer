import { basename } from 'node:path';
import type { CriterionResult } from '../../domain/criterion-result.js';
import type { Verdict } from '../../domain/verdict.js';
import type { VerificationComment } from '../../ports/ticket-commenter.js';
import type { AdfNode } from './adf.js';

export interface CommentAdfOptions {
  /** Attachments that could not be uploaded; they are named in the comment. */
  failedAttachments?: string[];
}

const VERDICT_EMOJI: Record<Verdict, string> = {
  RESOLVED: '✅',
  NOT_RESOLVED: '❌',
  INCONCLUSIVE: '⚠️',
};

const text = (value: string, strong = false): AdfNode =>
  strong ? { type: 'text', text: value, marks: [{ type: 'strong' }] } : { type: 'text', text: value };
const paragraph = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const hardBreak: AdfNode = { type: 'hardBreak' };

function criterionItem(result: CriterionResult): AdfNode {
  const content: AdfNode[] = [text(`[${result.status}] ${result.criterionId}`, true), text(`: ${result.reason}`)];
  const { expected, actual } = result.evidence ?? {};
  if (expected !== undefined) content.push(hardBreak, text(`Expected: ${expected}`));
  if (actual !== undefined) content.push(hardBreak, text(`Actual: ${actual}`));
  return { type: 'listItem', content: [paragraph(...content)] };
}

/** Builds the ADF body of the verification comment posted on the ticket. */
export function buildVerificationCommentAdf(comment: VerificationComment, options: CommentAdfOptions = {}): AdfNode {
  const label = comment.verdict.replace('_', ' ');
  const commit = comment.commitSha ? ` (commit ${comment.commitSha.slice(0, 7)})` : '';
  const content: AdfNode[] = [
    {
      type: 'heading',
      attrs: { level: 3 },
      content: [text(`${VERDICT_EMOJI[comment.verdict]} ${label}: QA verification on ${comment.environment}${commit}`)],
    },
    paragraph(text(comment.summary)),
  ];

  if (comment.results.length > 0) {
    content.push({ type: 'bulletList', content: comment.results.map(criterionItem) });
  }

  if (comment.attachments.length > 0) {
    content.push(paragraph(text(`Attached evidence: ${comment.attachments.map((path) => basename(path)).join(', ')}`)));
  }

  const failed = options.failedAttachments ?? [];
  if (failed.length > 0) {
    content.push(
      paragraph(text(`Evidence that could not be attached: ${failed.map((path) => basename(path)).join(', ')}`)),
    );
  }

  return { type: 'doc', version: 1, content };
}
