"""ChArUco calibration boards for 3D from both phones (calib.py), and printable PDFs of them.

Two boards, told apart by their marker ids so one can never be taken for the other:
  lens  7 x 9 squares of 25 mm on letter paper, waved in front of each phone once to measure its lens.
  mat   5 x 7 squares of 150 mm (0.75 x 1.05 m), laid flat on the mat at the ball each session, so
        both phones' positions come out in golf axes. From hand height 3 m away the board is seen
        almost edge-on, so its squares have to be this big to be found at all.

  python board.py lens                      board-lens.pdf, one letter page
  python board.py mat                       board-mat.pdf, one page the board's size, for a print shop
  python board.py mat --tile letter         the same on letter pages to tape together
  python board.py mat --square-mm 120       a smaller mat board (say so to calib.py too)

Print at "Actual size" (not "Fit to page"), then check the 100 mm line on the page with a ruler:
the lens board's scale doesn't matter, the mat board's does (it sets every distance in inches).

Board coordinates are OpenCV's: origin at the board's top-left corner as printed, x to the right,
y down the page, z into the paper; the mat board's arrows say which way it goes on the mat (x toward
the target, y away from the golfer).
"""
import argparse
import sys
import zlib
from dataclasses import dataclass, replace
from pathlib import Path

import cv2
import numpy as np

DICTIONARY = cv2.aruco.DICT_4X4_100
MM_PER_INCH = 25.4
PT_PER_MM = 72 / MM_PER_INCH
LETTER_MM = (215.9, 279.4)
# Room left at the page edges for printers that can't print to the edge.
PAGE_MARGIN_MM = 10
# Tiles overlap by this much, so pages can be lined up on the printed squares.
TILE_OVERLAP_MM = 10


@dataclass(frozen=True)
class Spec:
    name: str
    squares: tuple        # (across, down)
    square_mm: float
    marker_mm: float
    first_id: int         # marker ids first_id, first_id + 1, ...

    @property
    def size_mm(self):
        return self.squares[0] * self.square_mm, self.squares[1] * self.square_mm

    def markers(self) -> int:
        return self.squares[0] * self.squares[1] // 2

    def to_json(self) -> dict:
        return {"name": self.name, "squares": list(self.squares), "squareMm": self.square_mm,
                "markerMm": self.marker_mm, "firstId": self.first_id, "dictionary": "DICT_4X4_100"}


LENS = Spec("lens", (7, 9), 25.0, 18.0, 0)
MAT = Spec("mat", (5, 7), 150.0, 110.0, 50)
SPECS = {s.name: s for s in (LENS, MAT)}


def spec_from_json(d: dict) -> Spec:
    return Spec(d["name"], tuple(d["squares"]), float(d["squareMm"]), float(d["markerMm"]), int(d["firstId"]))


def sized(spec: Spec, square_mm: float | None) -> Spec:
    """The spec with another square size (as measured on the print); the marker keeps its share."""
    if not square_mm:
        return spec
    return replace(spec, square_mm=square_mm, marker_mm=spec.marker_mm * square_mm / spec.square_mm)


def charuco(spec: Spec, unit_mm: float = 1000.0):
    """The OpenCV board; lengths in metres by default (unit_mm = millimetres per unit)."""
    d = cv2.aruco.getPredefinedDictionary(DICTIONARY)
    ids = np.arange(spec.first_id, spec.first_id + spec.markers(), dtype=np.int32)
    return cv2.aruco.CharucoBoard(spec.squares, spec.square_mm / unit_mm, spec.marker_mm / unit_mm, d, ids)


def shapes(spec: Spec) -> list[tuple[float, float, float, float, bool]]:
    """The board as rectangles (x, y, w, h, black) in mm, board coordinates, drawn in order on white.

    Taken from OpenCV's own board (which squares are black, where each marker sits), so the print
    is exactly what the detector expects; each marker is a black square with its white bits on it.
    """
    b = charuco(spec, unit_mm=1.0)
    sq = spec.square_mm
    # Which squares are black, from OpenCV's picture of the board: near its corner a marker square
    # is white (the marker sits in the middle).
    n = 40
    img = b.generateImage((spec.squares[0] * n, spec.squares[1] * n), marginSize=0, borderBits=1)
    out = []
    for j in range(spec.squares[1]):
        for i in range(spec.squares[0]):
            if img[j * n + 2, i * n + 2] < 128:
                out.append((i * sq, j * sq, sq, sq, True))
    d = cv2.aruco.getPredefinedDictionary(DICTIONARY)
    for mid, corners in zip(b.getIds().ravel(), b.getObjPoints()):
        x0, y0 = float(corners[0][0]), float(corners[0][1])
        bits = d.generateImageMarker(int(mid), 6, borderBits=1)
        cell = spec.marker_mm / 6
        # The marker black, then its white bits on top: no seams between black cells in print.
        out.append((x0, y0, spec.marker_mm, spec.marker_mm, True))
        for r in range(6):
            c = 0
            while c < 6:
                if bits[r, c] >= 128:
                    start = c
                    while c < 6 and bits[r, c] >= 128:
                        c += 1
                    out.append((x0 + start * cell, y0 + r * cell, (c - start) * cell, cell, False))
                else:
                    c += 1
    return out


