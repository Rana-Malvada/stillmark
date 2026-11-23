"""Common bounded, oriented, sRGB image decoding for upload and search workers."""
import io
import warnings
from PIL import Image, ImageCms, ImageOps
from pillow_heif import register_heif_opener

MAX_PIXELS = 80_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
register_heif_opener(thumbnails=False)


def decode_image(source, max_edge=2400, required_format=None):
    """Return detached RGB pixels and oriented original dimensions; never write source."""
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(source) as original:
            if required_format and original.format != required_format:
                raise ValueError("Unexpected image format")
            if min(original.size) < 1 or original.width * original.height > MAX_PIXELS:
                raise ValueError("Image exceeds pixel limit")
            image = ImageOps.exif_transpose(original)
            dimensions = {"width": image.width, "height": image.height}
            image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            profile = image.info.get("icc_profile")
            if profile:
                try:
                    image = ImageCms.profileToProfile(
                        image, ImageCms.ImageCmsProfile(io.BytesIO(profile)),
                        ImageCms.createProfile("sRGB"), outputMode="RGB",
                    )
                except (ImageCms.PyCMSError, OSError) as error:
                    raise ValueError("Invalid image color profile") from error
            else:
                image = image.convert("RGB")
            # Pixels are already oriented and sRGB. Do not carry stale EXIF/ICC.
            image.info.clear()
            return image, dimensions
