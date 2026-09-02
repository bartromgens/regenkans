from __future__ import annotations

import numpy as np

ColorStop = tuple[float, tuple[int, int, int, int]]


def apply_colormap(
    values: np.ndarray,
    stops: tuple[ColorStop, ...],
    *,
    min_visible: float,
) -> np.ndarray:
    rgba = np.zeros((*values.shape, 4), dtype=np.uint8)
    valid = np.isfinite(values) & (values >= min_visible)
    if not np.any(valid):
        return rgba

    for index, (stop, color) in enumerate(stops):
        lower = stop
        upper = stops[index + 1][0] if index + 1 < len(stops) else np.inf
        mask = valid & (values >= lower) & (values < upper)
        if not np.any(mask):
            continue

        if np.isfinite(upper):
            weight = (values[mask] - lower) / (upper - lower)
            base = np.array(color, dtype=np.float32)
            next_color = np.array(stops[index + 1][1], dtype=np.float32)
            blended = base + (next_color - base) * weight[:, None]
            rgba[mask] = blended.astype(np.uint8)
        else:
            rgba[mask] = color

    return rgba
