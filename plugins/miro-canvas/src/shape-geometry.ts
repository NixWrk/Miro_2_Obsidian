/**
 * Silhouettes for the shapes this plugin draws.
 *
 * The drawing paths, with their inner strokes and decorations, are painted by
 * the renderer and shown as icons by the shape picker, so they live here
 * beside the outline those paths enclose.  The outline is kept apart because two
 * different questions need it and neither can be answered from a drawing
 * path: where a connector meets the shape, and how much room the text has
 * inside it.  Both were previously guessed from the bounding rectangle, which
 * is why a connector met a triangle in mid-air and a hand-tuned percentage
 * decided where its label sat.
 *
 * Everything here works in a normalized 0..100 box so one outline serves a
 * node of any size, and stays pure so it can be checked without a DOM.
 */

export interface ShapePoint {
  readonly x: number;
  readonly y: number;
}

export type ShapeInsets = readonly [number, number, number, number];

/** Polygon silhouettes, also used by the renderer as CSS clip paths. */
export const SHAPE_CLIP_PATHS: Readonly<Record<string, string>> = Object.freeze({
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  rhombus: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  diamond: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  parallelogram: "polygon(18% 0%, 100% 0%, 82% 100%, 0% 100%)",
  trapezoid: "polygon(18% 0%, 82% 0%, 100% 100%, 0% 100%)",
  pentagon: "polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)",
  hexagon: "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)",
  octagon: "polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)",
  star: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 94%, 50% 72%, 21% 94%, 32% 57%, 2% 35%, 39% 35%)",
  cross: "polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%)",
  right_arrow: "polygon(0% 25%, 65% 25%, 65% 0%, 100% 50%, 65% 100%, 65% 75%, 0% 75%)",
  left_arrow: "polygon(35% 0%, 35% 25%, 100% 25%, 100% 75%, 35% 75%, 35% 100%, 0% 50%)",
  left_right_arrow: "polygon(20% 0%, 20% 25%, 80% 25%, 80% 0%, 100% 50%, 80% 100%, 80% 75%, 20% 75%, 20% 100%, 0% 50%)",
  flow_chart_input_output: "polygon(18% 0%, 100% 0%, 82% 100%, 0% 100%)",
  flow_chart_decision: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  flow_chart_manual_input: "polygon(12% 12%, 100% 0%, 100% 100%, 0% 100%)",
  flow_chart_manual_operation: "polygon(12% 0%, 88% 0%, 100% 100%, 0% 100%)",
  flow_chart_merge: "polygon(0% 0%, 100% 0%, 50% 100%)",
  flow_chart_offpage_connector: "polygon(0% 0%, 100% 0%, 100% 72%, 50% 100%, 0% 72%)",
  flow_chart_preparation: "polygon(20% 0%, 80% 0%, 100% 50%, 80% 100%, 20% 100%, 0% 50%)",
});

// Normalized contours; inner strokes are separate subpaths, never a clipped
// rectangular border. Unknown shapes deliberately retain native rendering.
const SHAPE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  rectangle: "M0 0H100V100H0Z",
  round_rectangle: "M12 0H88Q100 0 100 12V88Q100 100 88 100H12Q0 100 0 88V12Q0 0 12 0Z",
  circle: "M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z",
  ellipse: "M50 0A50 50 0 1 1 50 100A50 50 0 1 1 50 0Z",
  cloud: "M15 75C-5 75 -5 45 12 42C0 20 25 5 40 18C50 -8 82 -3 85 22C110 20 113 55 94 62C110 90 75 110 61 91C42 111 17 100 15 75Z",
  can: "M0 15C0 -5 100 -5 100 15V85C100 105 0 105 0 85ZM0 15C0 35 100 35 100 15",
  wedge_round_rectangle_callout: "M12 0H88Q100 0 100 12V68Q100 80 88 80H45L25 100V80H12Q0 80 0 68V12Q0 0 12 0Z",
  left_brace: "M80 0Q40 0 40 25V35Q40 50 10 50Q40 50 40 65V75Q40 100 80 100",
  right_brace: "M20 0Q60 0 60 25V35Q60 50 90 50Q60 50 60 65V75Q60 100 20 100",
  flow_chart_delay: "M0 0H50A50 50 0 0 1 50 100H0Z",
  flow_chart_display: "M20 0H75Q125 50 75 100H20L0 50Z",
  flow_chart_document: "M0 0H100V85C65 60 35 110 0 85Z",
  flow_chart_multidocuments: "M15 0H100V72M8 8H92V80M0 16H84V85C55 65 30 110 0 85Z",
  flow_chart_internal_storage: "M0 0H100V100H0ZM15 0V100M0 15H100",
  flow_chart_note_square: "M80 0H15V100H80",
  flow_chart_predefined_process: "M0 0H100V100H0ZM15 0V100M85 0V100",
  flow_chart_predefined_process_2: "M0 0H100V100H0ZM15 0V100M85 0V100M0 15H100M0 85H100",
  flow_chart_online_storage: "M15 0H100C80 15 80 85 100 100H15C-5 85 -5 15 15 0Z",
  flow_chart_magnetic_drum: "M15 0H85C105 0 105 100 85 100H15C-5 100 -5 0 15 0ZM85 0C65 0 65 100 85 100",
  flow_chart_terminator: "M25 0H75C108 0 108 100 75 100H25C-8 100 -8 0 25 0Z",
});

