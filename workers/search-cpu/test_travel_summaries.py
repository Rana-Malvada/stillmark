import unittest
from unittest.mock import Mock, patch
from travel_summaries import refresh_travel_summaries


class TravelSummaryTests(unittest.TestCase):
    def test_disabled_does_nothing(self):
        db, heartbeat = Mock(), Mock()
        with patch.dict('os.environ', {'TRAVEL_SUMMARIES_ENABLED': 'false'}):
            self.assertEqual(refresh_travel_summaries(db, heartbeat), 0)
        db.execute.assert_not_called()
        heartbeat.assert_not_called()

    def test_budget_and_empty_queue(self):
        db, heartbeat = Mock(), Mock(return_value=True)
        db.execute.return_value.fetchone.side_effect = [{'event_id': 1}, {'event_id': None}]
        with patch.dict('os.environ', {'TRAVEL_SUMMARIES_ENABLED': 'true', 'TRAVEL_SUMMARY_MAX_ALBUMS': '3'}):
            self.assertEqual(refresh_travel_summaries(db, heartbeat), 1)
        self.assertEqual(db.execute.call_count, 2)
        db.execute.assert_called_with('SELECT photo_security.refresh_travel_summary() AS event_id')

    def test_limit_and_cancellation(self):
        for alive, expected in [(True, 2), (False, 0)]:
            db, heartbeat = Mock(), Mock(return_value=alive)
            db.execute.return_value.fetchone.return_value = {'event_id': 1}
            with patch.dict('os.environ', {'TRAVEL_SUMMARIES_ENABLED': 'true', 'TRAVEL_SUMMARY_MAX_ALBUMS': '2'}):
                self.assertEqual(refresh_travel_summaries(db, heartbeat), expected)
            self.assertEqual(db.execute.call_count, expected)

    def test_failure_and_invalid_limit_are_not_reported_as_success(self):
        db = Mock()
        db.execute.side_effect = RuntimeError('query failed')
        with patch.dict('os.environ', {'TRAVEL_SUMMARIES_ENABLED': 'true', 'TRAVEL_SUMMARY_MAX_ALBUMS': '2'}):
            with self.assertRaises(RuntimeError): refresh_travel_summaries(db, lambda: True)
        for value in ['0', '1001', 'bad']:
            with patch.dict('os.environ', {'TRAVEL_SUMMARIES_ENABLED': 'true', 'TRAVEL_SUMMARY_MAX_ALBUMS': value}):
                with self.assertRaises(ValueError): refresh_travel_summaries(Mock(), lambda: True)
