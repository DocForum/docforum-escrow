#!/usr/bin/env python3
"""Unit tests for contract interface snapshot, append-only error code check, and change classifier."""
import json
import pytest
from pathlib import Path

# Import functions from scripts
import importlib.util

scripts_dir = Path(__file__).resolve().parent

spec_check = importlib.util.spec_from_file_location("check_interface", scripts_dir / "check-contract-interface.py")
check_interface = importlib.util.module_from_spec(spec_check)
spec_check.loader.exec_module(check_interface)

spec_classify = importlib.util.spec_from_file_location("classify_changes", scripts_dir / "classify-contract-changes.py")
classify_mod = importlib.util.module_from_spec(spec_classify)
spec_classify.loader.exec_module(classify_mod)


def test_doc_comments_do_not_affect_spec():
    raw_code = """
    pub fn test_fn(
        env: Env,
        /// This is a doc comment on an argument
        payer: Address,
        // Regular line comment
        amount: i128,
    ) -> Result<u64, Error> {
        // Body comment
    }
    """
    clean1 = check_interface.re.sub(r"/\*[\s\S]*?\*/", "", raw_code)
    clean1 = check_interface.re.sub(r"//.*$", "", clean1, flags=check_interface.re.MULTILINE)

    raw_code_modified_docs = """
    pub fn test_fn(
        env: Env,
        /// MODIFIED doc comment on an argument that should have no effect
        payer: Address,
        /* block comment */
        amount: i128,
    ) -> Result<u64, Error> {
    }
    """
    clean2 = check_interface.re.sub(r"/\*[\s\S]*?\*/", "", raw_code_modified_docs)
    clean2 = check_interface.re.sub(r"//.*$", "", clean2, flags=check_interface.re.MULTILINE)

    def parse_fns(src):
        fns = []
        for m in check_interface.re.finditer(r"pub\s+fn\s+([A-Za-z0-9_]+)\s*\((.*?)\)(?:\s*->\s*([^\{]+))?", src, check_interface.re.S):
            args = " ".join(m.group(2).split())
            ret = " ".join((m.group(3) or "").split())
            fns.append({"name": m.group(1), "args": args, "return": ret})
        return fns

    assert parse_fns(clean1) == parse_fns(clean2)


def test_append_only_catches_renumbered_error(monkeypatch):
    base_spec = {
        "errors": [
            {"name": "NotFound", "code": 1},
            {"name": "InvalidAmount", "code": 2},
        ]
    }
    curr_spec = {
        "errors": [
            {"name": "NotFound", "code": 999},  # Renumbered!
            {"name": "InvalidAmount", "code": 2},
        ]
    }
    monkeypatch.setattr(check_interface, "get_base_spec", lambda ref: base_spec)
    monkeypatch.setattr(check_interface, "resolve_base_ref", lambda ref: "mock-base")

    with pytest.raises(SystemExit):
        check_interface.assert_append_only(curr_spec, "mock-base")


def test_append_only_catches_removed_error(monkeypatch):
    base_spec = {
        "errors": [
            {"name": "NotFound", "code": 1},
            {"name": "InvalidAmount", "code": 2},
        ]
    }
    curr_spec = {
        "errors": [
            {"name": "NotFound", "code": 1},
            # InvalidAmount removed!
        ]
    }
    monkeypatch.setattr(check_interface, "get_base_spec", lambda ref: base_spec)
    monkeypatch.setattr(check_interface, "resolve_base_ref", lambda ref: "mock-base")

    with pytest.raises(SystemExit):
        check_interface.assert_append_only(curr_spec, "mock-base")


def test_append_only_catches_reused_code(monkeypatch):
    base_spec = {
        "errors": [
            {"name": "NotFound", "code": 1},
        ]
    }
    curr_spec = {
        "errors": [
            {"name": "SomeOtherError", "code": 1},  # Reused code 1!
        ]
    }
    monkeypatch.setattr(check_interface, "get_base_spec", lambda ref: base_spec)
    monkeypatch.setattr(check_interface, "resolve_base_ref", lambda ref: "mock-base")

    with pytest.raises(SystemExit):
        check_interface.assert_append_only(curr_spec, "mock-base")


def test_append_only_allows_appended_errors(monkeypatch):
    base_spec = {
        "errors": [
            {"name": "NotFound", "code": 1},
        ]
    }
    curr_spec = {
        "errors": [
            {"name": "NotFound", "code": 1},
            {"name": "NewError", "code": 2},
        ]
    }
    monkeypatch.setattr(check_interface, "get_base_spec", lambda ref: base_spec)
    monkeypatch.setattr(check_interface, "resolve_base_ref", lambda ref: "mock-base")

    # Should not raise
    check_interface.assert_append_only(curr_spec, "mock-base")


def test_classify_detects_breaking_function_change():
    base_spec = {
        "functions": [
            {"name": "create_escrow", "args": "env: Env, payer: Address", "return": "Result<u64, Error>"},
        ],
        "errors": []
    }
    # 1. Removed function
    curr_removed = {"functions": [], "errors": []}
    breaking, additive = classify_mod.classify_changes(base_spec, curr_removed)
    assert len(breaking) == 1
    assert "Function 'create_escrow' was removed" in breaking[0]

    # 2. Changed args
    curr_changed_args = {
        "functions": [
            {"name": "create_escrow", "args": "env: Env, payer: Address, new_arg: bool", "return": "Result<u64, Error>"},
        ],
        "errors": []
    }
    breaking, additive = classify_mod.classify_changes(base_spec, curr_changed_args)
    assert len(breaking) == 1
    assert "arguments changed" in breaking[0]

    # 3. Changed return
    curr_changed_ret = {
        "functions": [
            {"name": "create_escrow", "args": "env: Env, payer: Address", "return": "Result<u128, Error>"},
        ],
        "errors": []
    }
    breaking, additive = classify_mod.classify_changes(base_spec, curr_changed_ret)
    assert len(breaking) == 1
    assert "return type changed" in breaking[0]


def test_classify_detects_additive_changes():
    base_spec = {
        "functions": [
            {"name": "create_escrow", "args": "env: Env", "return": ""},
        ],
        "errors": [{"name": "NotFound", "code": 1}]
    }
    curr_spec = {
        "functions": [
            {"name": "create_escrow", "args": "env: Env", "return": ""},
            {"name": "new_helper_fn", "args": "env: Env", "return": ""},
        ],
        "errors": [
            {"name": "NotFound", "code": 1},
            {"name": "NewError", "code": 2},
        ]
    }
    breaking, additive = classify_mod.classify_changes(base_spec, curr_spec)
    assert len(breaking) == 0
    assert len(additive) == 2
    assert "New function 'new_helper_fn' added" in additive[0]
    assert "New error variant 'NewError' (= 2) added" in additive[1]
