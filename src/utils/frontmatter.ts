import { parse as parseYaml } from 'yaml';

export interface ParsedFrontMatter {
  data: Record<string, unknown>;
  content: string;
}

/** Parse optional YAML front matter from Markdown without loading a plugin chain. */
export function parseFrontMatter(source: string): ParsedFrontMatter {
  if (!source.startsWith('---')) return { data: {}, content: source };
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (!opening) return { data: {}, content: source };

  const remainder = source.slice(opening[0].length);
  const closing = /^---[ \t]*\r?$/m.exec(remainder);
  if (!closing || closing.index === undefined) return { data: {}, content: source };

  const parsed: unknown = parseYaml(remainder.slice(0, closing.index), { maxAliasCount: 50 });
  const data =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const bodyStart = closing.index + closing[0].length;
  return { data, content: remainder.slice(bodyStart).replace(/^\r?\n/, '') };
}
