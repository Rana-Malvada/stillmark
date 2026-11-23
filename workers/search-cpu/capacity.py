"""Container-aware CPU admission. Memory budgets are configurable estimates, not RSS claims."""
import math
import os
from pathlib import Path


def read(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def positive(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else None
    except (TypeError, ValueError):
        return None


def worker_capacity(cpu, memory_mib, per_worker_mib=1536, reserve_mib=1024, ceiling=None):
    if not all(positive(x) for x in [cpu, memory_mib, per_worker_mib, reserve_mib]):
        raise ValueError('Invalid search worker resource budget')
    slots = min(max(1, math.floor(cpu)), math.floor((memory_mib-reserve_mib)/per_worker_mib))
    if ceiling is not None:
        if not isinstance(ceiling, int) or ceiling < 1:
            raise ValueError('Invalid search worker ceiling')
        slots = min(slots, ceiling)
    if slots < 1:
        raise ValueError('Insufficient memory for one search worker')
    return slots


def configured(name, fallback):
    raw = os.environ.get(name, str(fallback))
    n = positive(raw)
    if n is None:
        raise ValueError('Invalid '+name)
    return n


def detect_capacity():
    cpu = len(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else (os.cpu_count() or 1)
    parts = (read('/sys/fs/cgroup/cpu.max') or '').split()
    quota = positive(parts[0]) if len(parts) == 2 else positive(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'))
    period = positive(parts[1]) if len(parts) == 2 else positive(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'))
    if quota and period:
        cpu = min(cpu, quota/period)
    memory = positive(read('/sys/fs/cgroup/memory.max')) or positive(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'))
    # Honor host memory as well; v1 can report a near-unlimited sentinel.
    host_memory = os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    memory_mib = min(memory or host_memory, host_memory)/1048576
    override = os.environ.get('WORKER_MEMORY_MIB')
    if override is not None:
        memory_mib = min(memory_mib, configured('WORKER_MEMORY_MIB', memory_mib))
    raw = os.environ.get('WORKER_PHOTO_WORKERS', 'auto')
    if raw != 'auto' and (not raw.isdigit() or int(raw) < 1):
        raise ValueError('WORKER_PHOTO_WORKERS must be auto or a positive integer')
    return worker_capacity(cpu, memory_mib,
        configured('WORKER_PHOTO_MEMORY_MIB', 1536), configured('WORKER_RESERVE_MEMORY_MIB', 1024),
        None if raw == 'auto' else int(raw))
