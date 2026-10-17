import { describe, expect, it } from 'vitest';
import { parseFrontMatter } from './frontmatter';

describe('parseFrontMatter', () => {
  it('parses YAML metadata and preserves the Markdown body', () => {
    expect(
      parseFrontMatter('---\ntitle: Checkout\nservices: [api, worker]\n---\n# Recovery\n')
    ).toEqual({
      data: { title: 'Checkout', services: ['api', 'worker'] },
      content: '# Recovery\n',
    });
  });

  it('supports CRLF delimiters and empty front matter', () => {
    expect(parseFrontMatter('---\r\ntitle: Checkout\r\n---\r\nBody')).toEqual({
      data: { title: 'Checkout' },
      content: 'Body',
    });
    expect(parseFrontMatter('---\n---\nBody')).toEqual({ data: {}, content: 'Body' });
  });

  it('leaves text unchanged when front matter is absent or unterminated', () => {
    expect(parseFrontMatter('# Plain Markdown')).toEqual({ data: {}, content: '# Plain Markdown' });
    const unterminated = '---\ntitle: Unfinished\nBody';
    expect(parseFrontMatter(unterminated)).toEqual({ data: {}, content: unterminated });
  });

  it('rejects malformed YAML instead of silently accepting invalid metadata', () => {
    expect(() => parseFrontMatter('---\ntitle: [broken\n---\nBody')).toThrow();
  });
});
