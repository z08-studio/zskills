# Product Brief

## Identity

- Product name: ZSkill Lens
- Repository name: zskill-lens
- Product family: Z Studio
- Initial platform: macOS

## Purpose

Make it easier to visually inspect individual Agent Skills, understand their
contents, and learn from their design. The owner's immediate goal is to develop
Skill expertise through reading and analysis.

## Confirmed direction

- Build a macOS app.
- Browse Skills stored on the local machine, including Skills spread across
  personal and tool-managed folders.
- Support SSH connections to browse Skills on remote machines.
- Prioritize understanding and learning from Skill content.

## Open product decisions

The following ideas are discussion topics, not committed features:

- Reading layout, navigation, search, and filtering.
- Visual representations of file structure, references, and workflow stages.
- Explanations, translation, annotations, and study notes.
- Comparing related Skills or different versions of a Skill.
- Editing, copying, installing, or evaluating Skills.
- AI-assisted analysis, model providers, and cost controls.
- Distribution and commercial model.

## Technical direction to evaluate

A native SwiftUI interface with system OpenSSH was proposed during initial
discussion. Architecture, dependencies, deployment target, and project tooling
remain to be selected before implementation.

## Analysis principles

- Keep original Skill files available as the reference for explanations.
- Distinguish source content, inferred interpretation, and observed execution.
- Distinguish files present on disk from Skills enabled or exposed by an Agent.
- Keep scanning and previewing free of Skill execution or source modification.
- Treat the source machine and file path as part of a Skill's identity.
