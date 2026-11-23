import json
from huggingface_hub import snapshot_download
for name, model in json.load(open('/worker/models.json')).items():
    snapshot_download(model['repo'], revision=model['revision'], local_dir='/models/'+name,
                      allow_patterns=['*.json','*.txt','*.safetensors','*.bin'],
                      ignore_patterns=['tf_model*','flax_model*','rust_model*'])
