/** Minimal Atlassian Document Format node shape. */
export interface AdfNode {
  type: string;
  version?: number;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

const INLINE_TYPES = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'date', 'status']);

export function isAdfNode(value: unknown): value is AdfNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function renderInline(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji': {
      const label = node.attrs?.text ?? node.attrs?.shortName;
      return typeof label === 'string' ? label : '';
    }
    case 'inlineCard': {
      const url = node.attrs?.url;
      return typeof url === 'string' ? url : '';
    }
    default: {
      if (node.content === undefined && typeof node.attrs?.text === 'string') return node.attrs.text;
      return (node.content ?? []).map(renderInline).join('');
    }
  }
}

function renderListItem(item: AdfNode, marker: string): string[] {
  const lines = (item.content ?? []).flatMap(renderBlock);
  const indent = ' '.repeat(marker.length);
  return lines.map((line, index) => (index === 0 ? `${marker}${line}` : `${indent}${line}`));
}

function renderBlock(node: AdfNode): string[] {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return renderInline(node).split('\n');
    case 'bulletList':
      return (node.content ?? []).flatMap((item) => renderListItem(item, '- '));
    case 'orderedList': {
      const start = typeof node.attrs?.order === 'number' ? node.attrs.order : 1;
      return (node.content ?? []).flatMap((item, index) => renderListItem(item, `${start + index}. `));
    }
    case 'listItem':
      return renderListItem(node, '- ');
    default: {
      // Unknown node: render inline when all children are inline, otherwise recurse into blocks.
      const children = node.content ?? [];
      if (children.every((child) => INLINE_TYPES.has(child.type))) return renderInline(node).split('\n');
      return children.flatMap(renderBlock);
    }
  }
}

/** Converts an ADF document (or any ADF node) to plain text. */
export function adfToText(node: AdfNode | null | undefined): string {
  if (!node) return '';
  return renderBlock(node).join('\n').trim();
}