/** The drawing path of a shape in the 0..100 box, or undefined for a shape left to native rendering. */
export function shapePath(shape: string | undefined): string | undefined {
  if (shape === undefined) return undefined;
  const aliases: Record<string, string> = {
    flow_chart_process: "rectangle", flow_chart_connector: "circle",
    flow_chart_note_curly_left: "left_brace", flow_chart_note_curly_right: "right_brace",
    flow_chart_magnetic_disk: "can",
  };
  const base = aliases[shape] ?? shape;
  if (base === "flow_chart_or" || base === "flow_chart_summing_junction") {
    return SHAPE_PATHS.circle + (base === "flow_chart_or" ? "M0 50H100M50 0V100" : "M15 15L85 85M85 15L15 85");
  }
  const polygon = SHAPE_CLIP_PATHS[base];
  if (polygon !== undefined) {
    const points = polygon.match(/[\d.]+/g)!;
    return `M${points[0]} ${points[1]}` + points.slice(2).reduce((text, n, i) => text + (i % 2 === 0 ? `L${n}` : ` ${n}`), "") + "Z";
  }
  return SHAPE_PATHS[base];
}

const RECTANGLE: readonly ShapePoint[] = Object.freeze([
  { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
]);

/** Shapes whose silhouette is a rectangle share one outline. */
const RECTANGULAR = new Set([
  "rectangle", "flow_chart_process", "flow_chart_predefined_process",
  "flow_chart_predefined_process_2", "flow_chart_internal_storage",
  "flow_chart_note_square", "flow_chart_multidocuments",
]);

const ELLIPTICAL = new Set([
  "circle", "ellipse", "flow_chart_connector", "flow_chart_or", "flow_chart_summing_junction",
]);

const ROUNDED = new Set([
  "round_rectangle", "wedge_round_rectangle_callout", "flow_chart_magnetic_drum",
  "flow_chart_online_storage", "flow_chart_note_curly_left", "flow_chart_note_curly_right",
  "left_brace", "right_brace",
]);

function ellipse(steps = 64): readonly ShapePoint[] {
  return Object.freeze(Array.from({ length: steps }, (_, index) => {
    const angle = (index / steps) * Math.PI * 2;
    return { x: 50 + 50 * Math.cos(angle), y: 50 + 50 * Math.sin(angle) };
  }));
}

/** A rectangle with quarter-circle corners, sampled as a polygon. */
function roundedRectangle(radius: number, steps = 6): readonly ShapePoint[] {
  const corners: readonly (readonly [number, number, number])[] = [
    [100 - radius, radius, -90], [100 - radius, 100 - radius, 0],
    [radius, 100 - radius, 90], [radius, radius, 180],
  ];
  const points: ShapePoint[] = [];
  for (const [cx, cy, start] of corners) {
    for (let index = 0; index <= steps; index += 1) {
      const angle = ((start + (index / steps) * 90) * Math.PI) / 180;
      points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    }
  }
  return Object.freeze(points);
}

/** A capsule: the terminator and the can share this silhouette family. */
function capsule(): readonly ShapePoint[] {
  return roundedRectangle(50, 12);
}

const EXTRA_OUTLINES: Readonly<Record<string, readonly ShapePoint[]>> = Object.freeze({
  flow_chart_terminator: capsule(),
  can: roundedRectangle(18, 8),
  flow_chart_magnetic_disk: roundedRectangle(18, 8),
  flow_chart_delay: Object.freeze([
    { x: 0, y: 0 }, { x: 50, y: 0 },
    ...Array.from({ length: 16 }, (_, index) => {
      const angle = (-90 + (index / 15) * 180) * Math.PI / 180;
      return { x: 50 + 50 * Math.cos(angle), y: 50 + 50 * Math.sin(angle) };
    }),
    { x: 50, y: 100 }, { x: 0, y: 100 },
  ]),
  flow_chart_document: Object.freeze([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 85 },
    { x: 75, y: 72 }, { x: 50, y: 82 }, { x: 25, y: 92 }, { x: 0, y: 85 },
  ]),
  flow_chart_display: Object.freeze([
    { x: 20, y: 0 }, { x: 75, y: 0 },
    // The right-hand bulge, sampled from the quadratic the renderer paints.
    ...Array.from({ length: 13 }, (_, index) => {
      const t = (index + 1) / 14;
      const inverse = 1 - t;
      return {
        x: inverse * inverse * 75 + 2 * inverse * t * 125 + t * t * 75,
        y: 2 * inverse * t * 50 + t * t * 100,
      };
    }),
    { x: 75, y: 100 }, { x: 20, y: 100 }, { x: 0, y: 50 },
  ]),
  cloud: Object.freeze([
    { x: 15, y: 75 }, { x: 2, y: 62 }, { x: 6, y: 44 }, { x: 12, y: 42 },
    { x: 8, y: 26 }, { x: 25, y: 12 }, { x: 40, y: 18 }, { x: 50, y: 4 },
    { x: 68, y: 2 }, { x: 85, y: 14 }, { x: 87, y: 30 }, { x: 96, y: 34 },
    { x: 100, y: 50 }, { x: 94, y: 62 }, { x: 98, y: 78 }, { x: 84, y: 92 },
    { x: 61, y: 91 }, { x: 42, y: 100 }, { x: 24, y: 96 },
  ]),
});

