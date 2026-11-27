import type { PaperTemplate, PaperTheme } from '../types';

export interface PaperThemeColors {
  bgHex: string;
  bgRgb: { r: number; g: number; b: number };
  ruleCss: string;
  ruleHex: string;
  ruleAlpha: number;
  rulePdfRgb: { r: number; g: number; b: number };
  marginCss: string;
  marginHex: string;
  marginAlpha: number;
  marginPdfRgb: { r: number; g: number; b: number };
}

export const PAPER_THEME_PALETTE: Record<PaperTheme, PaperThemeColors> = {
  light: {
    bgHex: '#ffffff',
    bgRgb: { r: 1, g: 1, b: 1 },
    ruleCss: 'rgba(148, 163, 184, 0.34)',
    ruleHex: '#94a3b8',
    ruleAlpha: 0.34,
    rulePdfRgb: { r: 0.858, g: 0.878, b: 0.906 },
    marginCss: 'rgba(239, 68, 68, 0.28)',
    marginHex: '#ef4444',
    marginAlpha: 0.28,
    marginPdfRgb: { r: 0.955, g: 0.768, b: 0.768 },
  },
  cream: {
    bgHex: '#faf6ee',
    bgRgb: { r: 250 / 255, g: 246 / 255, b: 238 / 255 },
    ruleCss: 'rgba(168, 152, 128, 0.32)',
    ruleHex: '#a89880',
    ruleAlpha: 0.32,
    rulePdfRgb: { r: 0.877, g: 0.855, b: 0.816 },
    marginCss: 'rgba(200, 90, 50, 0.26)',
    marginHex: '#c85a32',
    marginAlpha: 0.26,
    marginPdfRgb: { r: 0.929, g: 0.804, b: 0.745 },
  },
  dark: {
    bgHex: '#181b21',
    bgRgb: { r: 24 / 255, g: 27 / 255, b: 33 / 255 },
    ruleCss: 'rgba(240, 236, 228, 0.12)',
    ruleHex: '#f0ece4',
    ruleAlpha: 0.12,
    rulePdfRgb: { r: 0.196, g: 0.204, b: 0.221 },
    marginCss: 'rgba(224, 120, 80, 0.24)',
    marginHex: '#e07850',
    marginAlpha: 0.24,
    marginPdfRgb: { r: 0.282, g: 0.193, b: 0.174 },
  },
};

export const LINED_FIRST_RULE_Y_PT = 56;
export const LINED_STEP_PT = 26;
export const LINED_BOTTOM_MARGIN_PT = 20;
export const LINED_MARGIN_X_PT = 63;
export const GRID_STEP_PT = 26;
export const DOTTED_STEP_PT = 24;
export const DOTTED_RADIUS_PT = 1.15;

export interface LinedTemplateGeometry {
  kind: 'lined';
  marginXPt: number;
  ruleYsPt: number[];
  ruleStrokeWidthPt: number;
  marginStrokeWidthPt: number;
}

export interface GridTemplateGeometry {
  kind: 'grid';
  verticalXsPt: number[];
  horizontalYsPt: number[];
  strokeWidthPt: number;
}

export interface DottedTemplateGeometry {
  kind: 'dotted';
  xsPt: number[];
  ysPt: number[];
  startXPt: number;
  startYPt: number;
  stepPt: number;
  radiusPt: number;
}

export interface BlankTemplateGeometry {
  kind: 'blank';
}

export type PaperTemplateGeometry =
  | BlankTemplateGeometry
  | LinedTemplateGeometry
  | GridTemplateGeometry
  | DottedTemplateGeometry;

function computeCenteredAxisPositions(totalPt: number, stepPt: number, minEdgeMarginPt: number): number[] {
  if (totalPt <= minEdgeMarginPt * 2) return [];
  const usable = totalPt - minEdgeMarginPt * 2;
  const count = Math.floor(usable / stepPt);
  const span = count * stepPt;
  const start = Number(((totalPt - span) / 2).toFixed(2));
  const out: number[] = [];
  for (let i = 0; i <= count; i++) {
    out.push(Number((start + i * stepPt).toFixed(2)));
  }
  return out;
}

/**
 * Computes canonical top-down page-point (`pt`) coordinates for all paper templates.
 * Shared across live DOM SVG, thumbnails, 2x Retina PNG export, and Vector PDF export
 * so handwriting aligns identically everywhere with zero tile-wrap seams or phase drift.
 */
