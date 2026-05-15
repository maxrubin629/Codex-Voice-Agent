#!/usr/bin/env python3
"""Non-mutating project inspection helper for Realtime orientation docs."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


SKIP_DIRS = {
    ".cache",
    ".git",
    ".gradle",
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".turbo",
    ".venv",
    ".yarn",
    "__pycache__",
    "build",
    "coverage",
    "DerivedData",
    "dist",
    "node_modules",
    "out",
    "target",
    "tmp",
    "vendor",
}

SECRET_NAMES = {
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".npmrc",
    ".pypirc",
}

SECRET_PARTS = (
    "credential",
    "credentials",
    "secret",
    "secrets",
    "token",
    "private-key",
    "private_key",
)

IMPORTANT_FILENAMES = {
    "README.md",
    "README",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "Package.swift",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    "tsconfig.json",
    "vite.config.ts",
    "vite.config.js",
    "electron.vite.config.ts",
}

IMPORTANT_RELATIVE = {
    ".codex/environments/environment.toml",
    "AGENTS.md",
    "agents.md",
}

MAX_FILES = 2500


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect a project without reading secrets or generated folders.")
    parser.add_argument("path", nargs="?", default=".", help="Project/workspace path to inspect.")
    args = parser.parse_args()

    root = Path(args.path).expanduser().resolve()
    if not root.exists():
        raise SystemExit(f"Path does not exist: {root}")
    if not root.is_dir():
        raise SystemExit(f"Path is not a directory: {root}")

    inspection = inspect_project(root)
    print(render_markdown(inspection))
    return 0


def inspect_project(root: Path) -> dict[str, Any]:
    files = discover_files(root)
    important = important_files(root, files)
    package = read_package_json(root / "package.json") if (root / "package.json").is_file() else None

    return {
        "root": str(root),
        "git_repo": (root / ".git").exists(),
        "top_level_dirs": top_level_dirs(root),
        "important_files": [str(path.relative_to(root)) for path in important],
        "package": package,
        "source_dirs": source_dirs(root),
    }


def discover_files(root: Path) -> list[Path]:
    found: list[Path] = []
    for current, dirs, files in os.walk(root):
        current_path = Path(current)
        dirs[:] = [name for name in dirs if should_descend(current_path / name)]

        for name in files:
            path = current_path / name
            if should_skip_file(path):
                continue
            found.append(path)
            if len(found) >= MAX_FILES:
                return found
    return found


def should_descend(path: Path) -> bool:
    if path.name in SKIP_DIRS:
        return False
    if path.name.startswith(".") and path.name not in {".codex", ".github"}:
        return False
    return True


def should_skip_file(path: Path) -> bool:
    name = path.name
    lower_name = name.lower()
    if name in SECRET_NAMES or lower_name in SECRET_NAMES:
        return True
    if any(part in lower_name for part in SECRET_PARTS):
        return True
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}:
        return True
    return False


def important_files(root: Path, files: list[Path]) -> list[Path]:
    wanted: list[Path] = []
    for path in files:
        rel = path.relative_to(root).as_posix()
        if path.name in IMPORTANT_FILENAMES or rel in IMPORTANT_RELATIVE:
            wanted.append(path)
    return sorted(wanted, key=lambda item: item.relative_to(root).as_posix())


def top_level_dirs(root: Path) -> list[str]:
    dirs: list[str] = []
    for path in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if not path.is_dir() or not should_descend(path):
            continue
        dirs.append(path.name)
    return dirs


def source_dirs(root: Path) -> list[str]:
    candidates = ["src", "app", "lib", "packages", "apps", "cmd", "Sources", "test", "tests", "docs", ".codex"]
    return [name for name in candidates if (root / name).is_dir()]


def read_package_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None

    scripts = data.get("scripts")
    return {
        "name": data.get("name"),
        "description": data.get("description"),
        "productName": data.get("productName"),
        "scripts": scripts if isinstance(scripts, dict) else {},
        "dependencies": sorted((data.get("dependencies") or {}).keys()) if isinstance(data.get("dependencies"), dict) else [],
        "devDependencies": sorted((data.get("devDependencies") or {}).keys())
        if isinstance(data.get("devDependencies"), dict)
        else [],
    }


def render_markdown(inspection: dict[str, Any]) -> str:
    lines = [
        "# Project Inspection",
        "",
        f"Root: `{inspection['root']}`",
        f"Git repo: {'yes' if inspection['git_repo'] else 'no'}",
        "",
        "## Top-Level Directories",
        *bullet_list(inspection["top_level_dirs"]),
        "",
        "## Important Files",
        *bullet_list(inspection["important_files"]),
        "",
        "## Source-Like Directories",
        *bullet_list(inspection["source_dirs"]),
    ]

    package = inspection.get("package")
    if package:
        lines.extend(
            [
                "",
                "## Package",
                f"- Name: `{package.get('name') or 'unknown'}`",
                f"- Product: `{package.get('productName') or 'unknown'}`",
                f"- Description: {package.get('description') or 'unknown'}",
                "- Scripts:",
                *indented_script_list(package.get("scripts") or {}),
            ]
        )

    return "\n".join(lines)


def bullet_list(values: list[str]) -> list[str]:
    return [f"- `{value}`" for value in values] if values else ["- None detected."]


def indented_script_list(scripts: dict[str, Any]) -> list[str]:
    if not scripts:
        return ["  - None detected."]
    return [f"  - `{name}`: `{command}`" for name, command in sorted(scripts.items())]


if __name__ == "__main__":
    raise SystemExit(main())
