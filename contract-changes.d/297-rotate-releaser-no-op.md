bump: patch
---
Issue #297: `rotate_releaser` now rejects `new_releaser == current
releaser` with `InvalidReleaser` and emits nothing, instead of writing the
same data back and publishing a misleading `rotate` event. No interface
change: the existing `InvalidReleaser` error is reused and the error
precedence is unchanged (a wrong caller still receives `Unauthorized`
first).
