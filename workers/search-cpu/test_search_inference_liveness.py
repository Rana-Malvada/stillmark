"""Real subprocess faults through the production pool and coordinator loop.

The synthetic child replaces inference only; subprocess control, framed I/O,
deadline, slot replacement and coordinator cancellation are the shipped code.
Runs both without host ML dependencies and inside the exact worker image.
"""
import ast
from concurrent.futures import wait, FIRST_COMPLETED
import os
from pathlib import Path
import sys
import time
import unittest

from inference_pool import InferencePool


CHILD = '''
import signal, sys, time
sys.path.insert(0, sys.argv[1])
from inference_pool import frame, read_message
while True:
    try: request=read_message(sys.stdin.buffer)
    except EOFError: break
    value=request[1]
    if value == 'hang': time.sleep(60)
    if value == 'resist':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(60)
    if value == 'crash': sys.exit(9)
    if value == 'slow': time.sleep(.45)
    sys.stdout.buffer.write(frame(('ok', value)))
    sys.stdout.buffer.flush()
'''


def loop():
    tree=ast.parse(Path(__file__).with_name('worker.py').read_text())
    nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='process_pending_photos']
    scope={'wait':wait,'FIRST_COMPLETED':FIRST_COMPLETED,'process_photo':lambda value:value}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'worker.py','exec'),scope)
    return scope['process_pending_photos']


class InferenceLiveness(unittest.TestCase):
    def pool(self, workers=1, timeout=.25):
        return InferencePool(workers,timeout=timeout,
                             command=[sys.executable,'-c',CHILD,str(Path(__file__).parent)])

    def result(self, pool, future):
        deadline=time.monotonic()+4
        while not future.done() and time.monotonic()<deadline:
            pool.poll(.01)
        self.assertTrue(future.done(),'Inference did not settle in bounded time')
        return future.result()

    def test_hung_item_does_not_hold_other_slots_and_slot_is_replaced(self):
        with self.pool(2) as pool:
            hung=pool.submit(None,'hang')
            healthy=pool.submit(None,'healthy')
            self.assertEqual(self.result(pool,healthy),'healthy')
            with self.assertRaises(TimeoutError): self.result(pool,hung)
            replacement=pool.submit(None,'replacement')
            self.assertEqual(self.result(pool,replacement),'replacement')

    def test_term_resistant_child_is_killed_and_shutdown_is_bounded(self):
        start=time.monotonic()
        with self.pool() as pool:
            future=pool.submit(None,'resist')
            process=pool.slots[0]['process']
            with self.assertRaises(TimeoutError): self.result(pool,future)
            self.assertIsNotNone(process.poll())
        self.assertLess(time.monotonic()-start,2)

    def test_crashed_child_is_replaced(self):
        with self.pool(timeout=2) as pool:
            with self.assertRaises((RuntimeError,BrokenPipeError)):
                self.result(pool,pool.submit(None,'crash'))
            self.assertEqual(self.result(pool,pool.submit(None,'healthy')),'healthy')

    def test_stop_during_inference_releases_claim_and_does_not_wait_for_result(self):
        start=time.monotonic(); outcomes=[]; claimed=[]
        def claim():
            row={'source_path':'resist'};claimed.append(row);return row
        def consume(row,future):
            try: outcomes.append(future.result())
            except Exception as error: outcomes.append(error)
        with self.pool(timeout=30) as pool:
            loop()(pool,1,10,lambda:time.monotonic()-start<.15,claim,consume)
        self.assertEqual(len(claimed),1)
        self.assertIsInstance(outcomes[0],InterruptedError)
        self.assertLess(time.monotonic()-start,2)

    def test_heartbeat_and_renewal_continue_past_short_initial_lease(self):
        started=time.monotonic(); expires=started+.1; renewals=[]; beats=[]; completed=[]
        def renew(row):
            nonlocal expires
            now=time.monotonic()
            if now>=expires: return False
            expires=now+.35;renewals.append(now);return True
        def heartbeat(): beats.append(time.monotonic());return True
        with self.pool(timeout=2) as pool:
            loop()(pool,1,1,heartbeat,lambda:{'source_path':'slow'},
                   lambda row,future:completed.append(future.result()),renew)
        self.assertEqual(completed,['slow'])
        self.assertGreater(time.monotonic()-started,.4)
        self.assertGreaterEqual(len(renewals),2)
        self.assertGreaterEqual(len(beats),3)

    def test_lost_lease_cancels_child_without_accepting_its_result(self):
        outcomes=[]
        def consume(row,future):
            try: outcomes.append(future.result())
            except Exception as error: outcomes.append(error)
        with self.pool(timeout=30) as pool:
            loop()(pool,1,1,lambda:True,lambda:{'source_path':'slow'},consume,lambda row:False)
        self.assertIsInstance(outcomes[0],InterruptedError)

    def test_rerank_has_the_same_hard_deadline_and_can_retry(self):
        with self.pool() as pool:
            with self.assertRaises(TimeoutError):
                self.result(pool,pool.submit_rank('resist',[]))
            self.assertEqual(self.result(pool,pool.submit_rank('healthy',[])),'healthy')

    def test_stalled_child_read_cannot_block_parent_sending_or_cancelling(self):
        with InferencePool(1,timeout=.2,command=[sys.executable,'-c','import time;time.sleep(60)']) as pool:
            start=time.monotonic()
            future=pool.submit_rank('large',[{'text':'x'*1000000}])
            with self.assertRaises(TimeoutError): self.result(pool,future)
            self.assertLess(time.monotonic()-start,2)


if __name__=='__main__': unittest.main()
