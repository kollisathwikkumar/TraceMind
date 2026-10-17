import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadFromFilesystem } from '../filesystem';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Filesystem knowledge source front matter', () => {
  it('parses Markdown front matter and structured YAML without gray-matter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tracemind-frontmatter-'));
    directories.push(root);
    await mkdir(join(root, 'docs'));
    await writeFile(
      join(root, 'docs', 'checkout-runbook.md'),
      '---\ntype: runbook\ntitle: Checkout recovery\nservices: [checkout]\ntags: [database]\nseverity: sev2\n---\n# Recovery\nRestart safely.\n'
    );
    await writeFile(
      join(root, 'docs', 'service.yaml'),
      'type: ownership\ntitle: Checkout service\nservices: [checkout]\ntags: [platform]\n'
    );

    const documents = await loadFromFilesystem({
      type: 'filesystem',
      path: root,
      filePatterns: ['**/*.md', '**/*.yaml'],
    });
    expect(documents).toHaveLength(2);
    expect(documents.find(({ title }) => title === 'Checkout recovery')).toMatchObject({
      type: 'runbook',
      services: ['checkout'],
      tags: ['database'],
      severityRelevance: ['sev2'],
      content: '# Recovery\nRestart safely.\n',
    });
    expect(documents.find(({ title }) => title === 'Checkout service')).toMatchObject({
      type: 'ownership',
      services: ['checkout'],
      tags: ['platform'],
    });
  });
});
