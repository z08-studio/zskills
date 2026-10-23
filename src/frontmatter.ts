export function stripFrontmatter(content: string): string {
  return content.replace(
    /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
    '',
  );
}
