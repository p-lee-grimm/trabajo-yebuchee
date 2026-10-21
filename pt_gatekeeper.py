#!/usr/bin/env python3
"""Permission gatekeeper for the Trabajo Yebuchee in-app chat (a PreToolUse hook).

Why this exists: the chat is a headless `claude -p` session driven from a browser, so
the built-in permission prompt has nobody to answer it. Two consequences.

  * Some tool calls are not grantable by `--allowedTools` at all — anything writing
    under `.claude/` is refused even with `Edit` allowed and even in `acceptEdits`
    mode. Headless that is a dead end: the model says "I need permission" and the user
    has no way to give it. (That is exactly how the /apply session got stuck trying to
    update `.claude/skills/job-application-assistant/01-candidate-profile.md`.)
  * So the chat session runs with `--permission-mode bypassPermissions` and *this*
    script becomes the permission system. Every tool call is routed here first, and
    anything it does not recognise becomes an access request the user answers with a
    button in the chat.

Three layers, outermost first — none of them is decorative:

  1. `permissions.deny` in the generated settings (`DENY_FLOOR`). Deny rules are still
     enforced under bypassPermissions (verified), so this is the fail-closed floor for
     the cases that must never depend on Python running correctly: shells, network
     binaries, the repo's config.yaml and databases, ~/.ssh, ~/.claude.
  2. this hook — the actual policy, below.
  3. `self_test()`, which the server runs before every chat turn. A hook that crashes,
     is missing, or cannot reach the DB is treated by Claude Code as "no opinion",
     which under bypassPermissions means *allow*. That is fail-open, so the server
     refuses to start a turn unless a synthetic `curl` call comes back denied.

Never drop 1 or 3 without replacing them with something equivalent: a shell reachable
from a browser session is RCE on the box.
"""

import fnmatch
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

# How long the hook blocks waiting for the user to press a button. The hook's own
# timeout in the settings is set above this, because a hook that times out counts as a
# crash — i.e. fail-open. We always answer first.
ASK_TIMEOUT = int(os.environ.get("PT_ASK_TIMEOUT", "240"))
POLL_INTERVAL = 1.5

# Tools with no authority beyond the conversation itself.
FREE_TOOLS = {"TodoWrite", "WebSearch", "WebFetch", "Skill", "SlashCommand",
              "ExitPlanMode", "Task", "Agent", "ToolSearch", "BashOutput", "KillShell"}
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
READ_TOOLS = {"Read", "NotebookRead"}
SEARCH_TOOLS = {"Glob", "Grep"}

# The whole Bash allowlist: /apply's mandatory PDF verification, nothing else. Bash is
# deliberately NOT askable — "approve this shell command" in a browser-reachable session
# is a remote shell with extra steps, and no button should be able to hand one out.
BASH_ALLOWED = {"lualatex", "xelatex", "pdflatex", "pdftotext", "pdfinfo", "pdftoppm"}
BASH_METACHARACTERS = ";|&`$><\n\\"

# Shell habits that have a granted non-shell equivalent. Denying `ls` with "ask the user
# to run it in a terminal" is technically true and practically a dead end: the model
# stops and asks for a directory listing it could have produced itself with Glob. So the
# denial names the tool to use instead.
BASH_REDIRECTS = {
    "ls": "Glob (например `cv/*` — он разрешён в любой папке рабочего каталога)",
    "tree": "Glob (`**/*`)",
    "find": "Glob",
    "cat": "Read", "head": "Read", "tail": "Read", "less": "Read", "more": "Read",
    "grep": "Grep", "rg": "Grep", "ack": "Grep",
    "cp": "Read + Write", "touch": "Write", "mkdir": "Write (создай файл по пути — "
                                                     "папки появятся сами)",
}

# One extra program, matched by *exact resolved path* rather than by name: the salary
# benchmark lookup /apply calls during evaluation.
#
# Two things make this safe, and it stops being safe without either of them.
#   * The script lives in the repo's tools/, not in the workspace. Writes inside the
#     workspace are allowed, so a runnable script kept there is a script the session can
#     rewrite and then run — that is arbitrary code execution, not a salary lookup.
#     `deny_floor()` also refuses writes to tools/ as layer 1.
#   * Matching is on the resolved absolute path, not `basename`. A basename rule would
#     accept ./pt-salary out of any directory the session can write to.
# Its interpreter is not exposed: `python`/`python3` stay denied, the shebang runs it.
# Arguments are free text (a company name), which is why the metacharacter check below
# runs first and applies here too.
BASH_EXACT_ALLOWED = ("tools/pt-salary",)

