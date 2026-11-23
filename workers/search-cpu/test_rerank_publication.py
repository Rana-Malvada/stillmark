"""Execute production worker functions without loading inference dependencies."""
import ast
from pathlib import Path
from types import SimpleNamespace
import os
import time
import unittest
from unittest.mock import patch


def functions(models):
    from concurrent.futures import Future
    class Pool:
        def __init__(self, *args, **kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def submit_rank(self, *args):
            future=Future()
            try: future.set_result(models.rank(*args))
            except Exception as error: future.set_exception(error)
            return future
    tree = ast.parse(Path(__file__).with_name('worker.py').read_text())
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef)
             and n.name in ('run', 'publish_rerank')]
    scope = {'time': time, 'os': os, 'RANKER': 'test-ranker',
             'detect_capacity': lambda: 1, 'refresh_travel_summaries': lambda *args: 0,
             'InferencePool': Pool, 'PHOTO_LEASE_SECONDS': 300, 'RERANK_LEASE_SECONDS': 900,
             'RUN_HEARTBEAT_SECONDS': 5, 'CLAIM_RENEW_SECONDS': 15}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'worker.py', 'exec'), scope)
    return scope


class Database:
    def __init__(self, published=1, rank_error=False):
        self.published = published
        self.claimed = False
        self.calls = []
        self.row = {'id': 'session', 'claim_token': 'original', 'payload': {},
                    'query': 'wine', 'documents': [], 'candidate_ids': [2, 1]}

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        row = None
        if "SET status='running'" in sql:
            row = {'photo_limit': 0, 'search_limit': 1}
        elif 'SET heartbeat_at=' in sql:
            row = {'id': 'run'}
        elif "SET rerank_status='running'" in sql:
            row = self.row
        return SimpleNamespace(rowcount=self.published if 'SET reranked_ids=' in sql else 1,
                               fetchone=lambda: row)


class PublicationTests(unittest.TestCase):
    def test_result_arriving_at_budget_boundary_does_not_publish(self):
        db=Database();now=[0]
        def rank(*args):
            now[0]=2
            return [1,2]
        models=SimpleNamespace(rank=rank)
        with patch.dict(os.environ,{'WORKER_MAX_SECONDS':'1'}),patch.object(time,'monotonic',side_effect=lambda:now[0]):
            functions(models)['run'](db,'run',models)
        self.assertFalse(any('SET reranked_ids=' in sql for sql,params in db.calls))
        failure=next(params for sql,params in db.calls if 'rerank_error=%s' in sql)
        self.assertEqual(failure,('InterruptedError','session','original'))

    def test_count_only_committed_ranking(self):
        for published in (0, 1):
            with self.subTest(published=published):
                db = Database(published)
                models=SimpleNamespace(rank=lambda *args: [1, 2])
                functions(models)['run'](db, 'run', models)
                final = next(params for sql, params in db.calls if "SET status='completed'" in sql)
                self.assertEqual(final[2], published)
                release = [(sql, params) for sql, params in db.calls
                           if 'claim_token=NULL,lease_until=NULL WHERE id=' in sql]
                self.assertEqual(len(release), 1 if published == 0 else 0)
                if release:
                    self.assertEqual(release[0][1], ('session', 'original'))

    def test_model_failure_is_not_success_and_releases_own_claim(self):
        db = Database()
        def fail(*args):
            raise ValueError('Synthetic inference failure')
        models=SimpleNamespace(rank=fail)
        functions(models)['run'](db, 'run', models)
        final = next(params for sql, params in db.calls if "SET status='completed'" in sql)
        self.assertEqual(final[2:4], (0, 1))
        failure = next((sql, params) for sql, params in db.calls if 'rerank_error=%s' in sql)
        self.assertEqual(failure[1], ('ValueError', 'session', 'original'))
        self.assertIn('claim_token=NULL,lease_until=NULL', failure[0])


if __name__ == '__main__':
    unittest.main()
