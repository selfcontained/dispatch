"""Validate frozen Linux runner processes against the supervisor's v1 bindings."""
import json
import os
import re
import stat
import sys
from pathlib import Path


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def check(config_file, pid_file, main_pid):
    config = json.loads(Path(config_file).read_text())
    state = Path(config["state"])
    bindings = state / "bindings"
    for directory in (state, bindings, state / "hosts"):
        meta = directory.lstat()
        require(stat.S_ISDIR(meta.st_mode) and meta.st_uid == 0 and
                not meta.st_mode & 0o022, "untrusted runner state directory")
    scope = (Path("/proc/sys/kernel/random/boot_id").read_text().strip()
             + ":" + os.readlink("/proc/self/ns/pid"))
    processes = {}
    for value in Path(pid_file).read_text().split():
        pid = int(value)
        if pid == main_pid:
            continue
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        parent = int(fields[1])
        # The checkout watcher exits on stdin EOF and Dispatch re-subscribes.
        if parent == main_pid:
            args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
            if (len(args) == 4 and args[1] == b"runner-watch-checkout" and
                    os.path.samefile(f"/proc/{pid}/exe", f"/proc/{main_pid}/exe")):
                continue
        processes[pid] = (parent, int(fields[3]), fields[19])
    hosts = set()
    for record in bindings.glob("*.host"):
        if not re.fullmatch(r"(agt_[a-z0-9]+|opaque-[A-Za-z0-9_-]{43})", record.stem):
            continue
        meta = record.lstat()
        require(stat.S_ISREG(meta.st_mode) and meta.st_uid == 0 and
                not meta.st_mode & 0o022, "untrusted runner host record")
        identity = json.loads(record.read_text())
        pid = identity["pid"]
        if pid not in processes:
            continue
        _, sid, start = processes[pid]
        require(sid == pid and start == identity["start"] and identity["scope"] == scope
                and re.fullmatch(r"DISPATCH_OWNED_[0-9a-f]{32}=1", identity["marker"]),
                "session process identity changed")
        host = state / "hosts" / record.stem
        require(stat.S_ISDIR(host.lstat().st_mode), "session directory unavailable")
        socket = (host / "host.sock").lstat()
        require(stat.S_ISSOCK(socket.st_mode) and socket.st_uid == config["uid"],
                "session has not finished starting")
        require(not os.path.lexists(host / "turn-active"), "an agent is working")
        hosts.add(pid)
    for pid in processes:
        ancestor = pid
        while ancestor in processes and ancestor not in hosts:
            parent, sid, _ = processes[ancestor]
            if sid in hosts:
                break
            ancestor = parent
        else:
            require(ancestor in hosts, "a runner operation is still in progress")
    print(f"Preserving {len(hosts)} open runner session(s).")


if __name__ == "__main__":
    try:
        check(sys.argv[1], sys.argv[2], int(sys.argv[3]))
    except (OSError, KeyError, TypeError, ValueError) as exc:
        sys.exit(f"Runner handoff deferred: {exc}")
