"""Re-export complete avatar characters from the original sheets.

Run from the workspace root with Python 3 and ImageMagick available.
Panel boundaries and the gaps between characters were visually checked;
these sheets are not evenly divided grids. Keep IDs stable for saved profiles.
"""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "artifacts/little-nest/public/avatars"
SHEETS = {
    "animals": {
        "columns": [(17, 249), (264, 501), (516, 752), (766, 1007)],
        "rows": [(17, 234), (248, 438), (452, 639)],
        "splits": [139, 380, 644, 883, 140, 380, 635, 887, 136, 383, 638, 895],
    },
    "bugs": {
        "columns": [(17, 255), (268, 503), (516, 753), (766, 1006)],
        "rows": [(20, 224), (234, 422), (435, 614)],
        "splits": [143, 392, 644, 888, 140, 384, 637, 901, 144, 392, 647, 896],
    },
    "reptiles": {
        "columns": [(16, 254), (266, 506), (518, 754), (768, 1008)],
        "rows": [(18, 239), (250, 455), (466, 666)],
        "splits": [140, 386, 644, 890, 142, 390, 638, 894, 140, 383, 635, 895],
    },
}


def run(*args: str) -> str:
    return subprocess.check_output(["magick", *args], text=True).strip()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for category, layout in SHEETS.items():
        source = ROOT / f"attached_assets/generated_images/little-nest-{category}-avatar-sheet.png"
        if run("identify", "-format", "%wx%h", str(source)) != "1024x1024":
            raise ValueError(f"Recheck panel bounds for changed sheet: {source}")
        for panel in range(12):
            left, right = layout["columns"][panel % 4]
            top, bottom = layout["rows"][panel // 4]
            split = layout["splits"][panel]
            # Match the padding to this panel, rather than adding white bars.
            background = run(str(source), "-format", f"%[pixel:p{{{left + 12},{top + 12}}}]", "info:")
            for side, start, end in [("a", left, split), ("b", split, right)]:
                destination = OUTPUT / f"{category}-{panel + 1:02d}-{side}.webp"
                run(
                    str(source), "-crop", f"{end - start}x{bottom - top}+{start}+{top}",
                    "+repage", "-resize", "232x232", "-background", background,
                    "-gravity", "center", "-extent", "256x256",
                    "-quality", "90", str(destination),
                )
    print("Rebuilt 72 complete avatars, preserving all existing IDs.")


if __name__ == "__main__":
    main()