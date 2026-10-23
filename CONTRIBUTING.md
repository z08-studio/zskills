# Contributing

Thank you for helping improve ZSkills. Open an issue to discuss a bug or a
proposed feature, or submit a pull request with a focused change.

## Local development

Use Node.js 24 or later. Install dependencies with `npm ci`, then run
`npm run dev`. Read [AGENTS.md](AGENTS.md) for repository conventions and the
[product brief](docs/product-brief.md) for confirmed requirements and open
decisions.

Use a feature branch and keep tracked source, comments, documentation, and pull
request metadata in English. Preserve user-entered content in its original
language.

Before submitting a pull request, run:

```sh
npm run format:check
npm run typecheck
npm test
npm run build
git diff --check
```

Describe the problem, resulting behavior, and validation in the pull request.
Add meaningful tests for behavior changes where appropriate.

## Skill data and service boundaries

Scanning and previewing must never execute a Skill's instructions or scripts or
modify its source files. Keep local service listeners bound to loopback by
default.

Use small, sanitized examples in issues, screenshots, and tests. Do not submit
private Skill content, credentials, personal filesystem paths, or local
configuration.

## License

Contributions are provided under the project's [MIT License](LICENSE).