def render(spec: Spec, px_per_mm: float, margin_mm: float = 0.0) -> np.ndarray:
    """The board as a grayscale picture, white round it; board (x, y) mm is pixel
    ((x + margin) * px_per_mm, (y + margin) * px_per_mm), edges on pixel boundaries."""
    w, h = spec.size_mm
    img = np.full((round((h + 2 * margin_mm) * px_per_mm), round((w + 2 * margin_mm) * px_per_mm)), 255, np.uint8)
    for x, y, rw, rh, black in shapes(spec):
        x0, y0 = round((x + margin_mm) * px_per_mm), round((y + margin_mm) * px_per_mm)
        x1, y1 = round((x + rw + margin_mm) * px_per_mm), round((y + rh + margin_mm) * px_per_mm)
        img[y0:y1, x0:x1] = 0 if black else 255
    return img


# ---- PDF: vector rectangles and a little text, no library needed ----

class Page:
    """One PDF page, in mm from its top-left corner."""

    def __init__(self, w_mm: float, h_mm: float):
        self.w, self.h = w_mm, h_mm
        self.ops: list[str] = []

    def rect(self, x, y, w, h, fill=True, width=0.3, white=False):
        # PDF's y runs up from the bottom of the page.
        args = f"{x * PT_PER_MM:.3f} {(self.h - y - h) * PT_PER_MM:.3f} {w * PT_PER_MM:.3f} {h * PT_PER_MM:.3f} re"
        self.ops.append((f"1 g {args} f 0 g" if white else f"{args} f") if fill else f"{width * PT_PER_MM:.2f} w {args} S")

    def line(self, x0, y0, x1, y1, width=0.3):
        self.ops.append(f"{width * PT_PER_MM:.2f} w {x0 * PT_PER_MM:.3f} {(self.h - y0) * PT_PER_MM:.3f} m "
                        f"{x1 * PT_PER_MM:.3f} {(self.h - y1) * PT_PER_MM:.3f} l S")

    def text(self, x, y, s, size_mm=4.0, angle=0):
        s = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        pt = size_mm * PT_PER_MM
        c, si = np.cos(np.radians(angle)), np.sin(np.radians(angle))
        self.ops.append(f"BT /F1 {pt:.2f} Tf {c:.4f} {si:.4f} {-si:.4f} {c:.4f} {x * PT_PER_MM:.3f} "
                        f"{(self.h - y) * PT_PER_MM:.3f} Tm ({s}) Tj ET")

    def arrow(self, x0, y0, x1, y1, width=0.8):
        self.line(x0, y0, x1, y1, width)
        d = np.array([x1 - x0, y1 - y0], float)
        d /= np.linalg.norm(d)
        n = np.array([-d[1], d[0]])
        head = 6
        for s in (1, -1):
            p = np.array([x1, y1]) - head * d + s * head * 0.5 * n
            self.line(x1, y1, p[0], p[1], width)


