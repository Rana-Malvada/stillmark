"""Fast lifecycle tests; no model downloads or inference dependencies required."""
import ast
from pathlib import Path
import unittest


def load_warm_loop(process, clock, sleep):
    tree = ast.parse(Path(__file__).with_name('worker.py').read_text())
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'process_automatic_photos')
    import time
    scope = {'time': time, 'process_pending_photos': process}
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'worker.py', 'exec'), scope)
    return lambda heartbeat, idle_state: scope['process_automatic_photos'](
        'same-pool', 4, heartbeat, None, None, idle_state, clock=clock, sleep=sleep)


class WarmIdleTests(unittest.TestCase):
    def test_new_work_resets_fifteen_minutes_without_replacing_pool(self):
        now = [0]
        seen = []
        batches = {0, 600}
        def process(pool, workers, limit, heartbeat, claim, consume):
            seen.append(pool)
            return 1 if now[0] in batches else 0
        loop = load_warm_loop(process, lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds))
        loop(lambda: True, lambda idle: None)
        self.assertEqual(now[0], 1500)
        self.assertEqual(set(seen), {'same-pool'})

    def test_stop_or_original_budget_ends_warm_wait(self):
        now = [0]
        loop = load_warm_loop(lambda *args: 0, lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds))
        loop(lambda: now[0] < 20, lambda idle: None)
        self.assertEqual(now[0], 20)

    def test_no_work_exits_after_one_idle_allowance(self):
        now = [0]
        loop = load_warm_loop(lambda *args: 0, lambda: now[0], lambda seconds: now.__setitem__(0, now[0] + seconds))
        loop(lambda: True, lambda idle: None)
        self.assertEqual(now[0], 900)


if __name__ == '__main__':
    unittest.main()
