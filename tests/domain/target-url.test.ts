import { describe, expect, it } from 'vitest';
import { joinTargetUrl, offTargetOrigin } from '../../src/domain/target-url.js';

describe('joinTargetUrl', () => {
  it.each([
    ['https://shop.example.com', '/x', 'https://shop.example.com/x'],
    ['https://shop.example.com/', '/x?page=2#top', 'https://shop.example.com/x?page=2#top'],
    ['https://h.example.com/app', '/x', 'https://h.example.com/app/x'],
    ['https://h.example.com/app/', '/x', 'https://h.example.com/app/x'],
    ['https://h.example.com/app//', '/', 'https://h.example.com/app/'],
    ['https://h.example.com/a/b?ignored=1#frag', '/c', 'https://h.example.com/a/b/c'],
    ['http://localhost:8080/app', '/products?q=1', 'http://localhost:8080/app/products?q=1'],
  ])('joins %s and %s', (base, path, expected) => {
    expect(joinTargetUrl(base, path)).toBe(expected);
  });

  it('resolves an absolute URL or a non-root path the standard way', () => {
    expect(joinTargetUrl('https://h.example.com/app', 'https://h.example.com/other')).toBe('https://h.example.com/other');
    expect(joinTargetUrl('https://h.example.com/app/', 'page')).toBe('https://h.example.com/app/page');
  });
});

describe('offTargetOrigin', () => {
  const base = 'https://shop.example.com/app';

  it('returns nothing on the target origin or a blank page', () => {
    expect(offTargetOrigin('https://shop.example.com/other/page', base)).toBeUndefined();
    expect(offTargetOrigin('about:blank', base)).toBeUndefined();
  });

  it.each([
    ['https://evil.example.net/landing', 'https://evil.example.net'],
    ['http://shop.example.com/', 'http://shop.example.com'],
    ['https://shop.example.com:8443/', 'https://shop.example.com:8443'],
    ['data:text/html,hi', 'data:'],
    ['chrome-error://chromewebdata/', 'chrome-error://chromewebdata'],
  ])('returns the foreign origin of %s', (url, origin) => {
    expect(offTargetOrigin(url, base)).toBe(origin);
  });
});
