Restored dependency-aware contract creation after merging the release-window
changes from `main`. Dependency errors use codes 24–27 to avoid collisions
with the release-window errors, and the TypeScript bindings were regenerated
from the combined contract spec. Dependency contract tests and snapshots pass.
