# Issue tracker: GitHub

Issues and specifications for Helm live in the GitHub repository `KG2013/Helm`. Use the `gh` CLI from the repository checkout.

## Conventions

- Create an issue with `gh issue create` and a body file for multi-line content.
- Read issues with `gh issue view <number> --comments`.
- Apply or remove labels with `gh issue edit <number> --add-label` or `--remove-label`.
- Keep pull requests out of the triage request surface.
- Represent blocking relationships with GitHub native issue dependencies when available. If native dependencies are unavailable, include a `Blocked by` reference in the issue body.

## When a skill says “publish to the issue tracker”

Create or update a GitHub issue in `KG2013/Helm` using `gh`. Apply the configured triage label required by the skill.
