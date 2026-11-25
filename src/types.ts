export type PaperTemplate = 'blank' | 'lined' | 'grid' | 'dotted';
export type PaperTheme = 'light' | 'cream' | 'dark';
export type ScrollDirection = 'vertical' | 'horizontal';
export type ToolbarDock = 'top' | 'left' | 'right';
export type ToolKind = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'pan';
export type EraserMode = 'stroke' | 'partial';
export type ShapeKind = 'freehand' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'triangle';

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  altitude: number;
  azimuth: number;
  dtMs: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface VectorStroke {
  id: string;
  pageId: string;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: StrokePoint[];
  bbox: BBox;
  shapeKind?: ShapeKind;
  audioSessionId?: string;
  startAudioMs?: number;
  endAudioMs?: number;
}

export interface TextBoxItem {
  id: string;
  pageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  plainText: string;
  fontFamily: 'sans' | 'serif' | 'mono';
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  listMode: 'none' | 'bullet' | 'numbered';
  audioSessionId?: string;
  startAudioMs?: number;
}

export interface ImageCrop {
  x: number; // 0..1 normalized
  y: number; // 0..1 normalized
  w: number; // 0..1 normalized
  h: number; // 0..1 normalized
}

export interface ImageItem {
  id: string;
  pageId: string;
  blobKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  crop: ImageCrop;
}

export type PageSource =
  | { kind: 'template'; template: PaperTemplate; theme: PaperTheme }
  | { kind: 'pdf'; blobKey: string; pdfPageNumber: number; rotation: 0 | 90 | 180 | 270; fileName: string };

export interface PageDescriptor {
  pageId: string;
  orderKey: string;
  widthPt: number;
  heightPt: number;
  source: PageSource;
}

export interface AudioSegment {
  startMs: number;
  endMs: number;
}

export interface AudioSession {
  id: string;
  name: string;
  createdAt: number;
  durationMs: number;
  mimeType: string;
  blobKey: string;
  segments: AudioSegment[];
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  createdAt: number;
  deletedAt?: number | null;
}

export interface HLC {
  ts: number;
  counter: number;
  deviceId: string;
}

export interface NoteDocument {
  id: string;
  title: string;
  folderId: string | null;
  tags: string[];
  isFavorite: boolean;
  scrollDirection: ScrollDirection;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
  pages: PageDescriptor[];
  strokesByPage: Record<string, VectorStroke[]>;
  textBoxesByPage: Record<string, TextBoxItem[]>;
  imagesByPage: Record<string, ImageItem[]>;
  audioSessions: AudioSession[];
  hlc: HLC;
}

export interface BackupConfig {
  provider: 'none' | 'google-drive' | 'dropbox';
  connectedAccount: string | null;
  destinationFolder: string;
  format: 'pdf' | 'quire';
  wifiOnly: boolean;
  lastBackupAt: number | null;
  status: 'idle' | 'backing-up' | 'synced' | 'error';
  errorMessage?: string;
}

export interface SyncConfig {
  enabled: boolean;
  accountEmail: string | null;
  lastSyncedAt: number | null;
  status: 'local-only' | 'syncing' | 'synced' | 'conflict' | 'offline';
}

export interface ProEntitlement {
  isPro: boolean;
  purchasedAt: number | null;
  receiptId: string | null;
  freeNoteLimit: number;
}

export interface AppSettings {
  hasCompletedOnboarding: boolean;
  defaultTemplate: PaperTemplate;
  defaultPaperTheme: PaperTheme;
  defaultScrollDirection: ScrollDirection;
  darkMode: boolean;
  toolbarDock: ToolbarDock;
  fingerDrawMode: boolean;
  scribbleEraseEnabled: boolean;
  predictionLookaheadMs: number;
  audioPreRollMs: number;
  penColorPresets: string[];
  highlighterColorPresets: string[];
  backup: BackupConfig;
  sync: SyncConfig;
  pro: ProEntitlement;
}

export interface UndoCommand {
  description: string;
  undo: () => void;
  redo: () => void;
}

export interface TelemetrySnapshot {
  boostActive: boolean;
  offscreenCanvasActive: boolean;
  rendererBackend: 'webgl2' | '2d-offscreen' | '2d-main';
  estimatedHz: number;
  lastInkLatencyMs: number;
  activeStrokesOnPage: number;
  cachedPdfTiles: number;
}
