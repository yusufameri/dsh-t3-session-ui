#!/usr/bin/env python3
"""Pillow-only imaging helpers for the dsh-t3-session-ui capture harness.

This machine has no ffmpeg, no ImageMagick, and no Playwright/Puppeteer, so the
whole pipeline is Chrome headless (screenshots) plus Pillow (cropping, animated
GIF assembly, and verification).

Subcommands
-----------
crop    Crop a captured PNG to an exact box, so every asset is framed with the
        same padding regardless of how tall the rendered surface happened to be.
gif     Assemble PNG frames into one animated GIF. All frames are quantised
        against a single palette built from every frame, which both stops the
        palette from flickering between frames and compresses far better than a
        per-frame palette.
verify  Assert that every generated asset is real: non-blank, not a flat
        colour, unclipped, correctly framed, and (for GIFs) animated and
        infinite-looping. Writes a JSON report and exits non-zero on failure.

Run `python3 tools/imaging.py <subcommand> --help` for usage.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

try:
    from PIL import Image, ImageChops, ImageStat
except ImportError as error:  # pragma: no cover - environment guard
    sys.stderr.write(f"Pillow is required: {error}\n")
    raise SystemExit(2) from error


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    """Parse `#rrggbb` into an RGB triple."""
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"expected #rrggbb, got {value!r}")
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))


def die(message: str) -> None:
    """Print a failure to stderr and exit non-zero."""
    sys.stderr.write(f"imaging: {message}\n")
    raise SystemExit(1)


# --------------------------------------------------------------------- crop


def cmd_crop(args: argparse.Namespace) -> int:
    source = Image.open(args.input)
    x, y, width, height = (int(part) for part in args.box.split(","))
    if width <= 0 or height <= 0:
        die(f"refusing to crop to a non-positive box: {args.box}")
    if x < 0 or y < 0 or x + width > source.width or y + height > source.height:
        die(
            f"crop box {args.box} falls outside the {source.width}x{source.height} capture; "
            "the render window was too small"
        )
    cropped = source.convert("RGB").crop((x, y, x + width, y + height))
    cropped.save(args.output, format="PNG", optimize=True)
    return 0


# ---------------------------------------------------------------------- gif


def cmd_gif(args: argparse.Namespace) -> int:
    frames = [Image.open(path).convert("RGB") for path in args.frames]
    if not frames:
        die("no frames given")

    width, height = frames[0].size
    for index, frame in enumerate(frames):
        if frame.size != (width, height):
            die(f"frame {index} is {frame.size}, expected {width}x{height}")

    background = hex_to_rgb(args.background)
    # One shared palette, taken from every frame stacked together.
    sheet = Image.new("RGB", (width, height * len(frames)), background)
    for index, frame in enumerate(frames):
        sheet.paste(frame, (0, index * height))
    palette = sheet.quantize(colors=args.colors, method=Image.MEDIANCUT)

    quantised = [frame.quantize(palette=palette, dither=Image.NONE) for frame in frames]
    quantised[0].save(
        args.output,
        format="GIF",
        save_all=True,
        append_images=quantised[1:],
        duration=args.duration,
        loop=0,
        optimize=True,
        disposal=2,
    )
    return 0


# ------------------------------------------------------------------- verify


def frame_border(image: Image.Image) -> tuple[bool, tuple[int, int, int], int]:
    """Summarise the outermost one-pixel frame.

    Returns `(uniform, first_colour, max_delta)`. The padding band is bare page
    background, so a small max_delta proves the surface was framed with room to
    spare rather than cut off at the edge. A few levels of tolerance covers the
    card's soft drop shadow, which legitimately tints the far edge by a hair —
    a clipped render would show the card's own background or text instead, at a
    delta of hundreds.
    """
    pixels = image.load()
    width, height = image.size
    samples = [pixels[x, 0] for x in range(width)]
    samples += [pixels[x, height - 1] for x in range(width)]
    samples += [pixels[0, y] for y in range(height)]
    samples += [pixels[width - 1, y] for y in range(height)]
    first = samples[0]
    max_delta = max(abs(sample[channel] - first[channel]) for sample in samples for channel in range(3))
    return all(sample == first for sample in samples), first, max_delta


def inspect_png(path: str, expect: dict[str, Any]) -> dict[str, Any]:
    """Measure one PNG and check every non-blank / unclipped invariant."""
    image = Image.open(path)
    rgb = image.convert("RGB")
    colors = rgb.getcolors(maxcolors=1 << 24) or []
    distinct = len(colors)
    background = hex_to_rgb(expect["background"])
    content_pixels = sum(count for count, colour in colors if colour != background)
    total = rgb.width * rgb.height
    uniform, border_colour, border_delta = frame_border(rgb)
    border_tolerance = expect.get("border_tolerance", 6)
    luminance_stddev = ImageStat.Stat(rgb.convert("L")).stddev[0]

    checks = {
        # A real render has text antialiasing, borders and icons, so it carries
        # far more than a handful of colours.
        "distinct_colors": distinct,
        "min_distinct_colors": expect.get("min_distinct_colors", 24),
        "luminance_stddev": round(luminance_stddev, 3),
        "min_luminance_stddev": expect.get("min_luminance_stddev", 3.0),
        "content_fraction": round(content_pixels / total, 4),
        "min_content_fraction": expect.get("min_content_fraction", 0.02),
        # The crop leaves a padding band of bare page background on all four
        # sides, so a flat, expected-coloured border proves nothing was cut off.
        "border_uniform": uniform,
        "border_colour": list(border_colour),
        "border_max_delta": border_delta,
        "border_tolerance": border_tolerance,
        "expected_background": list(background),
    }
    checks["ok"] = (
        distinct >= checks["min_distinct_colors"]
        and luminance_stddev >= checks["min_luminance_stddev"]
        and checks["content_fraction"] >= checks["min_content_fraction"]
        and border_delta <= border_tolerance
        and max(abs(border_colour[i] - background[i]) for i in range(3)) <= border_tolerance
    )
    return checks


def inspect_gif(path: str, expect: dict[str, Any]) -> dict[str, Any]:
    """Measure one GIF and check that it is a real, infinite-looping animation."""
    image = Image.open(path)
    frames = []
    try:
        while True:
            frames.append(image.convert("RGB").copy())
            image.seek(image.tell() + 1)
    except EOFError:
        pass

    sizes = sorted({frame.size for frame in frames})
    adjacent_changes = 0
    for previous, current in zip(frames, frames[1:]):
        if ImageChops.difference(previous, current).getbbox() is not None:
            adjacent_changes += 1

    per_frame_colors = [len(frame.getcolors(maxcolors=1 << 24) or []) for frame in frames]
    checks = {
        "frames": len(frames),
        "expected_frames": expect["frames"],
        "dimensions": list(frames[0].size) if frames else None,
        "frame_sizes": [list(size) for size in sizes],
        "loop": image.info.get("loop"),
        "duration_ms": image.info.get("duration"),
        "expected_duration_ms": expect.get("duration_ms"),
        "distinct_adjacent_frames": adjacent_changes + 1,
        "per_frame_distinct_colors": per_frame_colors,
        "min_per_frame_distinct_colors": expect.get("min_distinct_colors", 16),
    }
    checks["ok"] = (
        len(frames) == expect["frames"]
        and len(sizes) == 1
        and image.info.get("loop") == 0
        and (expect.get("duration_ms") is None or image.info.get("duration") == expect["duration_ms"])
        # Every frame must differ from its neighbour, or the "animation" is a
        # still image with extra steps.
        and adjacent_changes == max(0, len(frames) - 1)
        and min(per_frame_colors, default=0) >= checks["min_per_frame_distinct_colors"]
    )
    return checks


def cmd_verify(args: argparse.Namespace) -> int:
    with open(args.manifest, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    report: list[dict[str, Any]] = []
    failures: list[str] = []
    for item in manifest["assets"]:
        path = item["path"]
        if item["kind"] == "png":
            checks = inspect_png(path, item["expect"])
        else:
            checks = inspect_gif(path, item["expect"])
        byte_size = __import__("os").path.getsize(path)
        budget = item.get("max_bytes")
        if budget is not None and byte_size > budget:
            checks["ok"] = False
            checks["max_bytes"] = budget
        entry = {
            "path": path,
            "kind": item["kind"],
            "bytes": byte_size,
            "dimensions": checks["dimensions"] if item["kind"] == "gif" else list(Image.open(path).size),
            "label": item.get("label"),
            "checks": checks,
        }
        report.append(entry)
        if not checks["ok"]:
            failures.append(path)

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump({"assets": report}, handle, indent=2)
        handle.write("\n")

    for entry in report:
        checks = entry["checks"]
        width, height = entry["dimensions"]
        status = "ok " if checks["ok"] else "FAIL"
        detail = (
            f"colors={checks['distinct_colors']:>6} stddev={checks['luminance_stddev']:>6} "
            f"border={'flat' if checks['border_uniform'] else 'ragged'}"
            if entry["kind"] == "png"
            else f"frames={checks['frames']} loop={checks['loop']} duration={checks['duration_ms']}ms "
            f"changed={checks['distinct_adjacent_frames']}"
        )
        print(f"{status} {entry['path']}: {width}x{height} {entry['bytes']}B {detail}")

    if failures:
        sys.stderr.write(f"imaging: {len(failures)} asset(s) failed verification: {', '.join(failures)}\n")
        return 1
    print(f"verified {len(report)} assets")
    return 0


# ---------------------------------------------------------------------- cli


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    crop = sub.add_parser("crop", help="crop a PNG to an exact box")
    crop.add_argument("--input", required=True)
    crop.add_argument("--output", required=True)
    crop.add_argument("--box", required=True, help="x,y,width,height in pixels")
    crop.set_defaults(func=cmd_crop)

    gif = sub.add_parser("gif", help="assemble PNG frames into an animated GIF")
    gif.add_argument("--output", required=True)
    gif.add_argument("--frames", nargs="+", required=True)
    gif.add_argument("--duration", type=int, required=True, help="per-frame duration in ms")
    gif.add_argument("--colors", type=int, default=128, help="shared palette size")
    gif.add_argument("--background", default="#0d0d0d")
    gif.set_defaults(func=cmd_gif)

    verify = sub.add_parser("verify", help="verify generated assets")
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--out", required=True)
    verify.set_defaults(func=cmd_verify)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
