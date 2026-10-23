# Product Brief

## Identity

- Product name: ZSkills
- Repository name: zskills
- Product family: Z08 Studio
- Interface: browser-based web app
- Service platforms: macOS and Linux
- Distribution direction: open source and self-hosted
- Repository: https://github.com/z08-studio/zskills
- License: MIT

## Purpose

Make it easier to visually inspect individual Agent Skills, understand their
contents, and learn from their design. The owner's immediate goal is to develop
Skill expertise through reading and analysis.

## Confirmed direction

- Build a local web service with a browser interface.
- Let the service read Skills on its host, including Skills spread across
  personal, project, and tool-managed folders.
- Let users add scan folders and inspect coverage; do not equate a successful
  scan with discovery of every Skill on the filesystem.
- Use a compact, editor-style workbench with normal sans-serif typography.
- Show all discovered Skills in a searchable left sidebar. Show a host and scan
  overview in the main area until the user opens Skills or files in tabs.
- Organize the explorer by actual source folders, including collapsible package
  and version directories. Search preserves the matching folder hierarchy.
- Label directory-based source filters as User directories and Plugin packages;
  these labels describe discovery locations, not authorship or enablement.
- Support multiple reading tabs so users can retain context while switching
  between files and Skills.
- Hand a Skill folder or the current file to an external editor on the service
  computer. Offer system default, VS Code, and Zed preferences; users save there
  and explicitly reload the content in ZSkills.
- Allow the same service to run on a remote machine. Support browser access
  through SSH port forwarding. Direct network endpoints and reading additional
  hosts over SSH remain future architecture decisions.
- Prioritize understanding and learning from Skill content.
- Publish the project as open-source software under the MIT License in the
  Z08 Studio GitHub organization.

## Deployment model

The browser presents the interface. The service discovers and reads Skill files
on its host and returns their content and metadata to the browser.

For local use, both browser and service run on the user's computer. For remote
use, the service runs on the remote machine while the browser can run elsewhere.
The browser only sees files made available by the connected service; connecting
to a remote instance does not scan the browser computer's filesystem.

The first implementation binds to `127.0.0.1:4173` and serves both the UI and API.
It does not provide a public listener or application authentication. Remote
access uses an SSH tunnel. A future directly reachable network endpoint would
need explicit configuration, authentication, and a protected connection such as
HTTPS. Merely opening a port does not provide access control.

External-editor handoff always targets the service computer, including for
remote instances. The browser does not launch its own local editor for a remote
file. A host without a suitable desktop/editor cannot complete this handoff.

## First implementation

- React and TypeScript provide the browser workbench; Vite builds the UI.
- A Node.js/Express service discovers Skills and provides read-only file
  previews. Reading a Skill never executes its instructions or scripts.
- Default scan roots cover common personal, project, and Codex plugin-cache
  locations. Users can add custom folders and inspect each root's scan status.
- Host identity and canonical source paths distinguish Skills with the same name
  in different locations. Disk discovery does not imply agent enablement.
- Scan-folder and editor preferences persist in `~/.config/zskills`, with
  `ZSKILLS_CONFIG_DIR` available to override that directory.
- Content refresh is explicit. Automatic filesystem watching is not part of this
  first implementation.
- The interface is the working prototype for review and iterative adjustment in
  Codex Explorer. The implementation does not turn every earlier wireframe idea
  into a committed feature.

## Open product decisions

The following ideas are discussion topics, not committed features:

- Visual representations of file structure, references, and workflow stages.
- Explanations, translation, annotations, and study notes.
- Comparing related Skills or different versions of a Skill.
- In-browser editing, copying, installing, running, or evaluating Skills.
- AI-assisted analysis, model providers, and cost controls.
- Distribution packaging and commercial model.
- Single-instance and multi-instance navigation, and direct SSH file browsing.

## Technical decisions still to evaluate

The local web-service direction replaces the earlier macOS-only app proposal.
Packaging, authentication for any future public listener, multi-instance
navigation, and direct SSH file browsing remain open. The first version's local
preferences and SSH port forwarding do not settle those broader questions.

## Analysis principles

- Keep original Skill files available as the reference for explanations.
- Distinguish source content, inferred interpretation, and observed execution.
- Distinguish files present on disk from Skills enabled or exposed by an Agent.
- Keep scanning and previewing free of Skill execution or source modification.
- Treat the source machine and file path as part of a Skill's identity.
