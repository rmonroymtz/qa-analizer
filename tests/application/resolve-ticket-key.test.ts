import { describe, expect, it } from 'vitest';
import { InvalidTicketKeyError, resolveTicketKey } from '../../src/application/resolve-ticket-key.js';

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

  it('throws on an explicit value that is not a valid key instead of falling back', () => {
    expect(() => resolveTicketKey({ explicit: 'not a key', branch: 'feature/PROJ-8' })).toThrow(InvalidTicketKeyError);
  });

  it('throws on an explicit key outside the configured projects', () => {
    expect(() => resolveTicketKey({ explicit: 'OTHER-1', branch: 'feature/PROJ-8' }, { projects: ['PROJ'] })).toThrow(
      InvalidTicketKeyError,
    );
    expect(resolveTicketKey({ explicit: 'proj-1' }, { projects: ['PROJ'] })).toEqual({ key: 'PROJ-1', source: 'explicit' });
  });

  describe('branch rules', () => {
    it('requires the key to start a path segment', () => {
      expect(resolveTicketKey({ branch: 'feature/my-proj-123-x' })).toBeNull();
      expect(resolveTicketKey({ branch: 'PROJ-9' })).toEqual({ key: 'PROJ-9', source: 'branch' });
      expect(resolveTicketKey({ branch: 'user/feature/PROJ-9_fix' })).toEqual({ key: 'PROJ-9', source: 'branch' });
    });

    it('requires the key to end at a separator or the end of the name', () => {
      expect(resolveTicketKey({ branch: 'feature/PROJ-12abc' })).toBeNull();
      expect(resolveTicketKey({ branch: 'feature/PROJ-12/sub' })).toEqual({ key: 'PROJ-12', source: 'branch' });
    });

    it('skips stoplisted prefixes and non-ticket branch words', () => {
      expect(resolveTicketKey({ branch: 'fix/utf-8-handling' })).toBeNull();
      expect(resolveTicketKey({ branch: 'release-2' })).toBeNull();
      expect(resolveTicketKey({ branch: 'chore/sha-256/PROJ-4-x' })).toEqual({ key: 'PROJ-4', source: 'branch' });
    });

    it('only accepts configured projects when QA_JIRA_PROJECTS is set', () => {
      expect(resolveTicketKey({ branch: 'build-7' }, { projects: ['PROJ'] })).toBeNull();
      expect(resolveTicketKey({ branch: 'build-7' })).toEqual({ key: 'BUILD-7', source: 'branch' });
      expect(resolveTicketKey({ branch: 'feature/proj-3-x' }, { projects: ['PROJ'] })).toEqual({ key: 'PROJ-3', source: 'branch' });
    });
  });

  describe('free-form commit text', () => {
    it('requires word boundaries', () => {
      expect(resolveTicketKey({ commitMessage: 'fooPROJ-1 bar' })).toBeNull();
      expect(resolveTicketKey({ commitMessage: 'see PROJ-1x' })).toBeNull();
      expect(resolveTicketKey({ commitMessage: 'fix (PROJ-7): header' })).toEqual({ key: 'PROJ-7', source: 'commit' });
    });

    it('excludes stoplisted prefixes and keeps looking', () => {
      expect(resolveTicketKey({ commitMessage: 'Use UTF-8, SHA-256, ISO-8601, RFC-3339, HTTP-2, TLS-13, SSL-3, MD-5, AES-256, RSA-2048, ES-2022, IE-11, PR-45' })).toBeNull();
      expect(resolveTicketKey({ commitMessage: 'Support UTF-8 in PROJ-12' })).toEqual({ key: 'PROJ-12', source: 'commit' });
    });

    it('only accepts configured projects when QA_JIRA_PROJECTS is set', () => {
      expect(resolveTicketKey({ commitMessage: 'OTHER-1 and PROJ-2' }, { projects: ['PROJ'] })).toEqual({ key: 'PROJ-2', source: 'commit' });
    });

    it('applies branch rules to a Bitbucket merge commit', () => {
      expect(resolveTicketKey({ commitMessage: 'Merged in release-2 (pull request #45)' })).toBeNull();
    });
  });
});