def write_pdf(path: Path, pages: list[Page]) -> None:
    objs = [None, None, None]  # 1 catalog, 2 pages, 3 font
    kids = []
    for p in pages:
        stream = zlib.compress("\n".join(p.ops).encode("latin-1"))
        objs.append(f"<< /Length {len(stream)} /Filter /FlateDecode >>".encode() + b"\nstream\n" + stream + b"\nendstream")
        content = len(objs)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {p.w * PT_PER_MM:.3f} {p.h * PT_PER_MM:.3f}] "
                    f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content} 0 R >>".encode())
        kids.append(len(objs))
    objs[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    objs[2] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def draw_board(page: Page, spec: Spec, ox: float, oy: float, clip=None) -> None:
    """The board with its top-left corner at (ox, oy) on the page; only the part inside `clip`
    (x0, y0, x1, y1 in board mm), if given."""
    for x, y, w, h, black in shapes(spec):
        if clip:
            x0, y0 = max(x, clip[0]), max(y, clip[1])
            x1, y1 = min(x + w, clip[2]), min(y + h, clip[3])
            if x1 <= x0 or y1 <= y0:
                continue
            x, y, w, h = x0, y0, x1 - x0, y1 - y0
        page.rect(ox + x, oy + y, w, h, white=not black)


def ruler(page: Page, x: float, y: float) -> None:
    page.line(x, y, x + 100, y, 0.4)
    for k in range(0, 101, 10):
        page.line(x + k, y - (3 if k % 50 == 0 else 1.5), x + k, y, 0.3)
    page.text(x, y + 5, "100 mm: check with a ruler after printing (print at Actual size)", 3)


def labels(page: Page, spec: Spec, ox: float, oy: float) -> None:
    """What the board is, and for the mat board which way it goes."""
    w, h = spec.size_mm
    page.text(ox, oy - 4, f"SwingClips {spec.name} board: {spec.squares[0]} x {spec.squares[1]} squares of "
              f"{spec.square_mm:g} mm, markers {spec.marker_mm:g} mm (ids {spec.first_id}+)", min(4, spec.square_mm / 6))
    if spec.name == "mat":
        page.arrow(ox, oy + h + 12, ox + min(200, w), oy + h + 12)
        page.text(ox, oy + h + 22, "x: TARGET this way (along the target line)", 7)
        page.arrow(ox + w + 12, oy, ox + w + 12, oy + min(200, h))
        page.text(ox + w + 20, oy, "y: AWAY FROM THE GOLFER (toward the face-on phone)", 7, angle=-90)
        # Ticks at the middle of each edge: the board's centre goes where the ball sits.
        for x0, y0, x1, y1 in ((ox + w / 2, oy - 8, ox + w / 2, oy), (ox + w / 2, oy + h, ox + w / 2, oy + h + 8),
                               (ox - 8, oy + h / 2, ox, oy + h / 2), (ox + w, oy + h / 2, ox + w + 8, oy + h / 2)):
            page.line(x0, y0, x1, y1, 0.8)
        page.text(ox + w / 2 + 2, oy + h + 7, "centre: on the ball", 4)


def lens_pdf(spec: Spec) -> list[Page]:
    page = Page(*LETTER_MM)
    w, h = spec.size_mm
    ox, oy = (LETTER_MM[0] - w) / 2, 22
    labels(page, spec, ox, oy)
    draw_board(page, spec, ox, oy)
    ruler(page, ox, oy + h + 12)
    page.text(ox, oy + h + 24, "Glue or tape it flat to something stiff (foam board). Wave it slowly in front of the", 3)
    page.text(ox, oy + h + 28, "phone in its recording mode: near and far, tilted, into every corner of the picture.", 3)
    return [page]


def mat_pdf(spec: Spec) -> list[Page]:
    w, h = spec.size_mm
    margin = 45
    page = Page(w + 2 * margin, h + 2 * margin)
    labels(page, spec, margin, margin)
    draw_board(page, spec, margin, margin)
    ruler(page, margin, margin + h + 35)
    return [page]


def tiled_pdf(spec: Spec, paper=LETTER_MM) -> list[Page]:
    """The board across as many pages as it takes, each with a strip of overlap to line up on and
    its place in the grid; trim the white margin off one page of each overlap."""
    w, h = spec.size_mm
    usable = (paper[0] - 2 * PAGE_MARGIN_MM, paper[1] - 2 * PAGE_MARGIN_MM - 12)
    step = (usable[0] - TILE_OVERLAP_MM, usable[1] - TILE_OVERLAP_MM)
    cols = max(1, int(np.ceil((w - TILE_OVERLAP_MM) / step[0])))
    rows = max(1, int(np.ceil((h - TILE_OVERLAP_MM) / step[1])))
    pages = []
    for r in range(rows):
        for c in range(cols):
            x0, y0 = c * step[0], r * step[1]
            clip = (x0, y0, min(w, x0 + usable[0]), min(h, y0 + usable[1]))
            p = Page(*paper)
            ox, oy = PAGE_MARGIN_MM - x0, PAGE_MARGIN_MM + 12 - y0
            draw_board(p, spec, ox, oy, clip)
            p.rect(PAGE_MARGIN_MM, PAGE_MARGIN_MM + 12, clip[2] - clip[0], clip[3] - clip[1], fill=False, width=0.1)
            p.text(PAGE_MARGIN_MM, PAGE_MARGIN_MM + 4, f"{spec.name} board, row {r + 1} of {rows}, column {c + 1} of {cols} "
                   f"(overlap {TILE_OVERLAP_MM} mm: line up the squares). Top of the board is up.", 3.2)
            if r == 0 and c == 0:
                p.text(PAGE_MARGIN_MM, PAGE_MARGIN_MM + 9, "x (target) runs to the right, y (away from the golfer) down.", 3.2)
            if r == rows - 1 and c == 0:
                ruler(p, PAGE_MARGIN_MM + 5, paper[1] - PAGE_MARGIN_MM - 8)
            pages.append(p)
    return pages


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("board", choices=sorted(SPECS))
    ap.add_argument("--out", type=Path, help="the PDF (default board-<board>.pdf)")
    ap.add_argument("--tile", choices=["letter"], help="split a large board over letter pages")
    ap.add_argument("--square-mm", type=float, help="another square size (the markers scale with it)")
    args = ap.parse_args(argv)
    spec = sized(SPECS[args.board], args.square_mm)
    if spec.name == "lens" and spec.size_mm[1] > LETTER_MM[1] - 50:
        ap.error("that lens board doesn't fit on letter paper")
    pages = tiled_pdf(spec) if args.tile else lens_pdf(spec) if spec.name == "lens" else mat_pdf(spec)
    out = args.out or Path(f"board-{spec.name}{'-tiled' if args.tile else ''}.pdf")
    write_pdf(out, pages)
    w, h = spec.size_mm
    print(f"{out}: {spec.name} board {w:g} x {h:g} mm on {len(pages)} page(s)"
          + (f" of {pages[0].w:.0f} x {pages[0].h:.0f} mm" if not args.tile else " of letter"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
