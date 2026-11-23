"""Bounded Postgres-only map preparation within an admin-started batch."""
import os


def refresh_travel_summaries(db, heartbeat):
    if os.environ.get('TRAVEL_SUMMARIES_ENABLED') != 'true':
        return 0
    limit = int(os.environ.get('TRAVEL_SUMMARY_MAX_ALBUMS', '100'))
    if not 1 <= limit <= 1000:
        raise ValueError('Invalid TRAVEL_SUMMARY_MAX_ALBUMS')
    done = 0
    for _ in range(limit):
        if not heartbeat():
            break
        row = db.execute('SELECT photo_security.refresh_travel_summary() AS event_id').fetchone()
        if row['event_id'] is None:
            break
        done += 1
    return done
