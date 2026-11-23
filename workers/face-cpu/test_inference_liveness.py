"""Lease renewal and cancellation during native inference, including a real hung child."""
import multiprocessing
import time
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch
from test_publication import load_worker


class Result:
    def __init__(self, clock): self.clock=clock
    def get(self, timeout):
        self.clock[0]+=10
        if self.clock[0]<35: raise multiprocessing.TimeoutError()
        return []


class InferenceLiveness(unittest.TestCase):
    def job(self):
        worker=load_worker()
        job=worker.Job.__new__(worker.Job)
        job.model_paths=('detector','recognizer')
        job.parallel=1
        job.deadline=100
        job.analysis_timeout=90
        job.pool=Mock()
        job.db=Mock()
        job.db.execute.return_value.fetchone.return_value=[2]
        job.heartbeat=Mock(return_value=True)
        return worker,job

    def test_renews_claims_and_run_heartbeat_while_analysis_is_inflight(self):
        worker,job=self.job()
        clock=[0]
        job.pool.apply_async.return_value=Result(clock)
        with patch.object(worker.time,'monotonic',side_effect=lambda:clock[0]), patch.object(worker,'source_file',side_effect=lambda p:p):
            self.assertEqual(job.analyze_many(['a','b'],['token-a','token-b']),[[],[]])
        self.assertGreaterEqual(job.heartbeat.call_count,2)
        self.assertEqual(job.db.execute.call_count,job.heartbeat.call_count)
        self.assertTrue(all('renew' in c.args[0] for c in job.db.execute.call_args_list))
        job.pool.terminate.assert_not_called()

    def test_stop_terminates_inference_without_publishing(self):
        worker,job=self.job()
        pool=job.pool
        job.heartbeat.return_value=False
        with patch.object(worker.time,'monotonic',return_value=0),patch.object(worker,'source_file',side_effect=lambda p:p):
            with self.assertRaises(InterruptedError):job.analyze_many(['a'],['token'])
        pool.terminate.assert_called_once()
        pool.join.assert_called_once()
        self.assertIsNone(job.pool)

    def test_lost_lease_terminates_inference(self):
        worker,job=self.job()
        pool=job.pool
        job.db.execute.return_value.fetchone.return_value=[0]
        with patch.object(worker.time,'monotonic',return_value=0),patch.object(worker,'source_file',side_effect=lambda p:p):
            with self.assertRaises(InterruptedError):job.analyze_many(['a'],['token'])
        pool.terminate.assert_called_once()

    def test_partly_lost_claims_do_not_stop_the_batch(self):
        worker,job=self.job()
        clock=[0]
        job.pool.apply_async.return_value=Result(clock)
        job.db.execute.return_value.fetchone.return_value=[1]
        with patch.object(worker.time,'monotonic',side_effect=lambda:clock[0]), patch.object(worker,'source_file',side_effect=lambda p:p):
            self.assertEqual(job.analyze_many(['a','b'],['token-a','token-b']),[[],[]])
        job.pool.terminate.assert_not_called()

    def test_losing_every_claim_is_reported_as_claims_lost(self):
        worker,job=self.job()
        job.db.execute.return_value.fetchone.return_value=[0]
        with patch.object(worker.time,'monotonic',return_value=0),patch.object(worker,'source_file',side_effect=lambda p:p):
            with self.assertRaises(worker.ClaimsLost):job.analyze_many(['a','b'],['token-a','token-b'])

    def test_deadline_fails_only_the_hung_photo_and_keeps_finished_results(self):
        worker,job=self.job()
        clock=[0]
        class Hung:
            def get(self,timeout):
                clock[0]+=40
                raise multiprocessing.TimeoutError()
        class Finished:
            def get(self,timeout): return ['face']
        class Unfinished:
            def get(self,timeout): raise multiprocessing.TimeoutError()
        job.pool.apply_async.side_effect=[Hung(),Finished(),Unfinished()]
        pool=job.pool
        with patch.object(worker.time,'monotonic',side_effect=lambda:clock[0]), patch.object(worker,'source_file',side_effect=lambda p:p):
            result=job.analyze_many(['a','b','c'])
        self.assertIsInstance(result[0],TimeoutError)
        self.assertEqual(result[1],['face'])
        self.assertIsInstance(result[2],worker.Deferred)
        pool.terminate.assert_called_once()

    def test_real_hung_child_is_killed_at_deadline_and_does_not_block_shutdown(self):
        worker,job=self.job()
        from inference_pool import InferencePool
        def hung_child(_self):
            return subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        with patch.object(InferencePool,'_start',hung_child):
            real_pool=InferencePool(1,('detector','recognizer'))
        job.pool=real_pool
        job.deadline=time.monotonic()+.3
        job.analysis_timeout=.3
        start=time.monotonic()
        try:
            with patch.object(worker,'source_file',side_effect=lambda p:p):
                result=job.analyze_many(['a'])
            self.assertIsInstance(result[0],TimeoutError)
            self.assertLess(time.monotonic()-start,3)
            self.assertIsNone(job.pool)
            self.assertIsNotNone(real_pool.processes[0].poll())
        finally:
            real_pool.terminate()
            real_pool.join()

    def test_real_child_crash_does_not_hold_the_batch_or_shutdown(self):
        worker,job=self.job()
        from inference_pool import InferencePool
        def crashing_child(_self):
            return subprocess.Popen([sys.executable,'-c','import sys;sys.stdin.buffer.read(1);sys.exit(9)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        with patch.object(InferencePool,'_start',crashing_child):
            pool=InferencePool(1,('detector','recognizer'))
            job.pool=pool
            job.deadline=time.monotonic()+5
            start=time.monotonic()
            try:
                with patch.object(worker,'source_file',side_effect=lambda p:p):
                    result=job.analyze_many(['a'])
                self.assertIsInstance(result[0],RuntimeError)
            finally:
                job.close()
            self.assertLess(time.monotonic()-start,3)

if __name__=='__main__': unittest.main()
