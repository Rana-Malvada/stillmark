"""Exercise the actual warm scan loop without inference or external services."""
import unittest
from unittest.mock import Mock, patch
from test_publication import load_worker


class WarmIdle(unittest.TestCase):
    def make_job(self):
        worker = load_worker()
        job = worker.Job.__new__(worker.Job)
        job.run = 'test-run'
        job.deadline = 100
        job.db = Mock()
        job.db.execute.return_value.fetchall.return_value = [('owner',)]
        job.db.execute.return_value.fetchone.return_value = [False,100]
        job.organize = Mock(return_value={'matched': 1, 'groups': 0, 'merged': 0})
        job.merge_unnamed = Mock(return_value=0)
        def merge_slice():
            job.organization_pending=False
            return 0
        job.merge_slice = Mock(side_effect=merge_slice)
        job.close = Mock()
        job.heartbeat = Mock(return_value=True)
        return worker, job

    def test_same_job_reuses_models_and_organizes_before_idle(self):
        worker, job = self.make_job()
        job.scan = Mock(side_effect=[(2, 0, True), (1, 0, True)])
        job.idle_state = Mock(side_effect=['idle', 'work', 'idle', 'closed'])
        with patch.object(worker.time, 'monotonic', return_value=0), patch.object(worker.time, 'sleep') as sleep:
            def during_wait(_):
                self.assertGreater(job.organize.call_count, 0)
                job.close.assert_not_called()
            sleep.side_effect=during_wait
            job.run_job()
        self.assertEqual(job.scan.call_count,2)
        self.assertEqual(job.organize.call_count,2)
        self.assertEqual(sleep.call_count,2)
        job.close.assert_called_once()
        self.assertEqual(job.db.execute.call_args.args[1],('test-run','completed',None))

    def test_original_deadline_is_not_reset_by_warm_wait(self):
        worker, job = self.make_job()
        job.scan = Mock(return_value=(1,0,False))
        job.idle_state=Mock()
        with patch.object(worker.time, 'monotonic', return_value=0):
            job.run_job()
        job.idle_state.assert_not_called()
        self.assertEqual(job.deadline,100)
        self.assertEqual(job.db.execute.call_args.args[1][1], 'attention')
        job.close.assert_called_once()

    def test_organization_only_continuation_revisits_previous_owners(self):
        worker, job = self.make_job()
        job.db.execute.return_value.fetchone.return_value = [True, 100]
        job.scan = Mock(return_value=(0,0,True))
        job.idle_state = Mock(return_value='closed')
        with patch.object(worker.time,'monotonic',return_value=0):
            job.run_job()
        job.organize.assert_called_once_with('owner')
        self.assertEqual(job.db.execute.call_args.args[1][1], 'completed')

    def test_interrupted_clustering_remains_pending_for_same_cycle(self):
        worker, job = self.make_job()
        job.scan = Mock(return_value=(1,0,True))
        job.organize.side_effect = worker.ClusteringInterrupted('deadline')
        with patch.object(worker.time,'monotonic',return_value=0):
            job.run_job()
        self.assertTrue(job.organization_pending)
        self.assertEqual(job.db.execute.call_args.args[1][1], 'attention')
        job.merge_slice.assert_not_called()
        job.close.assert_called_once()

    def test_merge_keeps_one_pending_owner_until_finished(self):
        worker, job = self.make_job()
        del job.merge_slice
        job.owners = Mock(return_value=[('a',),('b',),('c',)])
        job.merge_owner='b'
        job.merge_at=0.8
        with patch.object(worker,'has_pending',return_value=True):
            job.merge_slice()
            job.merge_slice()
        self.assertEqual(job.merge_unnamed.call_args_list[0].args, ('b',))
        self.assertEqual(job.merge_unnamed.call_args_list[1].args, ('b',))
        self.assertTrue(job.organization_pending)

    def test_close_pool_even_if_sealing_loses_database_connection(self):
        worker, job=self.make_job()
        job.scan=Mock(return_value=(0,0,False))
        job.db.execute.side_effect=ConnectionError('lost')
        with patch.object(worker.time,'monotonic',return_value=0), self.assertRaises(ConnectionError):
            job.run_job()
        job.close.assert_called_once()

if __name__ == '__main__':
    unittest.main()
