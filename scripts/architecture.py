#!/usr/bin/env python3
"""Keep ARCHITECTURE.md factual inventory fresh and detect unreviewed source drift.

No network, credentials, build outputs, or user data are read. `--refresh` updates
facts only; `--reviewed` records that a person/agent also checked the prose.
Public CI deliberately checks only files shipped in the clean public tree.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "ARCHITECTURE.md"
BEGIN = "<!-- architecture:generated:start -->"
END = "<!-- architecture:generated:end -->"
REVIEW = re.compile(r"<!-- architecture:reviewed\n(.*?)\n-->", re.S)
SCOPES = {
    "public": ["lirrly", "crates", "site", ".github", "scripts", "docs/adr"],
    "private": ["lirrly-lite", "insights", "docs/appstore"],
}
EXTENSIONS = {".ts", ".tsx", ".js", ".css", ".html", ".rs", ".toml",
              ".json", ".lock", ".plist", ".entitlements", ".py", ".sh",
              ".yml", ".yaml", ".service", ".md"}
EXCLUDE = {"node_modules", "target", "dist", "gen", "__pycache__", ".git",
           ".venv", "venv", "reports", ".vscode", "icons", "img", "fonts"}


def files(scope: str) -> dict[str, str]:
    prefixes = SCOPES["public"] + (SCOPES["private"] if scope == "full" else [])
    result = {}
    for prefix in prefixes:
        for directory, children, names in os.walk(ROOT / prefix, followlinks=False):
            children[:] = sorted(c for c in children if c not in EXCLUDE
                                 and not (Path(directory) / c).is_symlink())
            for name in sorted(names):
                path = Path(directory) / name
                rel = path.relative_to(ROOT)
                if not path.is_file() or path.is_symlink():
                    continue
                if path.suffix not in EXTENSIONS and path.name not in {"CNAME", "requirements.txt", "robots.txt", "llms.txt"}:
                    continue
                result[rel.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    for name in ["AGENTS.md", "CONTRIBUTING.md", "LICENSE", ".gitignore", "docs/RELEASE.md"]:
        path = ROOT / name
        if path.is_file():
            result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(sorted(result.items()))


# --- IPC contract ----------------------------------------------------------
# Tauri resolves command arguments by exact key match and `#[tauri::command]`
# defaults to rename_all = "camelCase", so a snake_case key in `invoke()` fails
# the whole call at runtime with "missing required key". Nothing in the type
# system or the unit tests sees that boundary, and it silently broke full-app
# dictation in every release up to 0.4.1. This check compares every literal
# `invoke()` payload against the Rust signature it targets.
RUST_COMMAND = re.compile(
    r"#\[tauri::command(?:\(([^)]*)\))?\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\((.*?)\)\s*(?:->|\{)", re.S)
INJECTED = ("AppHandle", "State<", "Window", "WebviewWindow")


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(w[:1].upper() + w[1:] for w in rest)


def rust_commands(app: str) -> dict[str, dict[str, bool]]:
    """command name -> {expected wire key: is_optional}."""
    src = ROOT / app / "src-tauri/src/lib.rs"
    if not src.exists():
        return {}
    commands = {}
    for attr, name, raw in RUST_COMMAND.findall(src.read_text()):
        snake = "snake_case" in (attr or "")
        args = {}
        for arg in re.split(r",(?![^<>]*>)", raw):
            arg = arg.strip()
            if not arg or any(tok in arg for tok in INJECTED):
                continue
            ident = arg.split(":")[0].strip()
            args[ident if snake else camel(ident)] = "Option<" in arg
        commands[name] = args
    return commands


def blank_comments(text: str) -> str:
    """Replace comment bodies with spaces, preserving length and line numbers.

    Comments are blanked rather than removed so byte offsets and reported line
    numbers still refer to the real file. A backtick or apostrophe inside a
    comment would otherwise be read as the start of a string literal.
    """
    out, i, n = list(text), 0, len(text)
    # A `/` starts a regex literal (not a division) when the previous
    # significant character cannot end an expression.
    before_regex = set("(,=:[!&|?{};+-*%~^<>") | {""}
    while i < n:
        char = text[i]
        if char in "\"'`":
            quote, i = char, i + 1
            while i < n and text[i] != quote:
                i += 2 if text[i] == "\\" else 1
            i += 1
        elif char == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                out[i] = " "
                i += 1
        elif char == "/" and i + 1 < n and text[i + 1] == "*":
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                if text[i] != "\n":
                    out[i] = " "
                i += 1
            out[i] = out[i + 1] = " "
            i += 2
        elif char == "/":
            previous = next((c for c in reversed(text[:i]) if not c.isspace()), "")
            if previous in before_regex:                # regex literal: skip whole
                i += 1
                while i < n and text[i] != "/":
                    i += 2 if text[i] == "\\" else (2 if text[i] == "[" else 1)
                i += 1
            else:
                i += 1
        else:
            i += 1
    return "".join(out)


def object_literal(text: str, index: int) -> str | None:
    """The balanced {...} starting at or just after `index`, if there is one."""
    while index < len(text) and text[index] in " \t\r\n,":
        index += 1
    if index >= len(text) or text[index] != "{":
        return None
    depth = 0
    for cursor in range(index, len(text)):
        if text[cursor] == "{":
            depth += 1
        elif text[cursor] == "}":
            depth -= 1
            if depth == 0:
                return text[index:cursor + 1]
    return None


def literal_keys(obj: str) -> list[str]:
    """Top-level keys of an object literal, ignoring nested objects and strings."""
    body, keys, depth, token, expecting, i = obj[1:-1], [], 0, "", True, 0
    while i < len(body):
        char = body[i]
        if char in "\"'`":
            quote, i = char, i + 1
            while i < len(body) and body[i] != quote:
                i += 2 if body[i] == "\\" else 1
            i, expecting, token = i + 1, False, ""
            continue
        if char in "{[(":
            depth += 1
        elif char in "}])":
            depth -= 1
        if depth == 0:
            if char == ",":
                if expecting and token.strip():
                    keys.append(token.strip())          # shorthand `{ audioB64, ... }`
                expecting, token = True, ""
                i += 1
                continue
            if char == ":":
                if expecting and token.strip():
                    keys.append(token.strip())
                expecting, token = False, ""
                i += 1
                continue
            if expecting and (char.isalnum() or char in "_$"):
                token += char
            elif expecting and char not in " \t\r\n":
                token = ""
        i += 1
    if expecting and token.strip():
        keys.append(token.strip())
    return sorted(set(keys))


def ipc_contract_errors(scope: str) -> list[str]:
    apps = ["lirrly"] + (["lirrly-lite"] if scope == "full" else [])
    problems = []
    for app in apps:
        commands = rust_commands(app)
        root = ROOT / app / "src"
        if not commands or not root.is_dir():
            continue
        for path in sorted(root.rglob("*")):
            if path.suffix not in {".ts", ".tsx"} or path.name.endswith(".test.ts"):
                continue
            text = blank_comments(path.read_text())
            rel = path.relative_to(ROOT).as_posix()
            for match in re.finditer(r'invoke(?:<[^>]*>)?\(\s*"(\w+)"', text):
                command = match.group(1)
                line = text[:match.start()].count("\n") + 1
                if command not in commands:
                    problems.append(f"{rel}:{line} invoke(\"{command}\") has no {app} Rust command")
                    continue
                obj = object_literal(text, text.index('"' + command + '"', match.start()) + len(command) + 2)
                if obj is None:
                    continue  # arguments come from a variable; not statically checkable
                sent, expected = set(literal_keys(obj)), commands[command]
                unexpected = sorted(sent - set(expected))
                missing = sorted(k for k, optional in expected.items() if k not in sent and not optional)
                if unexpected:
                    problems.append(
                        f"{rel}:{line} invoke(\"{command}\") sends {unexpected} — Rust reads {sorted(expected)}")
                if missing:
                    problems.append(
                        f"{rel}:{line} invoke(\"{command}\") omits required {missing}")
    return problems


def public_part(snapshot: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in snapshot.items()
            if not any(k.startswith(p + "/") for p in SCOPES["private"])}


def inventory() -> str:
    out = [BEGIN, "", "## Source-derived inventory", "",
           "Generated by `python3 scripts/architecture.py --refresh`. This section describes files on disk, not deployed acceptance.", "",
           "| Product | Package version | Bundle identifier | Windows |", "|---|---|---|---|"]
    for app in ["lirrly", "lirrly-lite"]:
        config = ROOT / app / "src-tauri/tauri.conf.json"
        if not config.exists():
            continue
        data = json.loads(config.read_text())
        windows = ", ".join(w["label"] for w in data["app"]["windows"])
        out.append(f"| {data['productName']} | {data['version']} | `{data['identifier']}` | {windows} |")
    out.extend(["", "### Native commands", "", "Argument names below are the Rust declarations; Tauri's default JavaScript wire keys are camelCase. `--check` verifies every literal `invoke()` payload against these signatures.", ""])
    for app in ["lirrly", "lirrly-lite"]:
        src = ROOT / app / "src-tauri/src/lib.rs"
        if not src.exists():
            continue
        commands = re.findall(r"#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\((.*?)\)\s*(?:->|\{)", src.read_text(), re.S)
        out.append(f"**{app}** ({len(commands)} commands)")
        out.append("")
        for name, args in commands:
            args = " ".join(args.split()).rstrip(",")
            out.append(f"- `{name}({args})`")
        out.append("")
    out.extend(["### Maintained source and configuration map", "",
                "All paths below participate in the drift check. Images/fonts are inventoried by directory in the prose; their binary contents are excluded.", ""])
    for path in files("full"):
        out.append(f"- [{path}]({path})")
    out.extend(["", END])
    return "\n".join(out)


def replace_inventory(text: str) -> str:
    start, end = text.index(BEGIN), text.index(END) + len(END)
    return text[:start] + inventory() + text[end:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--refresh", action="store_true")
    mode.add_argument("--reviewed", action="store_true")
    parser.add_argument("--scope", choices=["full", "public"], default="full")
    args = parser.parse_args()
    if not DOC.exists():
        print("Missing canonical ARCHITECTURE.md", file=sys.stderr)
        return 1
    text = DOC.read_text()
    try:
        updated = text if args.check and args.scope == "public" else replace_inventory(text)
        match = REVIEW.search(text)
        reviewed = json.loads(match.group(1)) if match else {}
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"Invalid architecture structure: {exc}", file=sys.stderr)
        return 1
    current = files(args.scope)
    baseline = public_part(reviewed) if args.scope == "public" else reviewed
    if args.check:
        changed = [p for p in sorted(set(current) | set(baseline)) if current.get(p) != baseline.get(p)]
        # Public cuts intentionally omit private source; their smaller generated
        # inventory must not overwrite the canonical full-project document.
        inventory_stale = args.scope == "full" and updated != text
        ipc = ipc_contract_errors(args.scope)
        if ipc:
            print("IPC contract broken — these calls cannot reach their Rust command:")
            for problem in ipc:
                print(f"  {problem}")
        if changed or inventory_stale or ipc:
            print("ARCHITECTURE.md needs review:")
            for path in changed:
                print(f"  {path}")
            if inventory_stale:
                print("  generated inventory differs")
            print("Update the prose, run --reviewed, then --check. --refresh alone does not certify prose.")
            return 1
        print(f"Architecture current: {len(current)} {args.scope}-scope source/config files match reviewed snapshot.")
        print("IPC contract: every literal invoke() payload matches its Rust command signature.")
        return 0
    if args.scope != "full":
        print("Refresh/review require the complete private workspace (--scope full).", file=sys.stderr)
        return 1
    if not all((ROOT / p).is_dir() for p in SCOPES["private"]):
        print("Full workspace required: private components are missing.", file=sys.stderr)
        return 1
    if args.reviewed:
        stamp = "<!-- architecture:reviewed\n" + json.dumps(current, indent=2, sort_keys=True) + "\n-->"
        updated = REVIEW.sub(lambda _: stamp, updated) if REVIEW.search(updated) else updated.rstrip() + "\n\n" + stamp + "\n"
    DOC.write_text(updated)
    print("Architecture inventory refreshed" + (" and source review recorded." if args.reviewed else "; prose review remains required if source changed."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
