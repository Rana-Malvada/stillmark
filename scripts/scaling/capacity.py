"""Offline scenario calculator. No infrastructure calls or pricing assumptions."""
import argparse
import json
import math

DEFAULTS = {
    'registered_users': 1_000_000,
    'peak_active_users': 100_000,
    'photos_per_user': 10_000,
    'videos_per_user': 1_000,
    'photo_mb': 5,
    'video_mb': 200,
    'thumbnail_kb_per_photo': 100,
    'metadata_kb_per_item': 2,
    'api_requests_per_active_user_second': 0.1,
    'media_requests_per_active_user_second': 2,
    'initial_import_days': 90,
}


def calculate(overrides=None):
    unknown = set(overrides or {}) - DEFAULTS.keys()
    if unknown:
        raise ValueError(f'Unknown inputs: {sorted(unknown)}')
    a = DEFAULTS | (overrides or {})
    for k, v in a.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
            raise ValueError(f'{k} must be a finite nonnegative number')
        if k.endswith('_users') or k.endswith('_per_user'):
            if int(v) != v:
                raise ValueError(f'{k} must be a whole number')
    if a['initial_import_days'] <= 0:
        raise ValueError('initial_import_days must be positive')
    if a['peak_active_users'] > a['registered_users']:
        raise ValueError('peak_active_users cannot exceed registered_users')
    photos = a['registered_users'] * a['photos_per_user']
    videos = a['registered_users'] * a['videos_per_user']
    size = (photos * a['photo_mb'] + videos * a['video_mb']) * 1_000_000
    seconds = a['initial_import_days'] * 86400
    return {
        'inputs': a,
        'units': 'decimal bytes; illustrative averages, not measurements',
        'photos': photos,
        'videos': videos,
        'original_petabytes': size / 1e15,
        'photo_thumbnail_petabytes': photos * a['thumbnail_kb_per_photo'] / 1e12,
        'base_metadata_terabytes': (photos + videos) * a['metadata_kb_per_item'] / 1e9,
        'peak_api_requests_per_second': a['peak_active_users'] * a['api_requests_per_active_user_second'],
        'peak_media_requests_per_second': a['peak_active_users'] * a['media_requests_per_active_user_second'],
        'initial_import_files_per_second': (photos + videos) / seconds,
        'initial_import_gigabytes_per_second': size / seconds / 1e9,
        'exclusions': ['derived video', 'face crops', 'OCR and vectors', 'indexes', 'replicas', 'logs', 'pricing'],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', help='JSON file overriding any default assumptions')
    args = parser.parse_args()
    try:
        overrides = None
        if args.inputs:
            with open(args.inputs) as source:
                overrides = json.load(source)
            if not isinstance(overrides, dict):
                raise ValueError('inputs must be a JSON object')
        print(json.dumps(calculate(overrides), indent=2))
    except (ValueError, OSError) as error:
        parser.error(str(error))
