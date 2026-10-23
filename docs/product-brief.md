# Product Brief

## Identity

- Product name: ZSkills
- Repository name: zskills
- Product family: Z Studio
- Interface: browser-based web app
- Service platforms: macOS and Linux
- Distribution direction: open source and self-hosted

## Purpose

Make it easier to visually inspect individual Agent Skills, understand their
contents, and learn from their design. The owner's immediate goal is to develop
Skill expertise through reading and analysis.

## Confirmed direction

- Build a local web service with a browser interface.
- Let the service read Skills on its host, including Skills spread across
  personal, project, and tool-managed folders.
- Allow the same service to run directly on a remote machine and expose its
  browser interface through a configured network endpoint.
- Retain SSH-based remote access, with port forwarding as one supported design
  option. Whether one instance also reads additional hosts directly over SSH
  remains an architecture decision.
- Prioritize understanding and learning from Skill content.
- Develop the project as open-source software; license selection and public
  repository publication are separate pending decisions.

## Deployment model

The browser presents the interface. The service discovers and reads Skill files
on its host and returns their content and metadata to the browser.

For local use, both browser and service run on the user's computer. For remote
use, the service runs on the remote machine while the browser can run elsewhere.
The browser only sees files made available by the connected service; connecting
to a remote instance does not scan the browser computer's filesystem.

Bind to loopback by default. Remote access can use an SSH tunnel; a directly
reachable network endpoint needs explicit listener configuration, authentication,
and a protected connection such as HTTPS. Merely opening a port does not provide
access control. No service or network listener has been implemented yet.

## Open product decisions

The following ideas are discussion topics, not committed features:

- Reading layout, navigation, search, and filtering.
- Visual representations of file structure, references, and workflow stages.
- Explanations, translation, annotations, and study notes.
- Comparing related Skills or different versions of a Skill.
- Editing, copying, installing, or evaluating Skills.
- AI-assisted analysis, model providers, and cost controls.
- Open-source license, packaging, public repository, and commercial model.
- Single-instance and multi-instance navigation, and direct SSH file browsing.

## Technical direction to evaluate

The local web-service direction replaces the earlier macOS-only app proposal.
Select a backend runtime and browser UI framework after the core reading
experience is defined. Evaluate a single startup command that serves both the
interface and API. Packaging, persistence, authentication, and remote access
details remain to be selected before implementation.

## Analysis principles

- Keep original Skill files available as the reference for explanations.
- Distinguish source content, inferred interpretation, and observed execution.
- Distinguish files present on disk from Skills enabled or exposed by an Agent.
- Keep scanning and previewing free of Skill execution or source modification.
- Treat the source machine and file path as part of a Skill's identity.
