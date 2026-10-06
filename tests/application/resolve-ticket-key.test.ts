import { describe, expect, it } from 'vitest';
import { resolveTicketKey } from '../../src/application/resolve-ticket-key.js';

describe('resolveTicketKey', () => {
  it('prefers the explicit key over branch and commit', () => {
    expect(
      resolveTicketKey({ explicit: 'ABC-9', branch: 'feature/PROJ-1-x', commitMessage: 'PROJ-2 fix' }),
    ).toEqual({ key: 'ABC-9', source: 'explicit' });
  });

  it('normalizes an explicit key to upper case and trims it', () => {
    expect(resolveTicketKey({ explicit: '  abc-9 ' })).toEqual({ key: 'ABC-9', source: 'explicit' });
  });

  it('extracts the key from the branch name', () => {
    expect(resolveTicketKey({ branch: 'feature/PROJ-123-add-login' })).toEqual({
      key: 'PROJ-123',
      source: 'branch',
    });
  });

  it('upper-cases a lowercase key in the branch name', () => {
    expect(resolveTicketKey({ branch: 'feature/proj-123-x' })).toEqual({ key: 'PROJ-123', source: 'branch' });
  });

  it('handles keys with digits in the project part', () => {
    expect(resolveTicketKey({ branch: 'bugfix/AB2-7' })).toEqual({ key: 'AB2-7', source: 'branch' });
  });

  it('falls back to the commit message when the branch has no key', () => {
    expect(resolveTicketKey({ branch: 'main', commitMessage: 'PROJ-55: fix header' })).toEqual({
      key: 'PROJ-55',
      source: 'commit',
    });
  });

  it('handles the Bitbucket merge commit format', () => {
    const commitMessage = 'Merged in feature/proj-123-foo (pull request #45)\n\nApproved-by: Someone';
    expect(resolveTicketKey({ branch: 'main', commitMessage })).toEqual({ key: 'PROJ-123', source: 'commit' });
  });

  it('does not treat the pull request number as a key', () => {
    expect(resolveTicketKey({ commitMessage: 'Merged in hotfix (pull request #45)' })).toBeNull();
  });

  it('only matches upper-case keys in free-form commit messages', () => {
    expect(resolveTicketKey({ commitMessage: 'bump utf-8 handling and sha-256' })).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(resolveTicketKey({})).toBeNull();
    expect(resolveTicketKey({ explicit: '', branch: 'develop', commitMessage: 'chore: tidy' })).toBeNull();
  });

  it('ignores an explicit value that is not a valid key', () => {
    expect(resolveTicketKey({ explicit: 'not a key', branch: 'feature/PROJ-8' })).toEqual({
      key: 'PROJ-8',
      source: 'branch',
    });
  });
});
