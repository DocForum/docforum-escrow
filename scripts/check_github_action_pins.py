#!/usr/bin/env python3
"""Fail when a workflow uses a third-party action without an immutable pin."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Iterator

try:
    import yaml
    from yaml.nodes import MappingNode, ScalarNode, SequenceNode
except ImportError as error:  # pragma: no cover - exercised by CI environment
    raise SystemExit("PyYAML is required to validate GitHub Actions workflows") from error


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
SHA = re.compile(r"^[0-9a-fA-F]{40}$")
VERSION_COMMENT = re.compile(r"#\s*v\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)")
REMOTE_USE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/.+)?$")


def _uses_nodes(node: object) -> Iterator[tuple[ScalarNode, ScalarNode]]:
    """Yield YAML mapping key/value nodes for actual `uses` keys."""
    if isinstance(node, MappingNode):
        for key, value in node.value:
            if isinstance(key, ScalarNode) and key.value == "uses" and isinstance(value, ScalarNode):
                yield key, value
            yield from _uses_nodes(value)
    elif isinstance(node, SequenceNode):
        for value in node.value:
            yield from _uses_nodes(value)


def check_workflow(source: str, filename: str) -> list[str]:
    """Return pinning violations in one workflow YAML document."""
    try:
        root = yaml.compose(source, Loader=yaml.SafeLoader)
    except yaml.YAMLError as error:
        return [f"{filename}: invalid workflow YAML: {error}"]
    if root is None:
        return []

    lines = source.splitlines()
    errors: list[str] = []
    for _, value_node in _uses_nodes(root):
        reference = value_node.value.strip()
        line_number = value_node.start_mark.line + 1
        source_line = lines[value_node.start_mark.line]
        location = f"{filename}:{line_number}: {reference!r}"

        if reference.startswith("./"):
            continue
        if not REMOTE_USE.fullmatch(reference.rsplit("@", 1)[0]) or "@" not in reference:
            errors.append(f"{location}: expected a third-party owner/repository@<40-character-SHA> reference")
            continue

        revision = reference.rsplit("@", 1)[1]
        if not SHA.fullmatch(revision):
            errors.append(f"{location}: revision must be a full 40-character hexadecimal commit SHA")
            continue
        if not VERSION_COMMENT.search(source_line):
            errors.append(f"{location}: pinned action is missing an accurate version comment (for example, # v4.2.2)")

    return errors


PIN_HINT = """
How to fix: pin each action to the full commit SHA of a release tag and keep
the tag as a comment, for example:

    uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

To look up the SHA for a tag (annotated tags need the second command):

    gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq .object
    gh api repos/<owner>/<repo>/git/tags/<sha-from-above> --jq .object.sha

Local actions (uses: ./path) don't need a pin. Dependabot updates the pins
weekly once they're on main."""


def workflow_files(directory: Path = WORKFLOWS) -> list[Path]:
    return sorted((*directory.rglob("*.yml"), *directory.rglob("*.yaml")))


def main() -> int:
    files = workflow_files()
    errors = [error for path in files for error in check_workflow(path.read_text(), path.relative_to(ROOT).as_posix())]
    if errors:
        for error in errors:
            print(f"::error::{error}", file=sys.stderr)
        print(PIN_HINT, file=sys.stderr)
        return 1
    print(f"Verified immutable third-party action pins in {len(files)} workflow files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
