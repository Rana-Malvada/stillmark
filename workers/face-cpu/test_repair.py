import json
import unittest
from unittest import mock

import numpy as np
import repair


class RepairTests(unittest.TestCase):
    def record(self, row):
        return {**dict(zip(('box_x','box_y','box_w','box_h'), repair.box(row, 3200, 2400))), 'embedding': json.dumps([1., 0.])}

    def test_reproduces_legacy_dimensions_but_repairs_only_positions(self):
        row = np.array([100,150,60,80,115,170,145,170,130,190,120,210,140,210,.95], np.float32)
        empty = np.zeros((0,15),np.float32)
        replies = [empty]+[row[None] if (x,y)==(1088,1088) else empty for y in repair.faces._tiles(2400) for x in repair.faces._tiles(3200)]
        with mock.patch.object(repair.faces, '_detect', side_effect=replies):
            pairs = repair.candidates(None, np.zeros((2400,3200,3),np.uint8))
        self.assertEqual(len(pairs),1)
        old,fixed=pairs[0]
        np.testing.assert_array_equal(old[:4],[1188,1238,1148,1168])
        np.testing.assert_array_equal(fixed[:4],[1188,1238,60,80])
        np.testing.assert_array_equal(old[4:],fixed[4:])
        match=repair.match_record(self.record(old),pairs,3200,2400,lambda *_:np.array([1.,0.]))
        self.assertEqual(match[0],0)

    def test_rejects_wrong_face_even_when_box_matches(self):
        row=np.array([100,100,60,80]+[0]*10+[.95],np.float32)
        for vector in [[0.,1.],[0.,0.],[float('nan'),0.]]:
            self.assertIsNone(repair.match_record(self.record(row),[(row,row)],3200,2400,lambda *_:np.array(vector)))

    def test_rejects_changed_geometry_or_ambiguous_repair(self):
        row=np.array([100,100,60,80]+[0]*10+[.95],np.float32)
        different=row.copy();different[0]+=5
        embed=lambda *_:np.array([1.,0.])
        self.assertIsNone(repair.match_record(self.record(row),[(different,different)],3200,2400,embed))
        self.assertIsNone(repair.match_record(self.record(row),[(row,row),(row,different)],3200,2400,embed))

    def test_accepts_identical_duplicate_candidates(self):
        row=np.array([100,100,60,80]+[0]*10+[.95],np.float32)
        self.assertIsNotNone(repair.match_record(self.record(row),[(row,row),(row,row.copy())],3200,2400,lambda *_:np.array([1.,0.])))


if __name__=='__main__':
    unittest.main()
