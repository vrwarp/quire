import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type {
  ImageItem,
  PageDescriptor,
  PaperTheme,
  TextBoxItem,
  ToolKind,
  VectorStroke,
} from '../types';
import { renderDryHighlighterLayer, renderDryPenLayer } from '../engine/canvasRenderer';
import { pdfEngine, type PdfLinkAnnotation } from '../engine/pdfEngine';
import { quireStorage } from '../engine/storage';

interface PageSlotProps {
  page: PageDescriptor;
  pageIndex: number;
  zoom: number;
  isVisible: boolean;
  activeTool: ToolKind;
  fingerDrawMode: boolean;
  strokes: VectorStroke[];
  textBoxes: TextBoxItem[];
  images: ImageItem[];
  hiddenStrokeIds: Set<string>;
  selectedTextBoxId: string | null;
  selectedImageId: string | null;
  replaySessionId: string | null;
  replayTimeMs: number;
  onPointerDown: (e: PointerEvent, page: PageDescriptor, el: HTMLDivElement) => void;
  onPointerMove: (e: PointerEvent, page: PageDescriptor, el: HTMLDivElement) => void;
  onPointerUp: (e: PointerEvent, page: PageDescriptor, el: HTMLDivElement) => void;
  onSelectTextBox: (id: string | null) => void;
  onUpdateTextBox: (pageId: string, box: TextBoxItem) => void;
  onDeleteTextBox: (pageId: string, id: string) => void;
  onSelectImage: (id: string | null) => void;
  onUpdateImage: (pageId: string, img: ImageItem) => void;
  onDeleteImage: (pageId: string, id: string) => void;
  onJumpToPdfPage: (pdfPageNumber: number) => void;
  onDropFile: (file: File, pageId: string, xPt: number, yPt: number) => void;
}

