# docs.d

New content for the shared docs goes here, one file per change, instead of
straight into the doc.

When every PR added its lines to `ROADMAP.md`, `ARCHITECTURE_ESSENTIALS.md`
and the other shared docs, most PRs inserted text at the same few places, so
each merge put the other open PRs into conflict. A new file per PR never
collides with anyone else's. A maintainer folds the fragments into the docs
in batches.

The shared docs are listed in [`config.json`](config.json). For this repo:
`ROADMAP.md`, `ARCHITECTURE_ESSENTIALS.md`, `README.md` and
`docs/threat-model.md`.

## The rule

In a shared doc, **change existing lines in place, but don't add new ones**.
CI fails a PR whose diff adds lines to a shared doc.

- Ticking your item's checkbox (`- [ ]` → `- [x]`) or correcting a line is
  fine: that's an in-place change.
- A new roadmap item, paragraph, table row, API listing line or section goes
  in a fragment.
- Changelog entries still go in [`changelog.d/`](../changelog.d/README.md),
  and contract changes in [`contract-changes.d/`](../contract-changes.d/README.md).

## Writing a fragment

Create `docs.d/<issue-number>-<short-slug>.md` (add `-2`, `-3` for more than
one). Each fragment adds one block of text to one place in one doc. Start it
with a front matter block naming the doc and where the text goes, then write
the text exactly as it should appear.

**Under a heading** (`section:`), for example a new roadmap item:

```markdown
---
file: ROADMAP.md
section: Phase E5 — Contract features
---
- [x] Escrow memo field (issue #321): optional 64-byte memo stored with the
  escrow and returned by `get_escrow`.
```

- The text goes at the end of that heading's own text, before its first
  subheading. If your text starts with its own heading (`### …`), it goes at
  the end of the whole section instead, after the existing subsections.
- Headings are matched without the `#`s, ignoring case and backticks. If the
  same heading appears twice, name its parent too:
  `section: Parent heading > Repeated heading`.
- List items and table rows join the list or table they follow; anything else
  is separated by a blank line.

**After a specific line** (`after:`), for example a line in a code block:

```markdown
---
file: ARCHITECTURE_ESSENTIALS.md
after: "client.feeBump(signedXdr, sponsor"
---
client.memo(escrowId); // string | undefined
```

- `after:` is any text that appears on exactly one line of the doc. Quote
  enough of the line to make it unique. CI tells you if it matches no line or
  more than one.
- Inside a fenced code block, your lines are inserted exactly as written.

Several fragments may target the same place; they go in filename order.

CI (`Docs fragments`) checks that your fragments fold cleanly against the
current docs. A problem in a fragment (a heading that doesn't exist, an
`after:` line that matches twice, missing front matter) is a **warning** with a
suggested fix, shown on the PR's Files tab: it doesn't block your PR, and a
maintainer can correct it when folding, though fixing it yourself helps. Only
adding new lines straight to a shared doc fails the check. To check locally:

```bash
node scripts/docs-fragments.mjs check origin/main
```

## Folding (maintainers)

```bash
node scripts/docs-fragments.mjs fold --dry-run   # preview
node scripts/docs-fragments.mjs fold             # apply and delete the fragments
```

Commit the result in its own PR, together with the `changelog.d/` fold if one
is due. Maintainer PRs skip the "no new lines" rule (CI passes `--maintainer`
when the PR's branch is in this repo rather than a fork, or its author is an
org owner or public member), and for them fragment problems are errors, so
fix every fragment warning before folding.
