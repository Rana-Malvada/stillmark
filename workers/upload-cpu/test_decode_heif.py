"""Run with the upload worker's Python environment: python -m unittest discover -s workers/upload-cpu."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from pillow_heif import from_pillow

spec = importlib.util.spec_from_file_location("decode_heif", Path(__file__).with_name("decode-heif.py"))
decoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(decoder)


class HeifDecodeTests(unittest.TestCase):
    def test_native_hevc_decode_preserves_original_and_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "input.heic", Path(directory) / "output.png"
            image = Image.new("RGB", (3000, 1500), (210, 60, 20))
            from_pillow(image).save(source, quality=90)
            original = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(decoder.decode(source, output), {"width": 3000, "height": 1500})
            with Image.open(output) as result:
                self.assertEqual(result.size, (2400, 1200))
                self.assertNotIn(274, result.getexif())
                self.assertGreater(result.getpixel((100, 100))[0], 190)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original)

    def test_orientation_is_applied_once(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "input.heic", Path(directory) / "output.png"
            image = Image.new("RGB", (120, 60), "red")
            image.getexif()[274] = 6
            image.info["exif"] = image.getexif().tobytes()
            image.save(source, format="HEIF")
            decoder.decode(source, output)
            with Image.open(output) as result:
                self.assertEqual(result.size, (60, 120))
                self.assertNotIn(274, result.getexif())

    def test_corrupt_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.heic"
            source.write_bytes(b"broken")
            with self.assertRaises(OSError):
                decoder.decode(source, Path(directory) / "output.png")

    def test_pixel_limit_is_checked_before_load(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.heic"
            from_pillow(Image.new("RGB", (120, 60), "red")).save(source)
            old = Image.MAX_IMAGE_PIXELS
            try:
                Image.MAX_IMAGE_PIXELS = 1000
                with self.assertRaises((ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning)):
                    decoder.decode(source, Path(directory) / "output.png")
            finally:
                Image.MAX_IMAGE_PIXELS = old


if __name__ == "__main__":
    unittest.main()
