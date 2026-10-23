# ZSkills

An open-source, self-hosted web app for visually exploring, reading, and learning
from Agent Skills.

Part of Z Studio.

## Run locally

Use Node.js 24 or later and npm. From the repository directory:

```sh
npm install
npm run dev
```

Open [ZSkills](http://127.0.0.1:4173). One local service serves the browser
interface and API. For a production build:

```sh
npm run build
npm start
```

The service listens on `127.0.0.1:4173`. This first implementation does not offer
a public network listener or application authentication.

## Explore Skills

The interface is a compact, editor-style workbench with a normal sans-serif
font. Browse Skills under their actual source folders on the left, expand a
Skill's files, and open them in tabs on the right. Nested folders can be
collapsed; single-child folder paths are compacted, and search keeps matching
Skills in their folder context. The home view shows the connected computer, scan coverage,
and source counts. File previews are read-only.

The service scans configured folders on **the computer running the service**.
Default locations include personal Skill folders for Codex, Claude Code,
Gemini, and other agents, the Codex plugin cache, and project Skill folders
relative to the directory from which the service starts. Add custom scan folders
in the interface when your Skills live elsewhere. Coverage reports distinguish
missing, unreadable, and scanned locations; the list is not a claim to have
searched the entire filesystem or to show only Skills enabled in an agent.

The **User directories** and **Plugin packages** filters describe discovery
locations. They do not identify who wrote a Skill or whether an agent enables it.

Choose the system default, VS Code, or Zed in editor settings. Use **Open in
editor** to hand a Skill folder or the current file to that editor. The editor
opens on the service computer. Save changes in the editor, then reload in ZSkills
to read the latest content. Browsing and scanning do not execute Skill
instructions or scripts and do not modify Skill source files.

Scan-folder and editor preferences are stored in `~/.config/zskills`. Set
`ZSKILLS_CONFIG_DIR` before startup to use a different configuration directory.

## Use a remote computer

Run ZSkills on the remote macOS or Linux computer and forward its local port:

```sh
ssh -N -L 4173:127.0.0.1:4173 user@remote-host
```

Open [the forwarded interface](http://127.0.0.1:4173) in your browser. It reads
the remote computer's configured folders. An external editor is launched on that
remote computer, so this action requires an available desktop/editor there.

## Development

The UI uses React, TypeScript, and Vite. A Node.js/Express service discovers
Skills and serves their files through the API.

```sh
npm run typecheck
npm test
npm run build
git diff --check
```

This first version focuses on discovery, source reading, and external-editor
handoff. Packaging and the open-source license remain open decisions.

## Project documents

- [Product brief](docs/product-brief.md): confirmed decisions and open questions.
- [Contributor guidance](AGENTS.md): working conventions for this repository.
