import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripFrontmatter } from './frontmatter';

test('strips metadata with horizontal whitespace after either delimiter', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const bom of ['', '\uFEFF']) {
      for (const closing of ['---', '...']) {
        for (const whitespace of ['', '  ', '\t', ' \t ']) {
          const body = `# Wallet${newline}${newline}Read the guide.${newline}---${newline}Keep this body separator.`;
          const content = [
            `${bom}---${whitespace}`,
            'name: metamask-agent-wallet',
            'description: Wallet guidance',
            `${closing}${whitespace}`,
            body,
          ].join(newline);
          assert.equal(stripFrontmatter(content), body);
        }
      }
    }
  }
});

test('strips metadata ending at the end of the document', () => {
  for (const closing of ['---', '...']) {
    assert.equal(stripFrontmatter(`--- \t\nname: wallet\n${closing}\t `), '');
  }
});

test('preserves documents without an exact opening delimiter', () => {
  for (const opening of [
    '\\---',
    '----',
    '--- metadata',
    ' ---',
    '\t---',
    '\n---',
    '\r\n---',
    '---\u00A0',
  ]) {
    const content = `${opening}\nname: wallet\n---\n# Wallet`;
    assert.equal(stripFrontmatter(content), content);
  }
});

test('preserves documents without an exact closing delimiter', () => {
  for (const closing of [
    '\\---',
    '----',
    '--- metadata',
    ' ---',
    '\t---',
    '---\u00A0',
    '....',
    '... metadata',
  ]) {
    const content = `---\nname: wallet\n${closing}\n# Wallet`;
    assert.equal(stripFrontmatter(content), content);
  }
  const unterminated = '---\nname: wallet\n# Wallet';
  assert.equal(stripFrontmatter(unterminated), unterminated);
});
