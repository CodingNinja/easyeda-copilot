/**
 * Pure schematic geometry helpers. This module must never import `eda` or any
 * module that touches `eda` at load time, so it can be used from unit tests.
 */

export type Point = { x: number; y: number };

/** Snap a coordinate to the 5-unit schematic grid. Always compare coordinates through this. */
export const to2 = (x: number) => {
    return Math.round(x / 5) * 5;
};

/** Stable map key for a grid point. */
export const pointKey = (x: number, y: number) => `${to2(x)},${to2(y)}`;

/**
 * Whether `p` lies on the segment `[x1, y1, x2, y2]` (inclusive of its ends),
 * compared on the snapped grid.
 */
export function pointOnSegment(p: Point, segment: number[]): boolean {
    if (segment.length < 4) return false;
    const [x1, y1, x2, y2] = segment.map(to2);
    const px = to2(p.x);
    const py = to2(p.y);

    const cross = (py - y1) * (x2 - x1) - (px - x1) * (y2 - y1);
    if (cross !== 0) return false;

    return px >= Math.min(x1, x2) && px <= Math.max(x1, x2)
        && py >= Math.min(y1, y2) && py <= Math.max(y1, y2);
}