function parsePolygon(value: string): readonly ShapePoint[] | undefined {
  const numbers = value.match(/-?[\d.]+/gu);
  if (numbers === null || numbers.length < 6 || numbers.length % 2 !== 0) {
    return undefined;
  }
  const points: ShapePoint[] = [];
  for (let index = 0; index < numbers.length; index += 2) {
    const x = Number(numbers[index]);
    const y = Number(numbers[index + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return undefined;
    }
    points.push({ x, y });
  }
  return Object.freeze(points);
}

const outlineCache = new Map<string, readonly ShapePoint[] | undefined>();

/**
 * The silhouette of a shape in the normalized box, or undefined when the kind
 * is unknown and the caller should keep using the bounding rectangle.
 */
export function shapeOutline(shape: string | undefined): readonly ShapePoint[] | undefined {
  if (shape === undefined) {
    return undefined;
  }
  if (outlineCache.has(shape)) {
    return outlineCache.get(shape);
  }
  const polygon = SHAPE_CLIP_PATHS[shape];
  const outline = polygon !== undefined ? parsePolygon(polygon)
    : RECTANGULAR.has(shape) ? RECTANGLE
      : ELLIPTICAL.has(shape) ? ellipse()
        : ROUNDED.has(shape) ? roundedRectangle(12)
          : EXTRA_OUTLINES[shape];
  outlineCache.set(shape, outline);
  return outline;
}

function segmentHit(
  from: ShapePoint, to: ShapePoint, origin: ShapePoint, dx: number, dy: number,
): number | undefined {
  const ex = to.x - from.x;
  const ey = to.y - from.y;
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) < 1e-9) {
    return undefined;
  }
  const px = from.x - origin.x;
  const py = from.y - origin.y;
  const t = (px * ey - py * ex) / denominator;
  const u = (px * dy - py * dx) / denominator;
  return t >= 0 && u >= -1e-9 && u <= 1 + 1e-9 ? t : undefined;
}

/**
 * Where a ray from the middle of the shape towards `target` leaves the
 * outline, in the same normalized box.  A target the ray cannot reach - a
 * degenerate outline, or a direction of zero length - yields the target
 * itself, so a caller never has to handle a missing point.
 */
export function contourPoint(
  outline: readonly ShapePoint[] | undefined, target: ShapePoint, center: ShapePoint = { x: 50, y: 50 },
): ShapePoint {
  if (outline === undefined || outline.length < 3) {
    return target;
  }
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return target;
  }
  let best: number | undefined;
  for (let index = 0; index < outline.length; index += 1) {
    const hit = segmentHit(outline[index]!, outline[(index + 1) % outline.length]!, center, dx, dy);
    if (hit !== undefined && (best === undefined || hit > best)) {
      best = hit;
    }
  }
  return best === undefined ? target : { x: center.x + dx * best, y: center.y + dy * best };
}

