import { describe, expect, it } from 'vitest';
import { JiraClient, JiraError } from '../../../src/adapters/jira/jira-client.js';
import { JiraTicketCommenter } from '../../../src/adapters/jira/jira-ticket-commenter.js';
import { JiraTicketRepository } from '../../../src/adapters/jira/jira-ticket-repository.js';
import type { VerificationComment } from '../../../src/ports/ticket-commenter.js';

const EMAIL = 'qa@example.com';
const TOKEN = 'super-secret-jira-token';
const BASE = 'https://acme.atlassian.net';

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit['body'];
}

function fakeFetch(responder: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    return responder(call);
  };
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(fetchFn: typeof fetch) {
  return new JiraClient({ baseUrl: BASE, email: EMAIL, apiToken: TOKEN, fetch: fetchFn });
}

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const paragraph = (value: string) => ({ type: 'paragraph', content: [{ type: 'text', text: value }] });

describe('JiraClient', () => {
  it('sends basic auth and JSON accept headers', async () => {
    const { calls, fetchFn } = fakeFetch(() => json({ ok: true }));
    await client(fetchFn).getJson('/rest/api/3/myself');
    expect(calls[0]?.url).toBe(`${BASE}/rest/api/3/myself`);
    expect(calls[0]?.headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`,
    );
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
  });

  it('throws a JiraError with the status and without credentials on non-2xx', async () => {
    const { fetchFn } = fakeFetch(() => json({ errorMessages: ['Issue does not exist'] }, 404));
    const error = await client(fetchFn)
      .getJson('/rest/api/3/issue/PROJ-1')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JiraError);
    const jiraError = error as JiraError;
    expect(jiraError.status).toBe(404);
    expect(jiraError.message).toContain('404');
    expect(jiraError.message).toContain('Issue does not exist');
    const serialized = `${jiraError.message} ${JSON.stringify(jiraError)} ${String(jiraError.stack)}`;
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).not.toContain(Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'));
  });

  it('scrubs credentials echoed by the server or a network failure', async () => {
    const echo = fakeFetch(() => new Response(`bad token ${TOKEN} for ${EMAIL}`, { status: 401 }));
    const echoed = (await client(echo.fetchFn)
      .getJson('/x')
      .catch((caught: unknown) => caught)) as JiraError;
    expect(echoed.status).toBe(401);
    expect(echoed.message).not.toContain(TOKEN);
    expect(echoed.message).not.toContain(EMAIL);

    const network = fakeFetch(() => {
      throw new Error(`connect failed for ${EMAIL}:${TOKEN}`);
    });
    const failed = (await client(network.fetchFn)
      .getJson('/x')
      .catch((caught: unknown) => caught)) as JiraError;
    expect(failed).toBeInstanceOf(JiraError);
    expect(failed.status).toBe(0);
    expect(failed.message).not.toContain(TOKEN);
  });
});

describe('JiraTicketRepository', () => {
  it('requests summary and description and parses the ticket', async () => {
    const { calls, fetchFn } = fakeFetch(() =>
      json({
        key: 'PROJ-1',
        fields: {
          summary: 'Add promo banner',
          description: doc(paragraph('Show a banner.'), paragraph('Acceptance criteria:'), paragraph('Banner visible')),
        },
      }),
    );
    const ticket = await new JiraTicketRepository(client(fetchFn)).getTicket('PROJ-1');
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/rest/api/3/issue/PROJ-1');
    expect(url.searchParams.get('fields')).toBe('summary,description');
    expect(ticket).toEqual({
      key: 'PROJ-1',
      summary: 'Add promo banner',
      description: 'Show a banner.\nAcceptance criteria:\nBanner visible',
      acceptanceCriteria: [{ id: 'AC-1', text: 'Banner visible' }],
      url: `${BASE}/browse/PROJ-1`,
    });
  });

  it('requests and uses the custom acceptance criteria field', async () => {
    const { calls, fetchFn } = fakeFetch(() =>
      json({
        key: 'PROJ-2',
        fields: { summary: 'S', description: null, customfield_10050: 'First\nSecond' },
      }),
    );
    const ticket = await new JiraTicketRepository(client(fetchFn), { acField: 'customfield_10050' }).getTicket(
      'PROJ-2',
    );
    expect(new URL(calls[0]?.url ?? '').searchParams.get('fields')).toBe('summary,description,customfield_10050');
    expect(ticket.description).toBe('');
    expect(ticket.acceptanceCriteria.map((criterion) => criterion.text)).toEqual(['First', 'Second']);
  });
});

describe('JiraTicketCommenter', () => {
  const comment: VerificationComment = {
    verdict: 'NOT_RESOLVED',
    environment: 'production',
    commitSha: 'abc1234',
    summary: 'A criterion failed.',
    results: [{ criterionId: 'AC-1', status: 'FAILED', reason: 'Missing banner' }],
    attachments: ['/out/shot.png', '/out/missing.png'],
  };

  it('uploads attachments first, then posts the ADF comment mentioning failures', async () => {
    const { calls, fetchFn } = fakeFetch((call) =>
      call.url.endsWith('/attachments') ? json([{ id: '1' }]) : json({ id: '99' }, 201),
    );
    const readFile = async (path: string) => {
      if (path.includes('missing')) throw new Error('ENOENT');
      return Buffer.from('png-bytes');
    };
    await new JiraTicketCommenter(client(fetchFn), { readFile }).comment('PROJ-1', comment);

    expect(calls).toHaveLength(2);
    const [upload, post] = calls;
    expect(upload?.url).toBe(`${BASE}/rest/api/3/issue/PROJ-1/attachments`);
    expect(upload?.method).toBe('POST');
    expect(upload?.headers.get('x-atlassian-token')).toBe('no-check');
    expect(upload?.body).toBeInstanceOf(FormData);
    const file = (upload?.body as FormData).get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('shot.png');

    expect(post?.url).toBe(`${BASE}/rest/api/3/issue/PROJ-1/comment`);
    expect(post?.method).toBe('POST');
    expect(post?.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(post?.body)) as { body: { type: string } };
    expect(body.body.type).toBe('doc');
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('shot.png');
    expect(serialized).toContain('missing.png');
    expect(serialized).toContain('could not be attached');
  });

  it('still posts the comment when the attachment upload fails', async () => {
    const { calls, fetchFn } = fakeFetch((call) =>
      call.url.endsWith('/attachments') ? json({ errorMessages: ['too large'] }, 413) : json({ id: '1' }, 201),
    );
    const readFile = async () => Buffer.from('x');
    await new JiraTicketCommenter(client(fetchFn), { readFile }).comment('PROJ-1', {
      ...comment,
      attachments: ['/out/shot.png'],
    });
    expect(calls.map((call) => call.url.split('/').pop())).toEqual(['attachments', 'comment']);
    expect(String(calls[1]?.body)).toContain('could not be attached');
  });

  it('propagates a failure to post the comment', async () => {
    const { fetchFn } = fakeFetch(() => json({}, 500));
    await expect(
      new JiraTicketCommenter(client(fetchFn)).comment('PROJ-1', { ...comment, attachments: [] }),
    ).rejects.toBeInstanceOf(JiraError);
  });
});
