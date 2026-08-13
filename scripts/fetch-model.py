"""Fetch the AI matting model into public/models/ (provenance script).

Model: studioludens/birefnet-lite-512 (MIT) — BiRefNet-lite exported at
512x512, fp16. This specific export is required for in-browser inference:

- The usual 1024x1024 BiRefNet-lite export (onnx-community/BiRefNet_lite-ONNX)
  contains 1024-input Concat and 32-output Split nodes whose WebGPU shaders
  bind one storage buffer per tensor, exceeding Metal's
  maxStorageBuffersPerShaderStage of 10 — macOS Chrome reports exactly 10
  with no adapter headroom, so it can never run on a Mac GPU. (Rewriting the
  graph into narrow Concat/Split trees fixes the shaders — verified
  bit-exact — but 1024x1024 inference still peaks at ~4.4GB, overflowing the
  4GB wasm32 heap of the CPU fallback.)
- The 512x512 export has narrow ops (<=7 bindings per shader) and a ~2.5GB
  CPU peak: both the WebGPU and wasm backends work, on Macs included.

Usage:
    pip install requests
    python scripts/fetch-model.py
"""

import requests

URL = 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model_fp16.onnx'
DST = 'public/models/birefnet-lite-512-fp16.onnx'

with requests.get(URL, stream=True) as r:
    r.raise_for_status()
    with open(DST, 'wb') as f:
        for chunk in r.iter_content(1 << 20):
            f.write(chunk)
print('saved', DST)
