import tempfile,unittest
from pathlib import Path
from worker import source_file,ordered_ids,Models
class WorkerTests(unittest.TestCase):
    def test_paths(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'ok').write_bytes(b'ok')
            self.assertEqual(source_file(root,'ok'),Path(root)/'ok')
            with self.assertRaises((ValueError,FileNotFoundError)):source_file(root,'../escape')
    def test_rank_validation(self):
        self.assertEqual(ordered_ids([{'id':1},{'id':2}],[0,1]),[2,1])
        with self.assertRaises(ValueError):ordered_ids([{'id':1}],[float('nan')])
    def test_model_offline(self):
        from PIL import Image,ImageDraw,ImageFont
        with tempfile.TemporaryDirectory() as root:
            image=Image.new('RGB',(1000,400),'white')
            draw=ImageDraw.Draw(image)
            draw.text((50,100),'MOTOCROSS 6',fill='black',font=ImageFont.load_default(size=60))
            path=Path(root)/'sample.png';image.save(path)
            model=Models();text,confidence,vector=model.photo(path)
            self.assertIn('MOTOCROSS',text)
            self.assertEqual(len(vector),512)
            docs=[{'id':1,'text':'A man eating dinner at a restaurant table with plates of food.'},{'id':2,'text':'A motorcycle rider racing on a dirt track.'}]
            self.assertEqual(model.rank('eating at a restaurant',docs)[0],1)

    def test_heic_ocr_and_embedding(self):
        import hashlib
        from PIL import Image, ImageDraw, ImageFont
        from pillow_heif import from_pillow
        with tempfile.TemporaryDirectory() as root:
            image = Image.new('RGB', (1000, 400), 'white')
            ImageDraw.Draw(image).text((50, 100), 'MOTOCROSS 6', fill='black',
                                      font=ImageFont.load_default(size=60))
            path = Path(root) / 'sample.heic'
            from_pillow(image).save(path, quality=95)
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            text, confidence, vector = Models().photo(path)
            self.assertIn('MOTOCROSS', text)
            self.assertEqual(len(vector), 512)
            self.assertAlmostEqual(sum(v*v for v in vector), 1, places=5)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)

class ParallelTests(unittest.TestCase):
    def test_bounded_warm_pool_runs_actual_photo_and_ranking_models(self):
        import time
        from unittest.mock import patch
        from PIL import Image, ImageDraw, ImageFont
        from inference_pool import InferencePool
        with tempfile.TemporaryDirectory() as root:
            image=Image.new('RGB',(600,200),'white')
            ImageDraw.Draw(image).text((20,50),'RACE 6',fill='black',font=ImageFont.load_default(size=50))
            image.save(Path(root)/'sample.png')
            with patch.dict('os.environ',{'WORKER_INPUT':root}),InferencePool(1) as pool:
                photo=pool.submit(None,'sample.png')
                process=pool.slots[0]['process']
                while not photo.done(): pool.poll(.1)
                text,confidence,vector=photo.result()
                self.assertIn('RACE',text)
                self.assertEqual(len(vector),512)
                self.assertAlmostEqual(sum(v*v for v in vector),1,places=5)
                documents=[{'id':1,'text':'Eating dinner at a restaurant.'},
                           {'id':2,'text':'A motorcycle rider racing on a dirt track.'}]
                ranking=pool.submit_rank('eating dinner',documents)
                while not ranking.done(): pool.poll(.1)
                self.assertEqual(ranking.result()[0],1)
                self.assertIs(pool.slots[0]['process'],process)

    def test_spawned_photo_workers(self):
        import multiprocessing
        from concurrent.futures import ProcessPoolExecutor
        from unittest.mock import patch
        from PIL import Image,ImageDraw,ImageFont
        from worker import initialize_photo_worker,process_photo
        with tempfile.TemporaryDirectory() as root:
            image=Image.new('RGB',(600,200),'white')
            ImageDraw.Draw(image).text((20,50),'RACE 6',fill='black',font=ImageFont.load_default(size=50))
            image.save(Path(root)/'sample.png')
            with patch.dict('os.environ',{'WORKER_INPUT':root}),ProcessPoolExecutor(
                max_workers=4,mp_context=multiprocessing.get_context('spawn'),initializer=initialize_photo_worker
            ) as pool:
                results=list(pool.map(process_photo,['sample.png']*4))
            for text,confidence,vector in results:
                self.assertIn('RACE',text)
                self.assertEqual(len(vector),512)

    def test_four_inflight_and_exact_budget(self):
        import threading,time
        from concurrent.futures import ThreadPoolExecutor
        from unittest.mock import patch
        from worker import process_pending_photos
        lock=threading.Lock(); barrier=threading.Barrier(4)
        active=peak=claimed=0; finished=[]
        def compute(path):
            nonlocal active,peak
            with lock:
                active+=1;peak=max(peak,active)
            if path<4:barrier.wait(timeout=5)
            time.sleep(.01)
            with lock:active-=1
            return path
        def claim():
            nonlocal claimed
            row={'source_path':claimed};claimed+=1;return row
        with patch('worker.process_photo',compute),ThreadPoolExecutor(max_workers=4) as pool:
            process_pending_photos(pool,4,7,lambda:True,claim,lambda row,f:finished.append(f.result()))
        self.assertEqual(peak,4)
        self.assertEqual(claimed,7)
        self.assertEqual(sorted(finished),list(range(7)))

    def test_stop_drains_without_new_claims(self):
        import time
        from concurrent.futures import ThreadPoolExecutor
        from unittest.mock import patch
        from worker import process_pending_photos
        claimed=[];finished=[];checks=[]
        def heartbeat():
            checks.append(True);return len(checks)==1
        def claim():
            row={'source_path':len(claimed)};claimed.append(row);return row
        def compute(path):time.sleep(.01);return path
        with patch('worker.process_photo',compute),ThreadPoolExecutor(max_workers=4) as pool:
            process_pending_photos(pool,4,100,heartbeat,claim,lambda row,f:finished.append(f.result()))
        self.assertEqual(len(claimed),4)
        self.assertEqual(sorted(finished),list(range(4)))

    def test_empty_queue_and_failed_photo(self):
        from concurrent.futures import ThreadPoolExecutor
        from unittest.mock import patch
        from worker import process_pending_photos
        rows=iter([{'source_path':'broken'},None]);errors=[]
        def consume(row,future):
            try:future.result()
            except ValueError:errors.append(row['source_path'])
        with patch('worker.process_photo',side_effect=ValueError('bad image')),ThreadPoolExecutor(max_workers=4) as pool:
            process_pending_photos(pool,4,100,lambda:True,lambda:next(rows),consume)
        self.assertEqual(errors,['broken'])

if __name__=='__main__':unittest.main()
