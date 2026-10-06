export type TicketKeySource = 'explicit' | 'branch' | 'commit';

export interface TicketKeyCandidates {
  explicit?: string | undefined;
  branch?: string | undefined;
  commitMessage?: string | undefined;
}

export interface TicketKeyOptions {
  /** Jira project keys (e.g. `PROJ`). When non-empty, only keys of these projects are accepted, from any source. */
  projects?: readonly string[] | undefined;
}

export interface ResolvedTicketKey {
  key: string;
  source: TicketKeySource;
}

/** An explicit ticket key was given but is not a valid (or allowed) Jira issue key. */
export class InvalidTicketKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTicketKeyError';
  }
}

/**
 * Prefixes that look like issue keys but are standards, algorithms or other
 * common tokens (`UTF-8`, `SHA-256`, `release-2`, ...). Never treated as keys.
 */
export const NON_TICKET_PREFIXES: ReadonlySet<string> = new Set([
  'UTF',
  'SHA',
  'ISO',
  'RFC',
  'HTTP',
  'TLS',
  'SSL',
  'MD',
  'AES',
  'RSA',
  'X',
  'ES',
  'IE',
  'PR',
  'RELEASE',
]);

const EXACT_KEY_ANY_CASE = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
/** In a branch name the key must start a path segment and end at `-`, `_`, `/` or the end. */
const BRANCH_KEY = /(?:^|\/)([A-Za-z][A-Za-z0-9]+-\d+)(?=[-_/]|$)/g;
/** Free-form text only matches upper-case keys, delimited as whole words. */
const TEXT_KEY = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9_])/g;
const BITBUCKET_MERGE = /^Merged in (\S+)/m;

function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf('-'));
}

function normalizeProjects(options: TicketKeyOptions): Set<string> {
  return new Set((options.projects ?? []).map((project) => project.trim().toUpperCase()).filter(Boolean));
}

function isAcceptedKey(key: string, projects: ReadonlySet<string>): boolean {
  const project = projectOf(key);
  if (projects.size > 0) return projects.has(project);
  return !NON_TICKET_PREFIXES.has(project);
}

function firstAccepted(text: string, pattern: RegExp, projects: ReadonlySet<string>): string | undefined {
  for (const match of text.matchAll(pattern)) {
    const key = match[1]?.toUpperCase();
    if (key !== undefined && isAcceptedKey(key, projects)) return key;
  }
  return undefined;
}

function keyFromBranch(branch: string | undefined, projects: ReadonlySet<string>): string | undefined {
  if (!branch) return undefined;
  return firstAccepted(branch, BRANCH_KEY, projects);
}

function keyFromCommit(message: string | undefined, projects: ReadonlySet<string>): string | undefined {
  if (!message) return undefined;
  const mergedBranch = message.match(BITBUCKET_MERGE)?.[1];
  const fromMerge = keyFromBranch(mergedBranch, projects);
  if (fromMerge) return fromMerge;
  return firstAccepted(message, TEXT_KEY, projects);
}

/**
 * Validates an explicit ticket key. Returns the normalized (upper-case) key, or
 * a human-readable problem. An explicit key is never checked against the
 * stoplist: the user named it on purpose.
 */
export function validateExplicitTicketKey(
  raw: string,
  options: TicketKeyOptions = {},
): { key: string } | { problem: string } {
  const value = raw.trim();
  if (!EXACT_KEY_ANY_CASE.test(value)) return { problem: `"${value}" is not a Jira issue key such as PROJ-123` };
  const key = value.toUpperCase();
  const projects = normalizeProjects(options);
  if (projects.size > 0 && !projects.has(projectOf(key))) {
    return { problem: `${key} is not in the configured projects (${[...projects].join(', ')})` };
  }
  return { key };
}

/**
 * Resolves the main ticket key in priority order: explicit value, branch name,
 * then the (merge) commit message. Returns null when no key can be found.
 * Throws InvalidTicketKeyError when an explicit value is present but invalid:
 * an explicit choice never silently falls back to another source.
 */
export function resolveTicketKey(candidates: TicketKeyCandidates, options: TicketKeyOptions = {}): ResolvedTicketKey | null {
  const explicit = candidates.explicit?.trim();
  if (explicit) {
    const validated = validateExplicitTicketKey(explicit, options);
    if ('problem' in validated) throw new InvalidTicketKeyError(`Invalid ticket key: ${validated.problem}`);
    return { key: validated.key, source: 'explicit' };
  }
  const projects = normalizeProjects(options);
  const fromBranch = keyFromBranch(candidates.branch, projects);
  if (fromBranch) return { key: fromBranch, source: 'branch' };
  const fromCommit = keyFromCommit(candidates.commitMessage, projects);
  if (fromCommit) return { key: fromCommit, source: 'commit' };
  return null;
}
