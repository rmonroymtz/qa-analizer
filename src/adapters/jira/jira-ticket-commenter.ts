import { readFile as fsReadFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { TicketCommenter, VerificationComment } from '../../ports/ticket-commenter.js';
import { buildVerificationCommentAdf } from './comment-adf.js';
import type { JiraClient } from './jira-client.js';

export interface JiraTicketCommenterOptions {
  /** Injectable for tests; defaults to `fs.readFile`. */
  readFile?: (path: string) => Promise<Uint8Array>;
}

/** Uploads evidence attachments, then posts the verification comment. */
export class JiraTicketCommenter implements TicketCommenter {
  private readonly readFile: (path: string) => Promise<Uint8Array>;

  constructor(
    private readonly client: JiraClient,
    options: JiraTicketCommenterOptions = {},
  ) {
    this.readFile = options.readFile ?? fsReadFile;
  }

  async comment(key: string, comment: VerificationComment): Promise<void> {
    const issuePath = `/rest/api/3/issue/${encodeURIComponent(key)}`;
    const uploaded: string[] = [];
    const failed: string[] = [];

    for (const path of comment.attachments) {
      try {
        const bytes = await this.readFile(path);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(bytes)]), basename(path));
        await this.client.postMultipart(`${issuePath}/attachments`, form);
        uploaded.push(path);
      } catch {
        // An attachment failure must not block the comment; it is reported inside it.
        failed.push(path);
      }
    }

    const body = buildVerificationCommentAdf({ ...comment, attachments: uploaded }, { failedAttachments: failed });
    await this.client.postJson(`${issuePath}/comment`, { body });
  }
}
