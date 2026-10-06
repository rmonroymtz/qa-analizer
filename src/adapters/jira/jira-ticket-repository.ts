import type { Ticket } from '../../domain/ticket.js';
import type { TicketRepository } from '../../ports/ticket-repository.js';
import { extractAcceptanceCriteria } from './acceptance-criteria.js';
import { adfToText, isAdfNode } from './adf.js';
import type { JiraClient } from './jira-client.js';

export interface JiraTicketRepositoryOptions {
  /** Custom field id holding acceptance criteria, e.g. `customfield_10050`. */
  acField?: string | undefined;
}

interface JiraIssueResponse {
  key: string;
  fields: Record<string, unknown> & { summary?: unknown; description?: unknown };
}

function descriptionText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (isAdfNode(value)) return adfToText(value);
  return '';
}

export class JiraTicketRepository implements TicketRepository {
  constructor(
    private readonly client: JiraClient,
    private readonly options: JiraTicketRepositoryOptions = {},
  ) {}

  async getTicket(key: string): Promise<Ticket> {
    const fields = ['summary', 'description', ...(this.options.acField ? [this.options.acField] : [])];
    const query = new URLSearchParams({ fields: fields.join(',') });
    const issue = await this.client.getJson<JiraIssueResponse>(
      `/rest/api/3/issue/${encodeURIComponent(key)}?${query.toString()}`,
    );
    const issueKey = issue.key ?? key;
    return {
      key: issueKey,
      summary: typeof issue.fields.summary === 'string' ? issue.fields.summary : '',
      description: descriptionText(issue.fields.description),
      acceptanceCriteria: extractAcceptanceCriteria({
        acField: this.options.acField ? issue.fields[this.options.acField] : undefined,
        description: issue.fields.description,
      }),
      url: `${this.client.baseUrl}/browse/${issueKey}`,
    };
  }
}
