import { describe, expect, it } from 'vitest';
import type { AdfNode } from '../../../src/adapters/jira/adf.js';
import { adfToText } from '../../../src/adapters/jira/adf.js';
import { buildVerificationCommentAdf } from '../../../src/adapters/jira/comment-adf.js';
import type { VerificationComment } from '../../../src/ports/ticket-commenter.js';

const comment: VerificationComment = {
  verdict: 'NOT_RESOLVED',
  environment: 'staging',
  commitSha: 'abcdef1234567890',
  summary: '1 of 2 acceptance criteria failed.',
  results: [
    { criterionId: 'AC-1', status: 'PASSED', reason: 'Banner visible' },
    {
      criterionId: 'AC-2',
      status: 'FAILED',
      reason: 'Total did not update',
      evidence: { expected: '$20.00', actual: '$10.00', screenshotPath: '/tmp/qa/ac-2.png' },
    },
  ],
  attachments: ['/tmp/qa/ac-2.png'],
};

function blocks(doc: AdfNode): AdfNode[] {
  return doc.content ?? [];
}

describe('buildVerificationCommentAdf', () => {
  it('produces an ADF doc of version 1', () => {
    const doc = buildVerificationCommentAdf(comment);
    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
  });

  it('starts with a heading carrying the verdict label, environment and short commit', () => {
    const [heading] = blocks(buildVerificationCommentAdf(comment));
    expect(heading?.type).toBe('heading');
    const headingText = adfToText(heading ?? null);
    expect(headingText).toContain('NOT RESOLVED');
    expect(headingText).toContain('staging');
    expect(headingText).toContain('abcdef1');
    expect(headingText).not.toContain('abcdef1234567890');
  });

  it('includes the summary paragraph second', () => {
    const [, summary] = blocks(buildVerificationCommentAdf(comment));
    expect(summary?.type).toBe('paragraph');
    expect(adfToText(summary ?? null)).toBe('1 of 2 acceptance criteria failed.');
  });

  it('lists one bullet per criterion with status, id, reason and expected/actual', () => {
    const list = blocks(buildVerificationCommentAdf(comment)).find((node) => node.type === 'bulletList');
    expect(list?.content).toHaveLength(2);
    const [first, second] = (list?.content ?? []).map((node) => adfToText(node));
    expect(first).toContain('PASSED');
    expect(first).toContain('AC-1');
    expect(first).toContain('Banner visible');
    expect(second).toContain('FAILED');
    expect(second).toContain('AC-2');
    expect(second).toContain('Expected: $20.00');
    expect(second).toContain('Actual: $10.00');
  });

  it('names attached files by basename and mentions failed uploads', () => {
    const doc = buildVerificationCommentAdf(comment, { failedAttachments: ['/tmp/qa/trace.zip'] });
    const textOut = adfToText(doc);
    expect(textOut).toContain('ac-2.png');
    expect(textOut).not.toContain('/tmp/qa/');
    expect(textOut).toContain('trace.zip');
    expect(textOut.toLowerCase()).toContain('could not be attached');
  });

  it('omits the commit and attachment note when absent', () => {
    const doc = buildVerificationCommentAdf({
      ...comment,
      verdict: 'INCONCLUSIVE',
      commitSha: undefined,
      results: [],
      attachments: [],
    });
    const textOut = adfToText(doc);
    expect(textOut).toContain('INCONCLUSIVE');
    expect(textOut).not.toContain('commit');
    expect(textOut).not.toContain('Attached');
    expect(blocks(doc).some((node) => node.type === 'bulletList')).toBe(false);
  });
});