export function getPaperTemplateGeometry(
  template: PaperTemplate,
  widthPt = 612,
  heightPt = 792
): PaperTemplateGeometry {
  const w = Math.max(1, widthPt);
  const h = Math.max(1, heightPt);

  if (template === 'blank') {
    return { kind: 'blank' };
  }

  if (template === 'lined') {
    const ruleYsPt: number[] = [];
    const maxY = h - LINED_BOTTOM_MARGIN_PT;
    for (let y = LINED_FIRST_RULE_Y_PT; y <= maxY + 1e-4; y += LINED_STEP_PT) {
      ruleYsPt.push(Number(y.toFixed(2)));
    }
    const marginXPt = w >= 160 ? LINED_MARGIN_X_PT : Number((w * 0.103).toFixed(2));
    return {
      kind: 'lined',
      marginXPt,
      ruleYsPt,
      ruleStrokeWidthPt: 0.85,
      marginStrokeWidthPt: 0.9,
    };
  }

  if (template === 'grid') {
    return {
      kind: 'grid',
      verticalXsPt: computeCenteredAxisPositions(w, GRID_STEP_PT, 14),
      horizontalYsPt: computeCenteredAxisPositions(h, GRID_STEP_PT, 14),
      strokeWidthPt: 0.8,
    };
  }

  const xsPt = computeCenteredAxisPositions(w, DOTTED_STEP_PT, 14);
  const ysPt = computeCenteredAxisPositions(h, DOTTED_STEP_PT, 14);
  return {
    kind: 'dotted',
    xsPt,
    ysPt,
    startXPt: xsPt[0] ?? DOTTED_STEP_PT,
    startYPt: ysPt[0] ?? DOTTED_STEP_PT,
    stepPt: DOTTED_STEP_PT,
    radiusPt: DOTTED_RADIUS_PT,
  };
}

/**
 * Builds SVG path strings for crisp area-antialiased vector rendering (single `<path>` per layer).
 */
export function buildPaperTemplateSvgPaths(
  template: PaperTemplate,
  widthPt = 612,
  heightPt = 792
): {
  rulesPath: string;
  marginPath: string;
  ruleStrokeWidthPt: number;
  marginStrokeWidthPt: number;
  dotted?: DottedTemplateGeometry;
} {
  const geom = getPaperTemplateGeometry(template, widthPt, heightPt);
  if (geom.kind === 'lined') {
    const rulesPath = geom.ruleYsPt.map((y) => `M0 ${y}H${widthPt}`).join('');
    const marginPath = `M${geom.marginXPt} 0V${heightPt}`;
    return {
      rulesPath,
      marginPath,
      ruleStrokeWidthPt: geom.ruleStrokeWidthPt,
      marginStrokeWidthPt: geom.marginStrokeWidthPt,
    };
  }
  if (geom.kind === 'grid') {
    const vSegs = geom.verticalXsPt.map((x) => `M${x} 0V${heightPt}`).join('');
    const hSegs = geom.horizontalYsPt.map((y) => `M0 ${y}H${widthPt}`).join('');
    return {
      rulesPath: vSegs + hSegs,
      marginPath: '',
      ruleStrokeWidthPt: geom.strokeWidthPt,
      marginStrokeWidthPt: 0,
    };
  }
  if (geom.kind === 'dotted') {
    return {
      rulesPath: '',
      marginPath: '',
      ruleStrokeWidthPt: 0,
      marginStrokeWidthPt: 0,
      dotted: geom,
    };
  }
  return {
    rulesPath: '',
    marginPath: '',
    ruleStrokeWidthPt: 0,
    marginStrokeWidthPt: 0,
  };
}

const svgDataUriCache = new Map<string, string>();

/**
 * Returns a cached `url("data:image/svg+xml,...")` CSS background-image value for thumbnails
 * and non-mounted virtualized page slots. Scales proportionally with container width.
 */