# Writes here would disable the gatekeeper itself (settings can add hooks and allow
# rules), so they are refused outright rather than offered as a request.
UNGRANTABLE_WRITES = (".claude/settings.json", ".claude/settings.local.json", ".mcp.json")

# Everything under .claude/ is a prompt-injection surface — a skill or command file is
# read back as instructions on later turns. So are ranking_rules.md, pasted into every
# ranking prompt, and sources.json, whose rules decide which postings are dropped unseen.
# Editable, but only with a human OK.
ASK_WRITE_PREFIXES = (".claude/", "ranking_rules.md", "sources.json")


def secret_globs(workspace: Path) -> list:
    """Paths layer 1 refuses outright. Asking about them would offer a dead button."""
    home = Path.home()
    repo = workspace.parent.parent
    return [str(repo / "config*.yaml"), str(repo / "data" / "*.db"),
            str(home / ".ssh" / "*"), str(home / ".claude" / "*"),
            str(home / ".config" / "*"), "/etc/*", "/root/*"]


def deny_floor(workspace: Path) -> list:
    """Static deny rules, enforced even under bypassPermissions. Layer 1."""
    home = Path.home()
    repo = workspace.parent.parent
    rules = [f"Bash({name}:*)" for name in (
        "bash", "sh", "zsh", "dash", "env", "eval", "exec", "xargs", "find", "curl",
        "wget", "nc", "ncat", "socat", "ssh", "scp", "rsync", "python", "python3",
        "node", "npm", "npx", "bun", "deno", "perl", "ruby", "php", "git", "pip",
        "pip3", "sudo", "su", "chmod", "chown", "rm", "mv", "dd", "cat", "tee",
        "systemctl", "crontab", "docker", "kill", "pkill", "at", "make")]
    for secret in (repo / "config.yaml", repo / "config.example.yaml"):
        rules.append(f"Read(//{secret})")
    for pattern in (f"//{repo}/data/*.db", f"//{home}/.ssh/**", f"//{home}/.claude/**",
                    f"//{home}/.config/**", "//etc/**", "//root/**"):
        for tool in ("Read", "Edit", "Write", "Glob", "Grep"):
            rules.append(f"{tool}({pattern})")
    for path in UNGRANTABLE_WRITES:
        for tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            rules.append(f"{tool}(//{workspace / path})")
    # tools/ holds the one runnable program this session may execute. Editing it would
    # turn that permission into arbitrary code execution, so the floor refuses it too —
    # the hook already denies writes outside the workspace, this survives the hook.
    for tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
        rules.append(f"{tool}(//{repo}/tools/**)")
    return rules


def settings_json(workspace: Path, hook_command: str) -> str:
    """The `--settings` payload for a chat session: the deny floor plus this hook."""
    return json.dumps({
        "permissions": {"deny": deny_floor(workspace)},
        "hooks": {"PreToolUse": [{
            "matcher": "*",
            "hooks": [{"type": "command", "command": hook_command,
                       "timeout": ASK_TIMEOUT + 60}],
        }]},
    })


# --------------------------------------------------------------------------- policy

def _rel(workspace: Path, raw: str):
    """Path relative to the workspace, or None if it escapes it (symlinks resolved)."""
    if not raw:
        return None
    try:
        target = Path(os.path.realpath(os.path.join(str(workspace), str(raw))))
        return str(target.relative_to(os.path.realpath(str(workspace))))
    except (ValueError, OSError):
        return None


def _subject(tool_name: str, tool_input: dict, workspace: Path) -> tuple:
    """What a request is *about*, as (kind, target): the thing grants are matched on."""
    raw = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if tool_name in WRITE_TOOLS:
        return "write", _rel(workspace, raw) or os.path.realpath(raw)
    if tool_name in READ_TOOLS:
        return "read", _rel(workspace, raw) or os.path.realpath(raw)
    return "tool", tool_name


def rule_for(tool_name: str, tool_input: dict, workspace: Path) -> str:
    """The standing-grant rule a request installs if approved for the whole chat.

    Deliberately the containing directory, not the single file: approving one skill file
    and then being asked again for its sibling on the next turn is the same dead end
    this whole mechanism exists to remove.
    """
    kind, target = _subject(tool_name, tool_input, workspace)
    if kind == "tool":
        return f"tool:{target}"
    parent = os.path.dirname(target)
    return f"{kind}:{parent + '/' if parent else ''}**"


