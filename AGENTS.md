# Repository Guidance

## Product context

ZSkills is an open-source, self-hosted web app in the Z Studio family. It
helps users visually read, explore, and learn from Agent Skills. A service on
macOS or Linux reads Skills on its host and provides a browser interface. The
same service can run on remote machines, with SSH-based access also in scope.

Read `docs/product-brief.md` before making product or architecture decisions.
Keep confirmed requirements separate from proposed features.

## Working conventions

- Keep tracked source code, comments, documentation, fixtures, commit messages,
  and pull request metadata in English. Preserve user-entered content and the
  user's preferred conversation language.
- Start changes by checking `git status`. Preserve unrelated work.
- Use feature branches for implementation work. When a GitHub remote is
  configured, push the working branch and open a pull request after branch work;
  do not push directly to `main` unless the user explicitly requests it.
- Run validation appropriate to the change and `git diff --check`. Rebuild the
  app after code changes when practical.
- Scanning or previewing a Skill must not execute its instructions or scripts,
  or modify its source files.
- Keep explanations traceable to their source and label inferred behavior.
- Default service listeners to loopback. Treat network exposure as an explicit
  configuration that requires authentication and a protected connection.
