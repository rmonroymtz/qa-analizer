export type TicketKeySource = 'explicit' | 'branch' | 'commit';

export interface TicketKeyCandidates {
  explicit?: string | undefined;
  branch?: string | undefined;
  commitMessage?: string | undefined;
}

export interface ResolvedTicketKey {
  key: string;
  source: TicketKeySource;
}

const KEY_PATTERN = /[A-Z][A-Z0-9]+-\d+/;
const KEY_PATTERN_ANY_CASE = /[A-Za-z][A-Za-z0-9]+-\d+/;
const EXACT_KEY_ANY_CASE = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
const BITBUCKET_MERGE = /^Merged in (\S+)/m;

function keyFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  return branch.match(KEY_PATTERN_ANY_CASE)?.[0].toUpperCase();
}

function keyFromCommit(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const mergedBranch = message.match(BITBUCKET_MERGE)?.[1];
  const fromMerge = keyFromBranch(mergedBranch);
  if (fromMerge) return fromMerge;
  // Free-form text only matches upper-case keys to avoid false positives such as "utf-8".
  return message.match(KEY_PATTERN)?.[0];
}

/**
 * Resolves the main ticket key in priority order: explicit value, branch name,
 * then the (merge) commit message. Returns null when no key can be found.
 */
export function resolveTicketKey(candidates: TicketKeyCandidates): ResolvedTicketKey | null {
  const explicit = candidates.explicit?.trim();
  if (explicit && EXACT_KEY_ANY_CASE.test(explicit)) {
    return { key: explicit.toUpperCase(), source: 'explicit' };
  }
  const fromBranch = keyFromBranch(candidates.branch);
  if (fromBranch) return { key: fromBranch, source: 'branch' };
  const fromCommit = keyFromCommit(candidates.commitMessage);
  if (fromCommit) return { key: fromCommit, source: 'commit' };
  return null;
}