def _granted(rules: list, tool_name: str, tool_input: dict, workspace: Path) -> bool:
    kind, target = _subject(tool_name, tool_input, workspace)
    for rule in rules:
        if not isinstance(rule, str) or ":" not in rule:
            continue
        rule_kind, pattern = rule.split(":", 1)
        if rule_kind != kind:
            continue
        if target == pattern or fnmatch.fnmatch(target, pattern):
            return True
    return False


def _outside(workspace: Path, raw: str, reason: str) -> tuple:
    """Ask about a path outside the workspace — unless layer 1 would refuse it anyway."""
    resolved = os.path.realpath(str(raw))
    if any(fnmatch.fnmatch(resolved, pattern) for pattern in secret_globs(workspace)):
        return "deny", f"{raw} лежит за пределами рабочей папки и содержит секреты сервера"
    return "ask", reason


def _is_allowed_program(head: str, workspace: Path) -> bool:
    """True only for an exact program in BASH_EXACT_ALLOWED, path resolved.

    Resolving both sides is the whole point: a relative `tools/pt-salary`, a symlink
    planted in the workspace and an absolute path must all end up compared as the one
    real file, and anything else — same name, different directory — must not match.
    """
    if not head:
        return False
    repo = workspace.parent.parent
    try:
        target = os.path.realpath(os.path.join(str(workspace), head))
    except (OSError, ValueError):
        return False
    for allowed in BASH_EXACT_ALLOWED:
        try:
            if target == os.path.realpath(str(repo / allowed)):
                return True
        except (OSError, ValueError):
            continue
    return False


def decide(tool_name: str, tool_input: dict, workspace: Path) -> tuple:
    """Return (decision, reason) with decision in {allow, deny, ask}.

    Anything unrecognised falls through to `ask` rather than `allow`: under
    bypassPermissions there is no second opinion behind this function.
    """
    if tool_name == "Bash":
        command = (tool_input.get("command") or "").strip()
        head = command.split()[0] if command.split() else ""
        instead = BASH_REDIRECTS.get(os.path.basename(head))
        if any(char in command for char in BASH_METACHARACTERS):
            return "deny", ("составные shell-команды здесь запрещены — "
                            "разрешена только сборка PDF одной командой"
                            + (f"; для этого используй {instead}" if instead else ""))
        if os.path.basename(head) in BASH_ALLOWED:
            return "allow", "PDF toolchain"
        if _is_allowed_program(head, workspace):
            return "allow", "salary lookup"
        if instead:
            return "deny", (f"`{os.path.basename(head)}` недоступен — используй вместо "
                            f"него {instead}. Не проси пользователя выполнять это в "
                            f"терминале: нужный инструмент у тебя уже есть.")
        return "deny", (f"shell недоступен в этой сессии (разрешены только "
                        f"{', '.join(sorted(BASH_ALLOWED))} и tools/pt-salary); "
                        f"для файлов используй Read/Write/Glob/Grep, а если нужен именно "
                        f"shell — попроси пользователя выполнить команду в терминале")

    if tool_name in FREE_TOOLS:
        return "allow", ""

    if tool_name in SEARCH_TOOLS:
        raw = tool_input.get("path") or ""
        if not raw or _rel(workspace, raw) is not None:
            return "allow", ""
        return _outside(workspace, raw, f"поиск за пределами рабочей папки: {raw}")

    if tool_name in READ_TOOLS:
        raw = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        if _rel(workspace, raw) is not None:
            return "allow", ""
        return _outside(workspace, raw, f"чтение файла за пределами рабочей папки: {raw}")

    if tool_name in WRITE_TOOLS:
        raw = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
        rel = _rel(workspace, raw)
        if rel is None:
            return "deny", (f"запись за пределы {workspace.name}/ запрещена: {raw}")
        if rel in UNGRANTABLE_WRITES:
            return "deny", ("этот файл задаёт права самой сессии и не редактируется "
                            "изнутри неё")
        if rel.startswith(ASK_WRITE_PREFIXES):
            return "ask", f"изменение настроек поиска или Claude Code: {rel}"
        return "allow", ""

    return "ask", f"инструмент {tool_name} не входит в разрешённый набор"


# --------------------------------------------------------------------------- the ask

