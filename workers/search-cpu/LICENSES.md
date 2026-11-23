# Model and OCR attribution

- OpenAI CLIP ViT-B/32: OpenAI CLIP project, MIT license.
  https://github.com/openai/CLIP/blob/main/LICENSE
  https://huggingface.co/openai/clip-vit-base-patch32
- ONNX export of those weights: Xenova/clip-vit-base-patch32, pinned in
  config/search-model.json. The compatibility test checks the exported text
  encoder against the original image/text model.
  https://huggingface.co/Xenova/clip-vit-base-patch32
- MS MARCO MiniLM-L6-v2 cross-encoder: Sentence Transformers, Apache-2.0.
  https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2
- Tesseract OCR: Apache-2.0.
  https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE

Models are inference-only and do not infer face identities. Model revisions and
package versions are pinned in models.json and requirements.txt.
