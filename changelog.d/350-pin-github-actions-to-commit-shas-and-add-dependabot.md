Issue #350 (Phase E7): pinned third-party GitHub Actions to upstream release
commit SHAs with version comments, added Dependabot updates for the pinned
actions (one grouped PR a week) and the checker's PyYAML pin (monthly), and
added CI enforcement with regression tests. When the check fails it prints
how to look up a tag's commit SHA. Workflow permissions were narrowed to the
scopes required for checks, releases, attestations and nightly issue
reporting.