def _connect(db_path: str):
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _ask_user(db_path: str, chat_id: int, message_id: int, tool_name: str,
              tool_input: dict, reason: str, workspace: Path) -> tuple:
    """Post an access request to the chat and block until the user answers it."""
    rule = rule_for(tool_name, tool_input, workspace)
    conn = _connect(db_path)
    try:
        row = conn.execute("SELECT granted FROM pt_chats WHERE id = ?", (chat_id,)).fetchone()
        try:
            standing = json.loads(row["granted"]) if row and row["granted"] else []
        except (ValueError, TypeError):
            standing = []
        if isinstance(standing, list) and _granted(standing, tool_name, tool_input, workspace):
            return "allow", "ранее разрешено в этом чате"
        cur = conn.execute(
            "INSERT INTO pt_access_requests (chat_id, message_id, tool_name, tool_input, "
            "rule, reason, state, expires_at) VALUES (?,?,?,?,?,?, 'pending', ?)",
            (chat_id, message_id, tool_name, json.dumps(tool_input, ensure_ascii=False)[:8000],
             rule, reason, int(time.time()) + ASK_TIMEOUT))
        request_id = cur.lastrowid
        conn.commit()
    finally:
        conn.close()

    deadline = time.time() + ASK_TIMEOUT
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL)
        conn = _connect(db_path)
        try:
            row = conn.execute("SELECT state FROM pt_access_requests WHERE id = ?",
                               (request_id,)).fetchone()
        finally:
            conn.close()
        if not row or row["state"] == "pending":
            continue
        if row["state"] == "allowed":
            return "allow", "разрешено пользователем в чате"
        return "deny", "пользователь отклонил запрос — предложи другой путь"

    conn = _connect(db_path)
    try:
        conn.execute("UPDATE pt_access_requests SET state = 'timeout' WHERE id = ? "
                     "AND state = 'pending'", (request_id,))
        conn.commit()
    finally:
        conn.close()
    return "deny", (f"пользователь не ответил на запрос доступа за {ASK_TIMEOUT}с — "
                    f"продолжай без этого действия и скажи, что доступ не выдан")


# --------------------------------------------------------------------------- entry

def _emit(decision: str, reason: str) -> None:
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason or "gatekeeper",
    }}, ensure_ascii=False))


def main() -> None:
    # Every failure path below must end in "deny": an exception escaping this function
    # is a non-zero exit, which Claude Code reads as "hook had no opinion" — allow.
    try:
        payload = json.load(sys.stdin)
    except Exception:
        _emit("deny", "gatekeeper: не удалось разобрать запрос")
        return
    try:
        tool_name = str(payload.get("tool_name") or "")
        tool_input = payload.get("tool_input") or {}
        if not isinstance(tool_input, dict):
            tool_input = {}
        workspace = Path(os.environ.get("PT_WORKSPACE") or os.getcwd())
        decision, reason = decide(tool_name, tool_input, workspace)
        if decision != "ask":
            _emit(decision, reason)
            return
        chat_id = int(os.environ.get("PT_CHAT_ID") or 0)
        db_path = os.environ.get("PT_DB_PATH") or ""
        if not chat_id or not db_path:
            # No chat to ask in — a session started outside the app. Refuse.
            _emit("deny", f"{reason} (запросить доступ здесь не у кого)")
            return
        decision, reason = _ask_user(
            db_path, chat_id, int(os.environ.get("PT_MESSAGE_ID") or 0),
            tool_name, tool_input, reason, workspace)
        _emit(decision, reason)
    except Exception as exc:
        _emit("deny", f"gatekeeper: {type(exc).__name__}")


def self_test(env: dict) -> str:
    """Run this script as the hook would and confirm it denies. '' means healthy.

    Layer 3. Called by the server before a chat turn; see the module docstring for why a
    silent hook failure is not survivable here.
    """
    probe = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Bash",
                        "tool_input": {"command": "curl http://example.com"}})
    try:
        proc = subprocess.run([sys.executable, os.path.abspath(__file__)],
                              input=probe, capture_output=True, text=True,
                              timeout=20, env={**os.environ, **env})
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"
    if proc.returncode != 0:
        return f"exit {proc.returncode}: {proc.stderr.strip()[:200]}"
    try:
        out = json.loads(proc.stdout)["hookSpecificOutput"]["permissionDecision"]
    except Exception:
        return f"неразборчивый ответ: {proc.stdout.strip()[:200]}"
    return "" if out == "deny" else f"пробный shell-вызов вернул '{out}' вместо deny"


if __name__ == "__main__":
    main()
