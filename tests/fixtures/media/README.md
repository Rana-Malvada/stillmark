# Public test media

`astronaut.png` is the NASA photograph of Eileen Collins distributed by
scikit-image v0.25.2. Its upstream documentation identifies it as public domain
with no known copyright restrictions. It contains no application user data.

- File: https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/astronaut.png
- Attribution: https://github.com/scikit-image/scikit-image/blob/v0.25.2/skimage/data/_fetchers.py (`astronaut`)
- Original NASA image: https://flic.kr/p/r9qvLn
- SHA-256: `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`

The required worker image tests mount this read-only to exercise real detection,
rotation, embeddings and parallel processing. It is not shipped in runtime images.