export function getPaperTemplateSvgDataUri(
  template: PaperTemplate,
  theme: PaperTheme,
  widthPt = 612,
  heightPt = 792
): string {
  if (template === 'blank') return 'none';
  const key = `${template}:${theme}:${widthPt}:${heightPt}`;
  const cached = svgDataUriCache.get(key);
  if (cached) return cached;

  const palette = PAPER_THEME_PALETTE[theme];
  const { rulesPath, marginPath, ruleStrokeWidthPt, marginStrokeWidthPt, dotted } =
    buildPaperTemplateSvgPaths(template, widthPt, heightPt);

  let inner = '';
  if (dotted && dotted.xsPt.length > 0 && dotted.ysPt.length > 0) {
    const patW = dotted.stepPt;
    const patH = dotted.stepPt;
    const half = patW / 2;
    const ox = Number((dotted.startXPt - half).toFixed(2));
    const oy = Number((dotted.startYPt - half).toFixed(2));
    const rectX = Number((dotted.xsPt[0] - half).toFixed(2));
    const rectY = Number((dotted.ysPt[0] - half).toFixed(2));
    const rectW = Number((dotted.xsPt[dotted.xsPt.length - 1] - dotted.xsPt[0] + patW).toFixed(2));
    const rectH = Number((dotted.ysPt[dotted.ysPt.length - 1] - dotted.ysPt[0] + patH).toFixed(2));
    inner =
      `<defs><pattern id="d" x="${ox}" y="${oy}" width="${patW}" height="${patH}" patternUnits="userSpaceOnUse">` +
      `<circle cx="${half}" cy="${half}" r="${dotted.radiusPt}" fill="${palette.ruleHex}" fill-opacity="${palette.ruleAlpha}"/>` +
      `</pattern></defs>` +
      `<rect x="${rectX}" y="${rectY}" width="${rectW}" height="${rectH}" fill="url(#d)"/>`;
  } else {
    if (rulesPath) {
      inner += `<path d="${rulesPath}" stroke="${palette.ruleHex}" stroke-opacity="${palette.ruleAlpha}" stroke-width="${ruleStrokeWidthPt}" fill="none"/>`;
    }
    if (marginPath) {
      inner += `<path d="${marginPath}" stroke="${palette.marginHex}" stroke-opacity="${palette.marginAlpha}" stroke-width="${marginStrokeWidthPt}" fill="none"/>`;
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthPt} ${heightPt}">${inner}</svg>`;
  const encoded = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  svgDataUriCache.set(key, encoded);
  return encoded;
}

/**
 * Draws the paper surface background and template rules/grid/dots onto a 2D Canvas context
 * (used by 2x Retina PNG export so exported PNGs match screen & PDF templates identically).
 */
export function drawPaperTemplateCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  template: PaperTemplate,
  theme: PaperTheme,
  widthPt: number,
  heightPt: number,
  scale: number,
  options?: { fillBackground?: boolean; drawRules?: boolean }
): void {
  const fillBg = options?.fillBackground ?? true;
  const drawRules = options?.drawRules ?? true;
  const palette = PAPER_THEME_PALETTE[theme];

  if (fillBg) {
    ctx.save();
    ctx.fillStyle = palette.bgHex;
    ctx.fillRect(0, 0, Math.round(widthPt * scale), Math.round(heightPt * scale));
    ctx.restore();
  }

  if (!drawRules || template === 'blank') return;

  const geom = getPaperTemplateGeometry(template, widthPt, heightPt);
  ctx.save();
  ctx.scale(scale, scale);

  if (geom.kind === 'lined') {
    ctx.strokeStyle = palette.ruleCss;
    ctx.lineWidth = geom.ruleStrokeWidthPt;
    ctx.beginPath();
    for (const y of geom.ruleYsPt) {
      ctx.moveTo(0, y);
      ctx.lineTo(widthPt, y);
    }
    ctx.stroke();

    ctx.strokeStyle = palette.marginCss;
    ctx.lineWidth = geom.marginStrokeWidthPt;
    ctx.beginPath();
    ctx.moveTo(geom.marginXPt, 0);
    ctx.lineTo(geom.marginXPt, heightPt);
    ctx.stroke();
  } else if (geom.kind === 'grid') {
    ctx.strokeStyle = palette.ruleCss;
    ctx.lineWidth = geom.strokeWidthPt;
    ctx.beginPath();
    for (const x of geom.verticalXsPt) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, heightPt);
    }
    for (const y of geom.horizontalYsPt) {
      ctx.moveTo(0, y);
      ctx.lineTo(widthPt, y);
    }
    ctx.stroke();
  } else if (geom.kind === 'dotted') {
    ctx.fillStyle = palette.ruleCss;
    for (const y of geom.ysPt) {
      for (const x of geom.xsPt) {
        ctx.beginPath();
        ctx.arc(x, y, geom.radiusPt, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}