/**
 * Nearest point on the rendered contour. `scale` keeps distance correct for a
 * non-square node even though the stored outline uses a normalized box.
 */
export function closestContourPoint(
  outline: readonly ShapePoint[] | undefined,
  target: ShapePoint,
  scale: ShapePoint = { x: 1, y: 1 },
): ShapePoint {
  if (outline === undefined || outline.length < 2
    || !(scale.x > 0) || !(scale.y > 0)) return target;
  let best: ShapePoint | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < outline.length; index += 1) {
    const from = outline[index]!;
    const to = outline[(index + 1) % outline.length]!;
    const dx = (to.x - from.x) * scale.x;
    const dy = (to.y - from.y) * scale.y;
    const tx = (target.x - from.x) * scale.x;
    const ty = (target.y - from.y) * scale.y;
    const lengthSquared = dx * dx + dy * dy;
    const along = lengthSquared <= 1e-12 ? 0 : Math.max(0, Math.min(1, (tx * dx + ty * dy) / lengthSquared));
    const point = { x: from.x + (to.x - from.x) * along, y: from.y + (to.y - from.y) * along };
    const distance = ((target.x - point.x) * scale.x) ** 2 + ((target.y - point.y) * scale.y) ** 2;
    // Stable outline order resolves corners and equal-distance segments.
    if (distance < bestDistance - 1e-9) {
      best = point;
      bestDistance = distance;
    }
  }
  return best ?? target;
}

function insideSpan(outline: readonly ShapePoint[], y: number): { readonly left: number; readonly right: number } | undefined {
  const crossings: number[] = [];
  for (let index = 0; index < outline.length; index += 1) {
    const from = outline[index]!;
    const to = outline[(index + 1) % outline.length]!;
    if ((from.y <= y && to.y > y) || (to.y <= y && from.y > y)) {
      crossings.push(from.x + ((y - from.y) / (to.y - from.y)) * (to.x - from.x));
    }
  }
  if (crossings.length < 2) {
    return undefined;
  }
  crossings.sort((left, right) => left - right);
  // A row of a non-convex shape can be inside in several stretches - a
  // star's legs, with empty space between them.  Taking the outermost
  // crossings called that gap inside and let text sit outside the star.  The
  // stretch around the centre is the one text is laid out in.
  let widest: { readonly left: number; readonly right: number } | undefined;
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    const stretch = { left: crossings[index]!, right: crossings[index + 1]! };
    if (stretch.left <= 50 && stretch.right >= 50) return stretch;
    if (widest === undefined || stretch.right - stretch.left > widest.right - widest.left) widest = stretch;
  }
  return widest;
}

/**
 * The largest axis-aligned rectangle that fits inside the outline, expressed
 * as the percentage each side gives up.  Text laid out in the node rectangle
 * then stays within the drawn shape instead of spilling over its edges.
 */
export function inscribedInsets(outline: readonly ShapePoint[] | undefined, rows = 48): ShapeInsets | undefined {
  if (outline === undefined || outline.length < 3) {
    return undefined;
  }
  const spans: ({ readonly left: number; readonly right: number } | undefined)[] = [];
  for (let row = 0; row <= rows; row += 1) {
    spans.push(insideSpan(outline, (row / rows) * 100));
  }
  let best: { top: number; bottom: number; left: number; right: number; area: number } | undefined;
  for (let top = 0; top < rows; top += 1) {
    let left = -Infinity;
    let right = Infinity;
    for (let bottom = top + 1; bottom <= rows; bottom += 1) {
      const span = spans[bottom === rows ? bottom - 1 : bottom];
      const upper = spans[top === 0 ? 1 : top];
      if (span === undefined || upper === undefined) {
        break;
      }
      left = Math.max(left, span.left, upper.left);
      right = Math.min(right, span.right, upper.right);
      const width = right - left;
      const height = ((bottom - top) / rows) * 100;
      if (width <= 0) {
        break;
      }
      const area = width * height;
      if (best === undefined || area > best.area) {
        best = { top: (top / rows) * 100, bottom: 100 - (bottom / rows) * 100, left, right: 100 - right, area };
      }
    }
  }
  if (best === undefined) {
    return undefined;
  }
  const round = (value: number): number => Math.max(0, Math.round(value * 10) / 10);
  return [round(best.top), round(best.right), round(best.bottom), round(best.left)];
}
