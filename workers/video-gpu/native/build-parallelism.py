#!/usr/bin/env python3
"""Bound compile parallelism by reviewed policy and actual container capacity."""
import json
import os
import pathlib
import sys


def choose_jobs(cap, cpu_count, affinity_count, quotas):
    if type(cap) is not int or not 1 <= cap <= 16:
        raise ValueError("Native build jobs must be an integer between 1 and 16")
    limits = [cap, cpu_count or 1]
    if affinity_count is not None:
        limits.append(max(1, affinity_count))
    for quota, period in quotas:
        if period <= 0 or quota == 0 or quota < -1:
            raise ValueError("Invalid CPU quota")
        if quota != -1:
            limits.append(max(1, quota // period))
    return max(1, min(limits))


def cgroup_quotas(root=pathlib.Path("/sys/fs/cgroup"), membership=pathlib.Path("/proc/self/cgroup")):
    # Check mounted root and every visible ancestor of this process's cgroup.
    paths = {root}
    if membership.exists():
        for line in membership.read_text().splitlines():
            _, controllers, relative = line.split(":", 2)
            if not controllers or "cpu" in controllers.split(","):
                base = root if not controllers else root / "cpu"
                current = base / relative.lstrip("/")
                if ".." in current.parts:
                    raise ValueError("Invalid cgroup membership")
                while current != base and base in current.parents:
                    paths.add(current)
                    current = current.parent
                paths.add(base)
    paths.update([root / "cpu", root / "cpu,cpuacct"])
    quotas = []
    for path in paths:
        maximum = path / "cpu.max"
        if maximum.exists():
            quota, period = maximum.read_text().split()
            quotas.append((-1 if quota == "max" else int(quota), int(period)))
        quota_file = path / "cpu.cfs_quota_us"
        if quota_file.exists():
            quotas.append((int(quota_file.read_text()), int((path / "cpu.cfs_period_us").read_text())))
    return quotas


if __name__ == "__main__":
    policy = json.loads(pathlib.Path(sys.argv[1]).read_text())
    affinity = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None
    print(choose_jobs(policy["jobs"], os.cpu_count(), affinity, cgroup_quotas()))
