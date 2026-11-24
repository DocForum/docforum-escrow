Issue #350 (Phase E7): pinned third-party GitHub Actions to upstream release
commit SHAs with version comments, added weekly Dependabot coverage for
GitHub Actions, npm, Cargo and Go modules, and added CI enforcement with
regression tests. The checker uses a pinned YAML parser dependency, also
covered by Dependabot. Workflow permissions were narrowed to the scopes
required for checks, releases, attestations and nightly issue reporting.
