"""Summarize private operator observations without exporting source IDs or filenames."""
import datetime
import glob
import json
import math
import statistics
import sys


def percentile(values, p):
    return sorted(values)[max(0, math.ceil(len(values) * p) - 1)]


def summarize(directory):
    trials = []
    for path in sorted(glob.glob(directory + '/trial-*.json')):
        r = json.load(open(path))
        jobs = r['jobs']
        if len(jobs) != 32 or any(j['state'] != 'done' or j['attempts'] != 1 or j['executor'] != 'pool' for j in jobs):
            raise ValueError('Incomplete or retried trial')
        if r['savedResults'] != 32 or any(r['verified'][k] != 32 for k in ['photos', 'unique_names', 'unique_hashes']):
            raise ValueError('Publication verification failed')
        def timestamp(value):
            value = value.replace(' ', 'T')
            if len(value.rsplit('+', 1)[-1]) == 2:
                value += ':00'
            return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%f%z')
        released = timestamp(r['released'])
        latency = [(timestamp(j['updated_at']) - released).total_seconds() for j in jobs]
        trials.append({
            'trial': r['trial'], 'workers': r['workers'], 'files': len(jobs),
            'completionSeconds': max(latency), 'filesPerMinute': len(jobs) * 60 / max(latency),
            'completionP50Seconds': statistics.median(latency), 'completionP95Seconds': percentile(latency, .95),
            'peakDatabaseConnections': max(s['activity']['connections'] for s in r['samples']),
            'peakDatabaseLockWaits': max(s['activity']['lock_waits'] for s in r['samples']),
            'databaseDeadlocksDelta': r['databaseAfter']['deadlocks'] - r['databaseBefore']['deadlocks'],
        })
    if [r['workers'] for r in trials] != [1, 2, 4, 4, 2, 1]:
        raise ValueError('Expected all six forward/reverse trials')
    groups = []
    for workers in [1, 2, 4]:
        selected = [r for r in trials if r['workers'] == workers]
        groups.append({'workers': workers, 'filesPerMinute': sum(r['files'] for r in selected) * 60 / sum(r['completionSeconds'] for r in selected)})
    return {'trials': trials, 'pooledThroughput': groups}


if __name__ == '__main__':
    print(json.dumps(summarize(sys.argv[1]), indent=2))
