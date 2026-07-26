---
description: "Use when writing or updating project portfolio README files, project entries in src/data/projects.json, or the skill taxonomy in src/data/skills.json. Covers README structure, screenshots, skill tags, canonical skill names, and metadata synchronization."
applyTo:
  - "src/data/projects/**/README.md"
  - "src/data/projects.json"
  - "src/data/skills.json"
---

# Project Content And Skill Metadata

Use these rules when updating portfolio project summaries, project metadata, or the shared skill taxonomy.

## Project README structure

- Keep project READMEs concise and portfolio-oriented, not full product manuals.
- Start with primary calls to action such as `<github>`, `<website>`, or download buttons when they exist.
- Follow with one `<highlight>` box that gives short personal or project context. Inside it, mention the **most important skills** with inline `<skill>` tags so a reader immediately knows the core technologies at a glance. Prefer a structure like:
  ```
  <highlight title="Personal note" shadow>
  A brief sentence or two about personal motivation or project context.
  It's written in <skill>Language</skill> and uses <skill>Framework</skill> for the …
  </highlight>
  ```
- After the highlight, summarize the project in plain language and then move quickly to the concrete technical stack.
- Prefer a recognizable structure taken from the stronger project pages in this repo: short intro, tech-stack section, key technical highlights, then screenshots or videos.
- For technically rich projects, prefer grouped stack sections over long prose paragraphs.

## README content focus

- Focus on what was actually built and which technologies matter architecturally.
- Mention the relevant skills inline with `<skill>...</skill>` tags when they are central to the project.
- Do not turn the README into exhaustive internal documentation; deep architecture and operations detail belongs in dedicated docs like the ERP docs section.
- Keep feature descriptions concrete. Prefer statements like "uses Kafka for domain events" over generic claims like "scalable messaging".

## Screenshots and media

- If screenshots or videos already exist in the project folder, prefer integrating them instead of describing the UI abstractly.
- Place media near the paragraph that explains its technical relevance.
- For images stored next to the README, use relative paths such as `./screenshot.jpg`.
- Use clear `alt` text and explicit widths so the project page remains tidy.
- Use videos for motion-heavy interactions and screenshots for architecture, dashboards, forms, and admin views.

## projects.json rules

- Keep `description` short and card-friendly. It should explain the real project, not copy placeholder text from another entry.
- The `skills` list in `src/data/projects.json` should be balanced and public-facing. Do not dump every library or transitive dependency into project badges.
- Choose enough skills to represent the major layers of the system: language, backend or frontend framework, persistence, messaging, platform, and observability when relevant.
- For larger systems, around 12 to 18 skills is a good upper bound unless there is a strong reason to exceed it.

## skills.json rules

- Every skill used in a project entry should exist verbatim in `src/data/skills.json`.
- Prefer existing canonical labels when possible. Do not create near-duplicates such as `Entity Framework Core` if the shared taxonomy already uses `EF Core`.
- Add language or framework skills to the closest matching language or frontend group.
- Add cloud, container, messaging, observability, and deployment skills to the DevOps group unless the repo already has a better established grouping.
- Keep ordering intentional because the project filter UI and badge color mapping depend on group order.

## Synchronization rules

- If you introduce a new skill in a README and expect it to appear as a project badge or filter, add it to `src/data/skills.json` first.
- If you revise a project significantly, review all three surfaces together: the project README, the `projects.json` entry, and `skills.json`.
- Validate exact string matches after edits. Badge styling and skill ordering depend on exact label equality.

## ERP Demo example

- ERP Demo is a good reference for a technically dense project summary.
- Keep the README focused on the stack and the role of each layer.
- Use the screenshots to connect visible product surfaces with the backend, messaging, database, and observability tooling behind them.
- Keep the project card skill list balanced even though the underlying implementation uses more technologies than the card can reasonably display.