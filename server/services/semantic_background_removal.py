#!/usr/bin/env python3
import argparse
import io
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def parse_args():
    parser = argparse.ArgumentParser(description="Create a semantic person/subject cutout PNG.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--models", default="birefnet-general,isnet-general-use,u2net")
    parser.add_argument("--long-side", type=int, default=1536)
    parser.add_argument("--feather", type=float, default=1.2)
    parser.add_argument("--close-size", type=int, default=3)
    parser.add_argument("--debug-dir", default="")
    return parser.parse_args()


def resize_for_inference(image, long_side):
    width, height = image.size
    longest = max(width, height)
    if not long_side or longest <= long_side:
        return image, {"width": width, "height": height, "scaled": False}
    scale = long_side / float(longest)
    next_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    return image.resize(next_size, Image.Resampling.LANCZOS), {
        "width": next_size[0],
        "height": next_size[1],
        "scaled": True,
    }


def mask_from_model(image, model_name):
    from rembg import new_session, remove

    input_io = io.BytesIO()
    image.save(input_io, format="PNG")
    session = new_session(model_name)
    mask_bytes = remove(
        input_io.getvalue(),
        session=session,
        only_mask=True,
        post_process_mask=True,
    )
    return Image.open(io.BytesIO(mask_bytes)).convert("L")


def close_small_holes(mask, size):
    if size <= 1:
        return mask
    radius = size if size % 2 == 1 else size + 1
    return mask.filter(ImageFilter.MaxFilter(radius)).filter(ImageFilter.MinFilter(radius))


def soften_outer_edge(mask, feather):
    if feather <= 0:
        return mask
    return mask.filter(ImageFilter.GaussianBlur(radius=feather))


def main():
    args = parse_args()
    project_root = Path(__file__).resolve().parents[2]
    os.environ.setdefault("U2NET_HOME", str(project_root / ".model-cache" / "rembg"))
    os.environ.setdefault("XDG_CACHE_HOME", str(project_root / ".model-cache"))

    source = Image.open(args.input).convert("RGBA")
    inference_image, inference = resize_for_inference(source, args.long_side)
    models = [model.strip() for model in args.models.split(",") if model.strip()]
    masks = []
    failures = []

    for model in models:
        try:
            mask = mask_from_model(inference_image, model)
            masks.append((model, mask))
        except Exception as exc:
            failures.append({"model": model, "error": str(exc)})

    if not masks:
        print(json.dumps({"ok": False, "failures": failures}), file=sys.stderr)
        return 2

    mask_arrays = [np.asarray(mask, dtype=np.uint8) for _, mask in masks]
    combined = np.maximum.reduce(mask_arrays)
    combined_mask = Image.fromarray(combined, mode="L")
    debug_dir = Path(args.debug_dir) if args.debug_dir else None
    if debug_dir:
        debug_dir.mkdir(parents=True, exist_ok=True)
        source.save(debug_dir / "source.png", format="PNG")
        raw_mask = masks[0][1]
        if raw_mask.size != source.size:
            raw_mask = raw_mask.resize(source.size, Image.Resampling.NEAREST)
        raw_mask.save(debug_dir / "raw-mask.png", format="PNG")
    combined_mask = close_small_holes(combined_mask, args.close_size)
    combined_mask = soften_outer_edge(combined_mask, args.feather)
    if combined_mask.size != source.size:
        combined_mask = combined_mask.resize(source.size, Image.Resampling.BILINEAR)
    if debug_dir:
        combined_mask.save(debug_dir / "corrected-mask.png", format="PNG")

    output = source.copy()
    output.putalpha(combined_mask)
    output.save(args.output, format="PNG", compress_level=9)
    if debug_dir:
        output.save(debug_dir / "final-transparent.png", format="PNG", compress_level=9)

    print(json.dumps({
        "ok": True,
        "primaryModel": masks[0][0],
        "modelsUsed": [model for model, _ in masks],
        "failedModels": failures,
        "inferenceResolution": inference,
        "maskSettings": {
            "longSide": args.long_side,
            "feather": args.feather,
            "closeSize": args.close_size,
            "combine": "maximum"
        }
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
