import { describe, expect, it } from 'vitest';
import { registrableDomain, sameSite } from '../../src/domain/site.js';

describe('registrableDomain', () => {
  it.each([
    ['chupaprecios.com.mx', 'chupaprecios.com.mx'],
    ['staging.chupaprecios.com.mx', 'chupaprecios.com.mx'],
    ['WWW.Chupaprecios.com.mx', 'chupaprecios.com.mx'],
    ['shop.example.com', 'example.com'],
    // Private Public Suffix List entries are suffixes too: two GitHub Pages sites are different sites.
    ['team-a.github.io', 'team-a.github.io'],
  ])('%s → %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  it.each(['localhost', '127.0.0.1', '[::1]', 'intranet', 'x.intranet.corp'])('has none for %s', (host) => {
    expect(registrableDomain(host)).toBeUndefined();
  });
});

describe('sameSite', () => {
  const target = 'https://staging.chupaprecios.com.mx';

  it.each([
    ['https://chupaprecios.com.mx/ofertas', target],
    ['https://www.chupaprecios.com.mx/ofertas', target],
    ['https://staging.chupaprecios.com.mx/x', 'https://chupaprecios.com.mx'],
    ['http://chupaprecios.com.mx:8080/x', target],
  ])('%s is on the same site as %s', (a, b) => {
    expect(sameSite(a, b)).toBe(true);
  });

  it.each([
    ['https://chupaprecios.com/ofertas', target],
    ['https://evil-chupaprecios.com.mx/ofertas', target],
    ['https://chupaprecios.com.mx.evil.io/x', target],
    ['https://www.figma.com/file/abc', target],
    ['https://team-a.github.io/x', 'https://team-b.github.io'],
  ])('%s is not on the same site as %s', (a, b) => {
    expect(sameSite(a, b)).toBe(false);
  });

  it('compares localhost and IP addresses by exact host, port included', () => {
    expect(sameSite('http://localhost:3000/a', 'http://localhost:3000')).toBe(true);
    expect(sameSite('http://localhost:4000/a', 'http://localhost:3000')).toBe(false);
    expect(sameSite('http://127.0.0.1:3000/a', 'http://127.0.0.1:3000')).toBe(true);
    expect(sameSite('http://127.0.0.2/a', 'http://127.0.0.1')).toBe(false);
    expect(sameSite('http://localhost/a', 'http://127.0.0.1')).toBe(false);
  });

  it('is false for unparseable URLs', () => {
    expect(sameSite('not a url', target)).toBe(false);
  });
});