export function PageSlot({
  page,
  pageIndex,
  zoom,
  isVisible,
  activeTool,
  fingerDrawMode,
  strokes,
  textBoxes,
  images,
  hiddenStrokeIds,
  selectedTextBoxId,
  selectedImageId,
  replaySessionId,
  replayTimeMs,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onSelectTextBox,
  onUpdateTextBox,
  onDeleteTextBox,
  onSelectImage,
  onUpdateImage,
  onDeleteImage,
  onJumpToPdfPage,
  onDropFile,
}: PageSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const hlCanvasRef = useRef<HTMLCanvasElement>(null);
  const penCanvasRef = useRef<HTMLCanvasElement>(null);

  const [pdfLinks, setPdfLinks] = useState<PdfLinkAnnotation[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});

  const paperTheme: PaperTheme = page.source.kind === 'template' ? page.source.theme : 'light';
  const paperClass =
    page.source.kind === 'template'
      ? `paper-theme-${page.source.theme} paper-tpl-${page.source.template}`
      : 'paper-theme-light';

  const scaledW = Math.round(page.widthPt * zoom);
  const scaledH = Math.round(page.heightPt * zoom);

  // Render lazy PDF tile only when page is inside the visible ±2 virtualization window
  useEffect(() => {
    if (!isVisible || page.source.kind !== 'pdf') return;
    let cancelled = false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const renderScale = Math.max(1, zoom * dpr);
    const { blobKey, pdfPageNumber, rotation } = page.source;

    void pdfEngine.renderPageTile(blobKey, pdfPageNumber, renderScale, rotation).then((bitmap) => {
      if (cancelled || !bitmap || !pdfCanvasRef.current) return;
      const canvas = pdfCanvasRef.current;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(bitmap, 0, 0);
    });

    void pdfEngine.getPageLinks(blobKey, pdfPageNumber).then((links) => {
      if (!cancelled) setPdfLinks(links);
    });

    return () => {
      cancelled = true;
    };
  }, [isVisible, page.source, zoom]);

  // Render Dry Highlighter + Dry Pen layers synchronously before paint so pen-up handoff never blinks
  useLayoutEffect(() => {
    if (!isVisible) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = zoom * dpr;

    if (hlCanvasRef.current) {
      renderDryHighlighterLayer(
        hlCanvasRef.current,
        strokes,
        page.widthPt,
        page.heightPt,
        scale,
        paperTheme,
        hiddenStrokeIds
      );
    }
    if (penCanvasRef.current) {
      renderDryPenLayer(penCanvasRef.current, strokes, page.widthPt, page.heightPt, scale, paperTheme, {
        hiddenIds: hiddenStrokeIds,
        replaySessionId,
        replayTimeMs,
      });
    }
  }, [isVisible, strokes, page.widthPt, page.heightPt, zoom, paperTheme, hiddenStrokeIds, replaySessionId, replayTimeMs]);

  // Load object URLs for embedded images
  useEffect(() => {
    if (!isVisible || images.length === 0) return;
    let active = true;
    const created: string[] = [];

    void (async () => {
      const next: Record<string, string> = {};
      for (const img of images) {
        const bytes = await quireStorage.loadBlob(img.blobKey);
        if (bytes && active) {
          const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
          created.push(url);
          next[img.id] = url;
        }
      }
      if (active) setImageUrls(next);
    })();

    return () => {
      active = false;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [isVisible, images]);

  // Suppress iPadOS Scribble & UIScrollView gesture delay on Apple Pencil while preserving finger pan/zoom
  useEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const shouldClaimTouch = (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i] as Touch & { touchType?: string };
        if (touch.touchType === 'stylus' || (fingerDrawMode && activeTool !== 'pan' && activeTool !== 'text')) {
          e.preventDefault();
          return;
        }
      }
    };
    el.addEventListener('touchstart', shouldClaimTouch, { passive: false });
    el.addEventListener('touchmove', shouldClaimTouch, { passive: false });
    return () => {
      el.removeEventListener('touchstart', shouldClaimTouch);
      el.removeEventListener('touchmove', shouldClaimTouch);
    };
  }, [activeTool, fingerDrawMode]);

  const drawingActive = activeTool !== 'pan' && activeTool !== 'text' && fingerDrawMode;

  return (
    <div
      ref={slotRef}
      data-page-id={page.pageId}
      data-page-index={pageIndex}
      class={`page-slot ${paperClass} ${drawingActive ? 'drawing-active' : ''}`}
      style={{
        width: `${scaledW}px`,
        height: `${scaledH}px`,
      }}
      onPointerDown={(e) => slotRef.current && onPointerDown(e as unknown as PointerEvent, page, slotRef.current)}
      onPointerMove={(e) => slotRef.current && onPointerMove(e as unknown as PointerEvent, page, slotRef.current)}
      onPointerUp={(e) => slotRef.current && onPointerUp(e as unknown as PointerEvent, page, slotRef.current)}
      onPointerCancel={(e) => slotRef.current && onPointerUp(e as unknown as PointerEvent, page, slotRef.current)}
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (!file || !slotRef.current) return;
        const rect = slotRef.current.getBoundingClientRect();
        const xPt = (e.clientX - rect.left) / zoom;
        const yPt = (e.clientY - rect.top) / zoom;
        onDropFile(file, page.pageId, xPt, yPt);
      }}
    >
      {isVisible && (
        <>
          {page.source.kind === 'pdf' && <canvas ref={pdfCanvasRef} class="page-layer" />}

          {/* Embedded Croppable Images (FR-PDF-03) */}
          {images.map((img) => {
            const url = imageUrls[img.id];
            const isSel = selectedImageId === img.id;
            return (
              <div
                key={img.id}
                class={`canvas-image-box ${isSel ? 'selected' : ''}`}
                style={{
                  left: `${img.x * zoom}px`,
                  top: `${img.y * zoom}px`,
                  width: `${img.width * zoom}px`,
                  height: `${img.height * zoom}px`,
                  transform: img.rotation ? `rotate(${img.rotation}deg)` : undefined,
                  pointerEvents: activeTool === 'pan' || activeTool === 'lasso' ? 'auto' : 'none',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectImage(img.id);
                }}
              >
                {url && (
                  <img
                    src={url}
                    alt="Inserted media"
                    style={{
                      objectPosition: `${img.crop.x * 100}% ${img.crop.y * 100}%`,
                      transform: `scale(${1 / Math.max(0.2, img.crop.w)})`,
                    }}
                  />
                )}
                {isSel && (
                  <div
                    style={{
                      position: 'absolute',
                      top: '4px',
                      right: '4px',
                      display: 'flex',
                      gap: '4px',
                    }}
                  >
                    <button
                      type="button"
                      class="btn-secondary"
                      style={{ padding: '2px 6px', fontSize: '11px' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onUpdateImage(page.pageId, {
                          ...img,
                          crop:
                            img.crop.w < 0.95
                              ? { x: 0, y: 0, w: 1, h: 1 }
                              : { x: 0.12, y: 0.12, w: 0.76, h: 0.76 },
                        });
                      }}
                    >
                      {img.crop.w < 0.95 ? 'Uncrop' : 'Crop'}
                    </button>
                    <button
                      type="button"
                      class="btn-secondary"
                      style={{ padding: '2px 6px', fontSize: '11px' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteImage(page.pageId, img.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Single-Layer Non-Darkening Highlighter Canvas (Always BELOW Pen Ink!) */}
          <canvas ref={hlCanvasRef} class="page-layer highlighter-layer" />

          {/* Crisp Vector Dry Pen Canvas */}
          <canvas ref={penCanvasRef} class="page-layer" />

          {/* Typed Text Boxes (FR-INK-06) */}
          {textBoxes.map((box) => {
            const isSel = selectedTextBoxId === box.id;
            const fontMap = {
              sans: 'var(--font-sans)',
              serif: 'var(--font-serif)',
              mono: 'var(--font-mono)',
            };
            return (
              <div
                key={box.id}
                class={`canvas-textbox ${isSel ? 'selected' : ''}`}
                style={{
                  left: `${box.x * zoom}px`,
                  top: `${box.y * zoom}px`,
                  width: `${box.width * zoom}px`,
                  pointerEvents: activeTool === 'text' || isSel ? 'auto' : 'none',
                }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelectTextBox(box.id);
                }}
              >
                {isSel && (
                  <div
                    style={{
                      display: 'flex',
                      gap: '4px',
                      marginBottom: '4px',
                      background: 'var(--surface-1)',
                      padding: '3px 6px',
                      borderRadius: '6px',
                      border: '1px solid var(--border-subtle)',
                      width: 'fit-content',
                    }}
                  >
                    <button
                      type="button"
                      class={`btn-icon ${box.bold ? 'active' : ''}`}
                      style={{ width: '24px', height: '24px', fontWeight: 700, fontSize: '12px' }}
                      onClick={() => onUpdateTextBox(page.pageId, { ...box, bold: !box.bold })}
                      aria-label="Bold"
                    >
                      B
                    </button>
                    <button
                      type="button"
                      class={`btn-icon ${box.italic ? 'active' : ''}`}
                      style={{ width: '24px', height: '24px', fontStyle: 'italic', fontSize: '12px' }}
                      onClick={() => onUpdateTextBox(page.pageId, { ...box, italic: !box.italic })}
                      aria-label="Italic"
                    >
                      I
                    </button>
                    <button
                      type="button"
                      class={`btn-icon ${box.listMode === 'bullet' ? 'active' : ''}`}
                      style={{ width: '24px', height: '24px', fontSize: '12px' }}
                      onClick={() =>
                        onUpdateTextBox(page.pageId, {
                          ...box,
                          listMode: box.listMode === 'bullet' ? 'none' : 'bullet',
                        })
                      }
                      aria-label="Bullet list"
                    >
                      •
                    </button>
                    <button
                      type="button"
                      class="btn-icon"
                      style={{ width: '24px', height: '24px', fontSize: '12px' }}
                      onClick={() =>
                        onUpdateTextBox(page.pageId, {
                          ...box,
                          fontSize: Math.min(36, box.fontSize + 2),
                        })
                      }
                      aria-label="Increase font size"
                    >
                      A+
                    </button>
                    <button
                      type="button"
                      class="btn-icon"
                      style={{ width: '24px', height: '24px', fontSize: '12px' }}
                      onClick={() => onDeleteTextBox(page.pageId, box.id)}
                      aria-label="Delete text box"
                    >
                      ×
                    </button>
                  </div>
                )}
                <textarea
                  value={box.plainText}
                  placeholder="Type notes..."
                  aria-label="Typed text box"
                  rows={Math.max(2, box.plainText.split('\n').length)}
                  style={{
                    fontFamily: fontMap[box.fontFamily],
                    fontSize: `${box.fontSize * zoom}px`,
                    fontWeight: box.bold ? 700 : 400,
                    fontStyle: box.italic ? 'italic' : 'normal',
                    textDecoration: box.underline ? 'underline' : 'none',
                    color: paperTheme === 'dark' ? '#f2efe9' : box.color,
                  }}
                  onInput={(e) => {
                    const value = (e.target as HTMLTextAreaElement).value;
                    onUpdateTextBox(page.pageId, { ...box, plainText: value });
                  }}
                />
              </div>
            );
          })}

          {/* Internal PDF Hyperlinks (Active in Pan / Read mode, FR-PDF-05) */}
          {activeTool === 'pan' &&
            pdfLinks.map((link, idx) => (
              <a
                key={idx}
                class="pdf-link-region"
                title={link.url ?? `Jump to PDF page ${link.destPageNumber}`}
                href={link.url ?? '#'}
                target={link.url ? '_blank' : undefined}
                rel={link.url ? 'noopener noreferrer' : undefined}
                style={{
                  left: `${link.rectPt[0] * zoom}px`,
                  top: `${link.rectPt[1] * zoom}px`,
                  width: `${link.rectPt[2] * zoom}px`,
                  height: `${link.rectPt[3] * zoom}px`,
                }}
                onClick={(e) => {
                  if (link.destPageNumber) {
                    e.preventDefault();
                    onJumpToPdfPage(link.destPageNumber);
                  }
                }}
              />
            ))}
        </>
      )}

      <span class="page-number-badge">Page {pageIndex + 1}</span>
    </div>
  );
}
