"""Native image-format contract run in both worker images."""
import hashlib
from pathlib import Path
import tempfile
import unittest

from PIL import Image
from pillow_heif import from_pillow

from image_decode import decode_image


def decode(source, output):
    image, dimensions = decode_image(source)
    with image:
        image.save(output, "PNG")
    return dimensions


class HeifDecodeTests(unittest.TestCase):
    def test_native_hevc_decode_preserves_original_and_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "input.heic", Path(directory) / "output.png"
            image = Image.new("RGB", (3000, 1500), (210, 60, 20))
            from_pillow(image).save(source, quality=90)
            original = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(decode(source, output), {"width": 3000, "height": 1500})
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
            decode(source, output)
            with Image.open(output) as result:
                self.assertEqual(result.size, (60, 120))
                self.assertNotIn(274, result.getexif())

    def test_jpeg_and_png_use_same_orientation_and_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            for extension in ("jpg", "png"):
                source = Path(directory) / ("input." + extension)
                image = Image.new("RGB", (100, 50), "red")
                exif = image.getexif()
                exif[274] = 6
                image.save(source, exif=exif)
                result, dimensions = decode_image(source)
                with result:
                    self.assertEqual(result.size, (50, 100))
                    self.assertEqual(dimensions, {"width": 50, "height": 100})
                    self.assertEqual(result.mode, "RGB")
                    self.assertNotIn(274, result.getexif())

    def test_embedded_color_profile_becomes_srgb_pixels(self):
        from PIL import ImageCms
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "profile.png"
            profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
            Image.new("RGB", (20, 20), (50, 100, 150)).save(source, icc_profile=profile)
            result, _ = decode_image(source)
            with result:
                self.assertEqual(result.getpixel((0, 0)), (50, 100, 150))
                self.assertFalse(result.info)

    def test_corrupt_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.heic"
            source.write_bytes(b"broken")
            with self.assertRaises(OSError):
                decode(source, Path(directory) / "output.png")

    def test_pixel_limit_is_checked_before_load(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "input.heic"
            from_pillow(Image.new("RGB", (120, 60), "red")).save(source)
            old = Image.MAX_IMAGE_PIXELS
            try:
                Image.MAX_IMAGE_PIXELS = 1000
                with self.assertRaises((ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning)):
                    decode(source, Path(directory) / "output.png")
            finally:
                Image.MAX_IMAGE_PIXELS = old


if __name__ == "__main__":
    unittest.main()
