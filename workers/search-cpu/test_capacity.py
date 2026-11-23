import unittest
from unittest.mock import patch
from capacity import worker_capacity, detect_capacity

class CapacityTests(unittest.TestCase):
    def test_cpu_and_memory_each_constrain(self):
        self.assertEqual(worker_capacity(2, 8192), 2)
        self.assertEqual(worker_capacity(6, 16384), 6)
        self.assertEqual(worker_capacity(32, 4096), 2)
        self.assertEqual(worker_capacity(16, 32768), 16)
        self.assertEqual(worker_capacity(16, 32768, ceiling=4), 4)
        self.assertEqual(worker_capacity(.5, 4096), 1)
    def test_insufficient_memory_fails_closed(self):
        for memory in [512, 1024, 2000, float('nan')]:
            with self.assertRaises(ValueError): worker_capacity(8, memory)
    @patch.dict('os.environ', {'WORKER_PHOTO_WORKERS':'auto'}, clear=True)
    @patch('capacity.os.sched_getaffinity', return_value=set(range(32)), create=True)
    @patch('capacity.read')
    def test_quota_overrides_host_cpu(self, read, affinity):
        read.side_effect = lambda p: {'/sys/fs/cgroup/cpu.max':'200000 100000', '/sys/fs/cgroup/memory.max':str(8*1024**3)}.get(p)
        self.assertEqual(detect_capacity(), 2)

if __name__ == '__main__': unittest.main()
