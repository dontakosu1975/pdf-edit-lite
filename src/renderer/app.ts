/**
 * Renderer entry point.
 *
 * Communicates with main ONLY through `window.api` (preload bridge).
 * No Node.js or Electron imports here — enforced by contextIsolation + sandbox.
 *
 * Implements:
 *   - PDF open via PDFium engine (canvas rendering)
 *   - Zoom / pan / page navigation
 *   - Object selection & hit-testing
 *   - In-place text editing
 *   - Image replacement
 *   - Undo / redo command stack
 *   - Dirty state tracking with close guard
 */

// ── Constants (mirrors shared/constants.ts without import) ──────────
const MIN_ZOOM_PERCENT = 25;
const MAX_ZOOM_PERCENT = 500;
const DEFAULT_ZOOM_PERCENT = 100;
const ZOOM_STEP_PERCENT = 25;
const MAX_UNDO_DEPTH = 100;

// ── DOM references ──────────────────────────────────────────────────
const btnOpen = document.getElementById('btn-open') as HTMLButtonElement;
const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
const btnSaveAs = document.getElementById('btn-save-as') as HTMLButtonElement;
const fileNameEl = document.getElementById('file-name') as HTMLSpanElement;
const versionEl = document.getElementById('app-version') as HTMLSpanElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const pageInfo = document.getElementById('page-info') as HTMLSpanElement;
const zoomInfoEl = document.getElementById('zoom-info') as HTMLSpanElement;
const dirtyIndicator = document.getElementById('dirty-indicator') as HTMLSpanElement;
const dropZone = document.getElementById('drop-zone') as HTMLDivElement;
const viewerContainer = document.getElementById('viewer-container') as HTMLElement;
const canvasWrapper = document.getElementById('canvas-wrapper') as HTMLDivElement;
const pageCanvas = document.getElementById('page-canvas') as HTMLCanvasElement;
const overlayCanvas = document.getElementById('overlay-canvas') as HTMLCanvasElement;

// Zoom controls
const btnZoomIn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
const btnZoomOut = document.getElementById('btn-zoom-out') as HTMLButtonElement;
const btnZoomFit = document.getElementById('btn-zoom-fit') as HTMLButtonElement;
const zoomLevelEl = document.getElementById('zoom-level') as HTMLSpanElement;

// Page navigation
const btnPrevPage = document.getElementById('btn-prev-page') as HTMLButtonElement;
const btnNextPage = document.getElementById('btn-next-page') as HTMLButtonElement;
const pageInput = document.getElementById('page-input') as HTMLInputElement;
const pageTotalEl = document.getElementById('page-total') as HTMLSpanElement;

// Editing tools
const btnToolSelect = document.getElementById('btn-tool-select') as HTMLButtonElement;
const btnToolEditText = document.getElementById('btn-tool-edit-text') as HTMLButtonElement;
const btnToolInsertText = document.getElementById('btn-tool-insert-text') as HTMLButtonElement;
const btnToolMoveText = document.getElementById('btn-tool-move-text') as HTMLButtonElement;
const btnToolReplaceImage = document.getElementById('btn-tool-replace-image') as HTMLButtonElement;
const btnDeleteSelectedText = document.getElementById('btn-delete-selected-text') as HTMLButtonElement;
const btnCommitEdit = document.getElementById('btn-commit-edit') as HTMLButtonElement;
const fontSelect = document.getElementById('font-select') as HTMLSelectElement;
const btnUndo = document.getElementById('btn-undo') as HTMLButtonElement;
const btnRedo = document.getElementById('btn-redo') as HTMLButtonElement;
const textContextMenu = document.getElementById('text-context-menu') as HTMLDivElement;
const btnDeleteText = document.getElementById('btn-delete-text') as HTMLButtonElement;
const fontSizeInput = document.getElementById('font-size') as HTMLInputElement;
const textColorMode = document.getElementById('text-color-mode') as HTMLSelectElement;
const textColorInput = document.getElementById('text-color') as HTMLInputElement;
const textFormatSection = document.getElementById('text-format-section') as HTMLDivElement;

// Thumbnails panel
const thumbnailsPanel = document.getElementById('thumbnails-panel') as HTMLElement;
const thumbnailList = document.getElementById('thumbnail-list') as HTMLElement;

// ── State ───────────────────────────────────────────────────────────

type ToolMode = 'select' | 'edit-text' | 'insert-text' | 'move-text' | 'replace-image';

interface AppState {
  filePath: string | null;
  fileData: Uint8Array | null;
  docId: string | null;
  pageCount: number;
  currentPage: number;     // 0-based
  zoomPercent: number;
  modified: boolean;
  toolMode: ToolMode;
  pageObjects: PageObject[];
  selectedObjectId: number | null;
}

const state: AppState = {
  filePath: null,
  fileData: null,
  docId: null,
  pageCount: 0,
  currentPage: 0,
  zoomPercent: DEFAULT_ZOOM_PERCENT,
  modified: false,
  toolMode: 'select',
  pageObjects: [],
  selectedObjectId: null,
};

// ── Undo / Redo ─────────────────────────────────────────────────────

interface EditCommand {
  description: string;
  execute(): Promise<void>;
  undo(): Promise<void>;
}

class UndoStack {
  private readonly commands: EditCommand[] = [];
  private pointer = -1; // index of last executed command

  async push(cmd: EditCommand): Promise<void> {
    // Discard any redo history beyond current pointer
    this.commands.splice(this.pointer + 1);
    this.commands.push(cmd);
    // Enforce max depth
    if (this.commands.length > MAX_UNDO_DEPTH) {
      this.commands.shift();
    }
    this.pointer = this.commands.length - 1;
    await cmd.execute();
    this.updateButtons();
  }

  async undo(): Promise<void> {
    if (this.pointer < 0) return;
    const cmd = this.commands[this.pointer];
    await cmd.undo();
    this.pointer--;
    this.updateButtons();
  }

  async redo(): Promise<void> {
    if (this.pointer >= this.commands.length - 1) return;
    this.pointer++;
    const cmd = this.commands[this.pointer];
    await cmd.execute();
    this.updateButtons();
  }

  get canUndo(): boolean { return this.pointer >= 0; }
  get canRedo(): boolean { return this.pointer < this.commands.length - 1; }

  clear(): void {
    this.commands.length = 0;
    this.pointer = -1;
    this.updateButtons();
  }

  private updateButtons(): void {
    btnUndo.disabled = !this.canUndo;
    btnRedo.disabled = !this.canRedo;
  }
}

const undoStack = new UndoStack();
let activeEditorCommit: (() => void) | null = null;
let dragMove: { objectId: number; startX: number; startY: number } | null = null;
// Object IDs are stable while a document is open. These maps also let Undo/Redo
// restore the font choice that was in effect before an edit.
const insertedTextObjectIds = new Set<number>();
const objectFontNames = new Map<number, string | undefined>();
const objectFontSizes = new Map<number, number | undefined>();
const objectTextColors = new Map<number, string | undefined>();
let contextMenuObjectId: number | null = null;

function selectedFontName(): string | undefined {
  return fontSelect.value === 'auto' ? undefined : fontSelect.value;
}

function selectedFontSize(): number | undefined {
  const value = Number.parseFloat(fontSizeInput.value);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function selectedTextColor(): string | undefined {
  return textColorMode.value === 'custom' ? textColorInput.value : undefined;
}

function textScaleForSizeChange(
  object: PageObject,
  previousSize: number | undefined,
  nextSize: number | undefined,
): number {
  const baseSize = object.fontSize && object.fontSize > 0 ? object.fontSize : 12;
  const currentSize = previousSize ?? baseSize;
  const targetSize = nextSize ?? baseSize;
  return targetSize / currentSize;
}

function updateTextFormatAvailability(): void {
  const selectedText = state.selectedObjectId !== null &&
    state.pageObjects.some((obj) => obj.id === state.selectedObjectId && obj.type === 'text');
  const available = Boolean(state.docId) && (selectedText || state.toolMode === 'insert-text');
  btnDeleteSelectedText.disabled = !selectedText;
  for (const control of [fontSelect, fontSizeInput, textColorMode, textColorInput]) {
    control.disabled = !available;
  }
  textFormatSection.classList.toggle('available', available);
}

// ── Initialization ──────────────────────────────────────────────────
async function init(): Promise<void> {
  const version = await window.api.getVersion();
  versionEl.textContent = `v${version}`;
  await loadInstalledFonts();

  // Wire toolbar buttons
  btnOpen.addEventListener('click', handleOpen);
  btnSave.addEventListener('click', handleSave);
  btnSaveAs.addEventListener('click', handleSaveAs);

  // Zoom
  btnZoomIn.addEventListener('click', () => setZoom(state.zoomPercent + ZOOM_STEP_PERCENT));
  btnZoomOut.addEventListener('click', () => setZoom(state.zoomPercent - ZOOM_STEP_PERCENT));
  btnZoomFit.addEventListener('click', handleZoomFit);

  // Page navigation
  btnPrevPage.addEventListener('click', () => goToPage(state.currentPage - 1));
  btnNextPage.addEventListener('click', () => goToPage(state.currentPage + 1));
  pageInput.addEventListener('change', () => {
    const p = parseInt(pageInput.value, 10) - 1; // convert 1-based to 0-based
    if (!isNaN(p)) goToPage(p);
  });

  // Editing tools
  btnToolSelect.addEventListener('click', () => setToolMode('select'));
  btnToolEditText.addEventListener('click', () => setToolMode('edit-text'));
  btnToolInsertText.addEventListener('click', () => setToolMode('insert-text'));
  btnToolMoveText.addEventListener('click', () => setToolMode('move-text'));
  btnToolReplaceImage.addEventListener('click', () => setToolMode('replace-image'));
  btnDeleteSelectedText.addEventListener('click', () => {
    if (state.selectedObjectId !== null) void deleteTextObject(state.selectedObjectId, false);
  });
  btnCommitEdit.addEventListener('click', () => activeEditorCommit?.());
  fontSelect.addEventListener('change', () => { void applyStyleToSelectedText(); });
  fontSizeInput.addEventListener('change', () => { void applyStyleToSelectedText(); });
  textColorMode.addEventListener('change', () => { void applyStyleToSelectedText(); });
  textColorInput.addEventListener('input', () => {
    textColorMode.value = 'custom';
    void applyStyleToSelectedText();
  });
  btnUndo.addEventListener('click', () => undoStack.undo());
  btnRedo.addEventListener('click', () => undoStack.redo());

  // Canvas click for object selection
  overlayCanvas.addEventListener('click', handleCanvasClick);
  overlayCanvas.addEventListener('contextmenu', handleCanvasContextMenu);
  overlayCanvas.addEventListener('dblclick', handleCanvasDblClick);
  overlayCanvas.addEventListener('mousedown', handleCanvasMouseDown);
  window.addEventListener('mousemove', handleCanvasMouseMove);
  window.addEventListener('mouseup', handleCanvasMouseUp);

  // Wire drag-and-drop
  viewerContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone?.classList.add('drag-over');
  });
  viewerContainer.addEventListener('dragleave', () => {
    dropZone?.classList.remove('drag-over');
  });
  viewerContainer.addEventListener('drop', handleDrop);

  // Wire keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);
  document.addEventListener('click', (e) => {
    if (!textContextMenu.contains(e.target as Node)) hideTextContextMenu();
  });
  window.addEventListener('scroll', hideTextContextMenu, true);
  btnDeleteText.addEventListener('click', () => { void deleteInsertedTextFromContextMenu(); });

  // Subscribe to events from main
  window.api.onDocumentError((error) => setStatus(`エラー: ${error}`));

  setStatus('準備完了');
}

async function loadInstalledFonts(): Promise<void> {
  try {
    const fonts = await window.api.listInstalledFonts();
    const current = fontSelect.value;
    for (const font of fonts) {
      if ([...fontSelect.options].some((option) => option.value === font.fileName)) continue;
      fontSelect.add(new Option(font.label, font.fileName));
    }
    fontSelect.value = current || 'auto';
  } catch {
    // Font selection remains usable with the built-in options.
  }
}

// ── File handlers ───────────────────────────────────────────────────

async function handleOpen(): Promise<void> {
  setStatus('ファイルを開いています…');
  const result = await window.api.openFile();
  if (!result) { setStatus('準備完了'); return; }

  // Close previous document if any
  if (state.docId) {
    await window.api.pdf.close(state.docId);
  }

  state.filePath = result.filePath;
  state.fileData = result.data;

  // Open via PDFium
  try {
    const pdfResult = await window.api.pdf.open({ data: result.data });
    state.docId = pdfResult.docId;
    state.pageCount = pdfResult.pageCount;
    state.currentPage = 0;
    state.modified = false;
    state.selectedObjectId = null;
    state.pageObjects = [];
    insertedTextObjectIds.clear();
    objectFontNames.clear();
    objectFontSizes.clear();
    objectTextColors.clear();
    hideTextContextMenu();
    undoStack.clear();
  } catch (err) {
    setStatus(`PDFを開けませんでした: ${(err as Error).message}`);
    return;
  }

  const fileName = result.filePath.split(/[\\/]/).pop() ?? 'Untitled';
  fileNameEl.textContent = fileName;
  document.title = `${fileName} — アフロバット`;

  enableDocumentControls();

  // Hide drop zone, show canvas
  dropZone.style.display = 'none';
  canvasWrapper.style.display = 'grid';

  updatePageInfo();
  updateZoomInfo();
  updateDirtyIndicator();
  await renderCurrentPage();
  await buildThumbnails();

  setStatus(`開きました: ${fileName}（${state.pageCount}ページ）`);
}

async function handleSave(): Promise<void> {
  if (!state.docId || !state.filePath) return;
  setStatus('保存しています…');

  try {
    const result = await window.api.pdf.save({ docId: state.docId });
    const ok = await window.api.saveFile({ filePath: state.filePath, data: result.data });
    if (ok) {
      state.modified = false;
      state.fileData = result.data;
      updateDirtyIndicator();
      setStatus('保存しました');
    } else {
      setStatus('保存に失敗しました');
    }
  } catch (err) {
    setStatus(`保存エラー: ${(err as Error).message}`);
  }
}

async function handleSaveAs(): Promise<void> {
  if (!state.docId) return;
  setStatus('保存しています…');

  try {
    const result = await window.api.pdf.save({ docId: state.docId });
    const newPath = await window.api.saveFileAs(result.data);
    if (newPath) {
      state.filePath = newPath;
      state.modified = false;
      state.fileData = result.data;
      const fileName = newPath.split(/[\\/]/).pop() ?? 'Untitled';
      fileNameEl.textContent = fileName;
      document.title = `${fileName} — アフロバット`;
      updateDirtyIndicator();
      setStatus(`名前を付けて保存しました: ${fileName}`);
    } else {
      setStatus('準備完了');
    }
  } catch (err) {
    setStatus(`保存エラー: ${(err as Error).message}`);
  }
}

async function handleDrop(e: DragEvent): Promise<void> {
  e.preventDefault();
  dropZone?.classList.remove('drag-over');

  const file = e.dataTransfer?.files[0];
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) return;

  const arrayBuf = await file.arrayBuffer();
  const data = new Uint8Array(arrayBuf);

  if (state.docId) {
    await window.api.pdf.close(state.docId);
  }

  state.filePath = file.name; // No full path from drag-drop
  state.fileData = data;

  try {
    const pdfResult = await window.api.pdf.open({ data });
    state.docId = pdfResult.docId;
    state.pageCount = pdfResult.pageCount;
    state.currentPage = 0;
    state.modified = false;
    state.selectedObjectId = null;
    state.pageObjects = [];
    undoStack.clear();
  } catch (err) {
    setStatus(`PDFを開けませんでした: ${(err as Error).message}`);
    return;
  }

  fileNameEl.textContent = file.name;
  document.title = `${file.name} — アフロバット`;

  enableDocumentControls();
  dropZone.style.display = 'none';
  canvasWrapper.style.display = 'grid';

  updatePageInfo();
  updateZoomInfo();
  updateDirtyIndicator();
  await renderCurrentPage();
  await buildThumbnails();

  setStatus(`開きました: ${file.name}`);
}

// ── Rendering ───────────────────────────────────────────────────────

async function renderCurrentPage(): Promise<void> {
  if (!state.docId) return;

  const scale = state.zoomPercent / 100;
  try {
    const result = await window.api.pdf.renderPage({
      docId: state.docId,
      pageIndex: state.currentPage,
      scale,
    });

    const ctx = pageCanvas.getContext('2d');
    if (!ctx) return;

    pageCanvas.width = result.width;
    pageCanvas.height = result.height;

    // The result.image is RGBA bitmap data from PDFium
    const imageData = new ImageData(
      new Uint8ClampedArray(result.image),
      result.width,
      result.height,
    );
    ctx.putImageData(imageData, 0, 0);

    // Size overlay canvas to match
    overlayCanvas.width = result.width;
    overlayCanvas.height = result.height;
    overlayCanvas.style.width = pageCanvas.style.width = `${result.width}px`;
    overlayCanvas.style.height = pageCanvas.style.height = `${result.height}px`;

    // Fetch objects for this page
    await loadPageObjects();

    // Redraw selection overlay
    drawSelectionOverlay();
  } catch (err) {
    setStatus(`表示エラー: ${(err as Error).message}`);
  }
}

async function loadPageObjects(): Promise<void> {
  if (!state.docId) return;
  try {
    state.pageObjects = await window.api.pdf.listObjects({
      docId: state.docId,
      pageIndex: state.currentPage,
    });
  } catch {
    state.pageObjects = [];
  }
}

function drawSelectionOverlay(): void {
  const ctx = overlayCanvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (state.selectedObjectId === null) return;

  const obj = state.pageObjects.find((o) => o.id === state.selectedObjectId);
  if (!obj) return;

  const scale = state.zoomPercent / 100;

  // Convert PDF coordinates (bottom-left origin) to canvas (top-left origin)
  const x = obj.left * scale;
  const y = (overlayCanvas.height / scale - obj.top) * scale; // flip Y
  const w = (obj.right - obj.left) * scale;
  const h = (obj.top - obj.bottom) * scale;

  ctx.strokeStyle = '#0078d4';
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 2]);
  ctx.strokeRect(x, y, w, h);

  // Draw corner handles
  const HANDLE_SIZE = 6;
  ctx.fillStyle = '#0078d4';
  ctx.setLineDash([]);
  const corners = [
    [x, y], [x + w, y],
    [x, y + h], [x + w, y + h],
  ];
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
  }
}

// ── Thumbnails ──────────────────────────────────────────────────────

async function buildThumbnails(): Promise<void> {
  if (!state.docId) return;

  thumbnailList.innerHTML = '';
  const THUMB_SCALE = 0.2;

  for (let i = 0; i < state.pageCount; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'thumbnail-item';
    if (i === state.currentPage) wrapper.classList.add('active');
    wrapper.dataset.page = String(i);

    const label = document.createElement('span');
    label.className = 'thumbnail-label';
    label.textContent = String(i + 1);

    const canvas = document.createElement('canvas');
    canvas.className = 'thumbnail-canvas';

    wrapper.appendChild(canvas);
    wrapper.appendChild(label);
    thumbnailList.appendChild(wrapper);

    wrapper.addEventListener('click', () => goToPage(i));

    // Render thumbnail asynchronously
    try {
      const result = await window.api.pdf.renderPage({
        docId: state.docId!,
        pageIndex: i,
        scale: THUMB_SCALE,
      });
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const imgData = new ImageData(
          new Uint8ClampedArray(result.image),
          result.width,
          result.height,
        );
        ctx.putImageData(imgData, 0, 0);
      }
    } catch {
      // Thumbnail render failed — leave blank
    }
  }
}

function updateActiveThumbnail(): void {
  const items = thumbnailList.querySelectorAll('.thumbnail-item');
  items.forEach((el, idx) => {
    el.classList.toggle('active', idx === state.currentPage);
  });
}

// ── Page navigation ─────────────────────────────────────────────────

async function goToPage(pageIndex: number): Promise<void> {
  if (pageIndex < 0 || pageIndex >= state.pageCount) return;
  state.currentPage = pageIndex;
  state.selectedObjectId = null;
  updateTextFormatAvailability();
  updatePageInfo();
  updateActiveThumbnail();
  await renderCurrentPage();
}

// ── Zoom ────────────────────────────────────────────────────────────

async function setZoom(percent: number): Promise<void> {
  const clamped = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, percent));
  if (clamped === state.zoomPercent) return;
  state.zoomPercent = clamped;
  updateZoomInfo();
  await renderCurrentPage();
}

function handleZoomFit(): void {
  if (!state.docId) return;
  // Approximate: set zoom so page width fills viewer container
  const containerWidth = viewerContainer.clientWidth - 40; // padding
  const pageWidth = pageCanvas.width / (state.zoomPercent / 100);
  if (pageWidth > 0) {
    const fitPercent = Math.round((containerWidth / pageWidth) * 100);
    setZoom(fitPercent);
  }
}

// ── Object selection & hit testing ──────────────────────────────────

function handleCanvasClick(e: MouseEvent): void {
  if (!state.docId) return;

  hideTextContextMenu();
  const point = canvasPointToPdf(e.clientX, e.clientY);
  const { canvasX, canvasY, pdfX, pdfY } = point;

  if (state.toolMode === 'insert-text') {
    openNewTextEditor(pdfX, pdfY, canvasX, canvasY);
    return;
  }

  const hit = hitTestObject(pdfX, pdfY);

  state.selectedObjectId = hit ? hit.id : null;
  if (hit?.type === 'text') syncFontPickerToObject(hit.id);
  updateTextFormatAvailability();
  drawSelectionOverlay();
  updatePropertiesPanel(hit);
}

function canvasPointToPdf(clientX: number, clientY: number): {
  canvasX: number; canvasY: number; pdfX: number; pdfY: number;
} {
  const rect = overlayCanvas.getBoundingClientRect();
  const canvasX = clientX - rect.left;
  const canvasY = clientY - rect.top;
  const scale = state.zoomPercent / 100;
  return {
    canvasX,
    canvasY,
    pdfX: canvasX / scale,
    pdfY: (overlayCanvas.height - canvasY) / scale,
  };
}

function hitTestObject(pdfX: number, pdfY: number): PageObject | null {
  for (let i = state.pageObjects.length - 1; i >= 0; i--) {
    const obj = state.pageObjects[i];
    if (pdfX >= obj.left && pdfX <= obj.right && pdfY >= obj.bottom && pdfY <= obj.top) {
      return obj;
    }
  }
  return null;
}

function syncFontPickerToObject(objectId: number): void {
  // Existing PDF fonts can be subsetted or malformed for replacement text.
  // Use the installed Meiryo bold as the safe editing default; the original
  // PDF font remains available as an explicit choice in the toolbar.
  const choice = objectFontNames.has(objectId) ? objectFontNames.get(objectId) : 'meiryob_3.ttc';
  const value = choice === undefined ? 'auto' : choice;
  if ([...fontSelect.options].some((option) => option.value === value)) {
    fontSelect.value = value;
  }
  fontSizeInput.value = objectFontSizes.has(objectId) && objectFontSizes.get(objectId) !== undefined
    ? String(objectFontSizes.get(objectId)) : '';
  fontSizeInput.placeholder = objectFontSizes.has(objectId) ? 'pt' : '元';
  const textColor = objectTextColors.get(objectId);
  if (textColor) {
    textColorMode.value = 'custom';
    textColorInput.value = textColor;
  } else {
    textColorMode.value = 'original';
  }
}

function handleCanvasContextMenu(e: MouseEvent): void {
  e.preventDefault();
  if (!state.docId) return;
  const point = canvasPointToPdf(e.clientX, e.clientY);
  const hit = hitTestObject(point.pdfX, point.pdfY);
  if (!hit || hit.type !== 'text' || !insertedTextObjectIds.has(hit.id)) {
    hideTextContextMenu();
    return;
  }

  state.selectedObjectId = hit.id;
  contextMenuObjectId = hit.id;
  syncFontPickerToObject(hit.id);
  updateTextFormatAvailability();
  drawSelectionOverlay();
  updatePropertiesPanel(hit);
  textContextMenu.hidden = false;
  textContextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  textContextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 60)}px`;
}

function hideTextContextMenu(): void {
  contextMenuObjectId = null;
  textContextMenu.hidden = true;
}

async function deleteInsertedTextFromContextMenu(): Promise<void> {
  const objectId = contextMenuObjectId;
  hideTextContextMenu();
  if (objectId === null) return;
  await deleteTextObject(objectId, true);
}

async function deleteTextObject(objectId: number, insertedOnly: boolean): Promise<void> {
  if (!state.docId || (insertedOnly && !insertedTextObjectIds.has(objectId))) return;
  const obj = state.pageObjects.find((candidate) => candidate.id === objectId);
  if (!obj || obj.type !== 'text') return;

  const docId = state.docId;
  const pageIndex = state.currentPage;
  const text = obj.text || ' ';
  const x = obj.left;
  const y = obj.bottom;
  const fontName = objectFontNames.get(objectId);
  const fontSize = objectFontSizes.get(objectId) ?? 12;
  const textColor = objectTextColors.get(objectId);
  let currentObjectId = objectId;
  const cmd: EditCommand = {
    description: 'Delete inserted text object',
    async execute(): Promise<void> {
      await window.api.pdf.removeText({ docId, pageIndex, objectId: currentObjectId });
      insertedTextObjectIds.delete(currentObjectId);
      objectFontNames.delete(currentObjectId);
      objectFontSizes.delete(currentObjectId);
      objectTextColors.delete(currentObjectId);
      if (state.selectedObjectId === currentObjectId) state.selectedObjectId = null;
      updateTextFormatAvailability();
      updatePropertiesPanel(null);
      markDirty();
      await renderCurrentPage();
    },
    async undo(): Promise<void> {
      const result = await window.api.pdf.insertText({
        docId, pageIndex, x, y, newText: text, fontSize,
        fontName: fontName === undefined ? undefined : fontName,
        textColor,
      });
      currentObjectId = result.objectId;
      insertedTextObjectIds.add(currentObjectId);
      objectFontNames.set(currentObjectId, fontName);
      objectFontSizes.set(currentObjectId, fontSize);
      objectTextColors.set(currentObjectId, textColor);
      state.selectedObjectId = currentObjectId;
      markDirty();
      await renderCurrentPage();
    },
  };
  await undoStack.push(cmd);
}

async function applyStyleToSelectedText(): Promise<void> {
  if (!state.docId || state.selectedObjectId === null) return;
  const obj = state.pageObjects.find((candidate) => candidate.id === state.selectedObjectId);
  if (!obj || obj.type !== 'text') return;

  const objectId = obj.id;
  const docId = state.docId;
  const pageIndex = state.currentPage;
  const newText = obj.text || ' ';
  const previousFontName = objectFontNames.has(objectId) ? objectFontNames.get(objectId) : 'original';
  const previousFontSize = objectFontSizes.has(objectId) ? objectFontSizes.get(objectId) : undefined;
  const previousTextColor = objectTextColors.has(objectId) ? objectTextColors.get(objectId) : undefined;
  const newFontName = selectedFontName();
  const newFontSize = selectedFontSize();
  const newTextColor = selectedTextColor();
  const fontScale = textScaleForSizeChange(obj, previousFontSize, newFontSize);
  if (previousFontName === newFontName && previousFontSize === newFontSize && previousTextColor === newTextColor) return;

  const cmd: EditCommand = {
    description: `Change font for text object ${objectId}`,
    async execute(): Promise<void> {
      await window.api.pdf.editText({
        docId, pageIndex, objectId, newText, fontName: newFontName,
        fontSize: undefined, fontScale, textColor: newTextColor,
      });
      if (newFontName === 'original') objectFontNames.delete(objectId);
      else objectFontNames.set(objectId, newFontName);
      if (newFontSize === undefined) objectFontSizes.delete(objectId);
      else objectFontSizes.set(objectId, newFontSize);
      if (newTextColor === undefined) objectTextColors.delete(objectId);
      else objectTextColors.set(objectId, newTextColor);
      markDirty();
      await renderCurrentPage();
    },
    async undo(): Promise<void> {
      await window.api.pdf.editText({
        docId, pageIndex, objectId, newText, fontName: previousFontName,
        fontSize: undefined, fontScale: fontScale === 0 ? undefined : 1 / fontScale,
        textColor: previousTextColor,
      });
      if (previousFontName === 'original') objectFontNames.delete(objectId);
      else objectFontNames.set(objectId, previousFontName);
      if (previousFontSize === undefined) objectFontSizes.delete(objectId);
      else objectFontSizes.set(objectId, previousFontSize);
      if (previousTextColor === undefined) objectTextColors.delete(objectId);
      else objectTextColors.set(objectId, previousTextColor);
      syncFontPickerToObject(objectId);
      markDirty();
      await renderCurrentPage();
    },
  };
  await undoStack.push(cmd);
}

function handleCanvasMouseDown(e: MouseEvent): void {
  if (!state.docId || (state.toolMode !== 'move-text' && state.toolMode !== 'select')) return;
  const rect = overlayCanvas.getBoundingClientRect();
  const scale = state.zoomPercent / 100;
  const x = (e.clientX - rect.left) / scale;
  const y = (overlayCanvas.height - (e.clientY - rect.top)) / scale;
  for (let i = state.pageObjects.length - 1; i >= 0; i--) {
    const obj = state.pageObjects[i];
    if (obj.type === 'text' && x >= obj.left && x <= obj.right && y >= obj.bottom && y <= obj.top) {
      state.selectedObjectId = obj.id;
      syncFontPickerToObject(obj.id);
      updateTextFormatAvailability();
      drawSelectionOverlay();
      updatePropertiesPanel(obj);
      dragMove = { objectId: obj.id, startX: e.clientX, startY: e.clientY };
      overlayCanvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
  }
}

function handleCanvasMouseMove(e: MouseEvent): void {
  if (dragMove) e.preventDefault();
}

function handleCanvasMouseUp(e: MouseEvent): void {
  if (!dragMove || !state.docId) return;
  const drag = dragMove;
  dragMove = null;
  overlayCanvas.style.cursor = state.toolMode === 'select' ? 'default' : 'crosshair';
  const scale = state.zoomPercent / 100;
  const dx = (e.clientX - drag.startX) / scale;
  const dy = -(e.clientY - drag.startY) / scale;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  void moveTextWithUndo(drag.objectId, dx, dy);
}

async function moveTextWithUndo(objectId: number, dx: number, dy: number): Promise<void> {
  if (!state.docId) return;
  const docId = state.docId;
  const pageIndex = state.currentPage;
  const cmd: EditCommand = {
    description: `Move text object ${objectId}`,
    async execute(): Promise<void> {
      await window.api.pdf.moveText({ docId, pageIndex, objectId, dx, dy });
      markDirty();
      await renderCurrentPage();
    },
    async undo(): Promise<void> {
      await window.api.pdf.moveText({ docId, pageIndex, objectId, dx: -dx, dy: -dy });
      markDirty();
      await renderCurrentPage();
    },
  };
  await undoStack.push(cmd);
}

function handleCanvasDblClick(e: MouseEvent): void {
  if (!state.docId || !state.selectedObjectId) return;

  const obj = state.pageObjects.find((o) => o.id === state.selectedObjectId);
  if (!obj) return;

  if (state.toolMode === 'edit-text' && obj.type === 'text') {
    openInPlaceTextEditor(obj);
  } else if (state.toolMode === 'replace-image' && obj.type === 'image') {
    handleReplaceImage(obj);
  } else if (obj.type === 'text') {
    // Auto-switch to text edit mode on double-click
    setToolMode('edit-text');
    openInPlaceTextEditor(obj);
  }
}

// ── In-place text editor ────────────────────────────────────────────

function openInPlaceTextEditor(obj: PageObject): void {
  // Remove any existing editor
  const existing = document.getElementById('in-place-editor');
  if (existing) existing.remove();

  const scale = state.zoomPercent / 100;

  const editor = document.createElement('div');
  editor.id = 'in-place-editor';
  editor.contentEditable = 'true';
  editor.className = 'in-place-text-editor';

  // Position over the object
  const x = obj.left * scale;
  const canvasTop = (overlayCanvas.height / scale - obj.top) * scale;
  const w = (obj.right - obj.left) * scale;
  const h = (obj.top - obj.bottom) * scale;

  editor.style.left = `${x}px`;
  editor.style.top = `${canvasTop}px`;
  editor.style.width = `${w}px`;
  editor.style.minHeight = `${h}px`;
  editor.style.fontSize = `${12 * scale}px`;

  // Pre-fill with the object's current text content
  const originalText = obj.text ?? '';
  editor.textContent = originalText;

  const commitEdit = async (): Promise<void> => {
    const newText = editor.textContent ?? '';
    editor.remove();
    activeEditorCommit = null;
    btnCommitEdit.disabled = true;
    if (!state.docId || newText === originalText) return;

    const docId = state.docId;
    const pageIndex = state.currentPage;
    const objectId = obj.id;
    const previousFontName = objectFontNames.has(objectId) ? objectFontNames.get(objectId) : 'original';
    const previousFontSize = objectFontSizes.has(objectId) ? objectFontSizes.get(objectId) : undefined;
    const previousTextColor = objectTextColors.has(objectId) ? objectTextColors.get(objectId) : undefined;
    const newFontName = selectedFontName();
    const newFontSize = selectedFontSize();
    const newTextColor = selectedTextColor();
    const fontScale = textScaleForSizeChange(obj, previousFontSize, newFontSize);

    const cmd: EditCommand = {
      description: `Edit text object ${objectId}`,
      async execute(): Promise<void> {
        // PDFium rejects a truly empty string. A space is visually blank but
        // keeps the deletion reversible with Ctrl+Z.
        await window.api.pdf.editText({
          docId, pageIndex, objectId, newText: newText || ' ',
          fontName: newFontName,
          fontSize: undefined,
          fontScale,
          textColor: newTextColor,
        });
        if (newFontName === 'original') objectFontNames.delete(objectId);
        else objectFontNames.set(objectId, newFontName);
        if (newFontSize === undefined) objectFontSizes.delete(objectId);
        else objectFontSizes.set(objectId, newFontSize);
        if (newTextColor === undefined) objectTextColors.delete(objectId);
        else objectTextColors.set(objectId, newTextColor);
        markDirty();
        await renderCurrentPage();
      },
      async undo(): Promise<void> {
        await window.api.pdf.editText({
          docId, pageIndex, objectId, newText: originalText || ' ',
          fontName: previousFontName,
          fontSize: undefined,
          fontScale: fontScale === 0 ? undefined : 1 / fontScale,
          textColor: previousTextColor,
        });
        if (previousFontName === 'original') objectFontNames.delete(objectId);
        else objectFontNames.set(objectId, previousFontName);
        if (previousFontSize === undefined) objectFontSizes.delete(objectId);
        else objectFontSizes.set(objectId, previousFontSize);
        if (previousTextColor === undefined) objectTextColors.delete(objectId);
        else objectTextColors.set(objectId, previousTextColor);
        syncFontPickerToObject(objectId);
        markDirty();
        await renderCurrentPage();
      },
    };

    await undoStack.push(cmd);
  };

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    }
    if (e.key === 'Escape') {
      activeEditorCommit = null;
      btnCommitEdit.disabled = true;
      editor.remove();
    }
  });

  editor.addEventListener('blur', () => {
    // Commit on blur (unless already removed by Escape)
    if (editor.parentElement) commitEdit();
  });

  viewerContainer.appendChild(editor);
  activeEditorCommit = () => { void commitEdit(); };
  btnCommitEdit.disabled = false;
  editor.focus();

  // Select all text for easy replacement
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/** Open an editor at an empty page position and insert a new text object. */
function openNewTextEditor(pdfX: number, pdfY: number, canvasX: number, canvasY: number): void {
  const existing = document.getElementById('in-place-editor');
  if (existing) existing.remove();

  const scale = state.zoomPercent / 100;
  const editor = document.createElement('div');
  editor.id = 'in-place-editor';
  editor.contentEditable = 'true';
  editor.className = 'in-place-text-editor new-text-editor';
  editor.style.left = `${canvasX}px`;
  editor.style.top = `${canvasY - 14 * scale}px`;
  editor.style.width = `${180 * scale}px`;
  editor.style.minHeight = `${18 * scale}px`;
  editor.style.fontSize = `${12 * scale}px`;
  editor.dataset.placeholder = '文字を入力';

  let committed = false;
  const commitInsert = async (): Promise<void> => {
    if (committed) return;
    committed = true;
    const newText = editor.textContent ?? '';
    editor.remove();
    activeEditorCommit = null;
    btnCommitEdit.disabled = true;
    if (!state.docId || !newText.trim()) return;

    const docId = state.docId;
    const pageIndex = state.currentPage;
  const insertedFontName = selectedFontName();
    const insertedFontSize = selectedFontSize() ?? 12;
    const insertedTextColor = selectedTextColor();
    let insertedObjectId = -1;
    const cmd: EditCommand = {
      description: 'Insert text object',
      async execute(): Promise<void> {
        const result = await window.api.pdf.insertText({
          docId, pageIndex, x: pdfX, y: pdfY, newText, fontSize: insertedFontSize,
          fontName: insertedFontName,
          textColor: insertedTextColor,
        });
        insertedObjectId = result.objectId;
        insertedTextObjectIds.add(insertedObjectId);
        objectFontNames.set(insertedObjectId, insertedFontName);
        objectFontSizes.set(insertedObjectId, insertedFontSize);
        objectTextColors.set(insertedObjectId, insertedTextColor);
        markDirty();
        await renderCurrentPage();
      },
      async undo(): Promise<void> {
        if (insertedObjectId < 0) return;
        await window.api.pdf.removeText({ docId, pageIndex, objectId: insertedObjectId });
        insertedTextObjectIds.delete(insertedObjectId);
        objectFontNames.delete(insertedObjectId);
        objectFontSizes.delete(insertedObjectId);
        objectTextColors.delete(insertedObjectId);
        if (state.selectedObjectId === insertedObjectId) state.selectedObjectId = null;
        markDirty();
        await renderCurrentPage();
      },
    };
    await undoStack.push(cmd);
  };

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void commitInsert();
    }
    if (e.key === 'Escape') {
      committed = true;
      activeEditorCommit = null;
      btnCommitEdit.disabled = true;
      editor.remove();
    }
  });
  editor.addEventListener('blur', () => {
    if (editor.parentElement) void commitInsert();
  });
  viewerContainer.appendChild(editor);
  activeEditorCommit = () => { void commitInsert(); };
  btnCommitEdit.disabled = false;
  editor.focus();
}

// ── Image replacement ───────────────────────────────────────────────

async function handleReplaceImage(obj: PageObject): Promise<void> {
  if (!state.docId) return;

  // Create a file input to pick the replacement image
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg';

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    const format: 'png' | 'jpeg' = file.type === 'image/png' ? 'png' : 'jpeg';
    const arrayBuf = await file.arrayBuffer();
    const imageData = new Uint8Array(arrayBuf);

    const docId = state.docId!;
    const pageIndex = state.currentPage;
    const objectId = obj.id;

    // For undo we'd need the original image data — simplified for now
    const cmd: EditCommand = {
      description: `Replace image object ${objectId}`,
      async execute(): Promise<void> {
        await window.api.pdf.replaceImage({ docId, pageIndex, objectId, image: imageData, format });
        markDirty();
        await renderCurrentPage();
      },
      async undo(): Promise<void> {
        // TODO: Store original image for true undo — for now just re-render
        setStatus('画像置換の取り消しは未対応です');
        await renderCurrentPage();
      },
    };

    await undoStack.push(cmd);
  });

  input.click();
}

// ── Tool mode ───────────────────────────────────────────────────────

function setToolMode(mode: ToolMode): void {
  state.toolMode = mode;
  btnToolSelect.classList.toggle('active', mode === 'select');
  btnToolEditText.classList.toggle('active', mode === 'edit-text');
  btnToolInsertText.classList.toggle('active', mode === 'insert-text');
  btnToolMoveText.classList.toggle('active', mode === 'move-text');
  btnToolReplaceImage.classList.toggle('active', mode === 'replace-image');
  overlayCanvas.style.cursor = mode === 'select' ? 'default' : 'crosshair';
  updateTextFormatAvailability();
}

// ── Properties panel ────────────────────────────────────────────────

function updatePropertiesPanel(obj: PageObject | null): void {
  const panel = document.getElementById('properties-panel');
  if (!panel) return;

  if (!obj) {
    panel.innerHTML = '<p class="placeholder">プロパティ</p>';
    return;
  }

  panel.innerHTML = `
    <div class="properties-content">
      <h4>Object #${obj.id}</h4>
      <p><strong>Type:</strong> ${obj.type}</p>
      <p><strong>Bounds:</strong></p>
      <p class="indent">L: ${obj.left.toFixed(1)}, T: ${obj.top.toFixed(1)}</p>
      <p class="indent">R: ${obj.right.toFixed(1)}, B: ${obj.bottom.toFixed(1)}</p>
      <p><strong>Size:</strong> ${(obj.right - obj.left).toFixed(1)} × ${(obj.top - obj.bottom).toFixed(1)} pt</p>
    </div>
  `;
}

// ── Dirty state ─────────────────────────────────────────────────────

function markDirty(): void {
  state.modified = true;
  updateDirtyIndicator();
}

function updateDirtyIndicator(): void {
  dirtyIndicator.style.display = state.modified ? 'inline' : 'none';
  const fileName = fileNameEl.textContent ?? '';
  const titleBase = fileName.replace(/^\*\s*/, '');
  document.title = state.modified
    ? `* ${titleBase} — アフロバット`
    : `${titleBase} — アフロバット`;
}

// ── Keyboard shortcuts ──────────────────────────────────────────────

function handleKeyboard(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;

  // File operations
  if (mod && e.key === 'o') { e.preventDefault(); handleOpen(); }
  if (mod && !e.shiftKey && e.key === 's') { e.preventDefault(); handleSave(); }
  if (mod && e.shiftKey && e.key === 'S') { e.preventDefault(); handleSaveAs(); }

  // Undo / redo
  if (mod && !e.shiftKey && e.key === 'z') { e.preventDefault(); undoStack.undo(); }
  if (mod && e.shiftKey && e.key === 'Z') { e.preventDefault(); undoStack.redo(); }

  // Zoom
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(state.zoomPercent + ZOOM_STEP_PERCENT); }
  if (mod && e.key === '-') { e.preventDefault(); setZoom(state.zoomPercent - ZOOM_STEP_PERCENT); }
  if (mod && e.key === '0') { e.preventDefault(); setZoom(DEFAULT_ZOOM_PERCENT); }

  // Page navigation
  if (e.key === 'PageUp') { e.preventDefault(); goToPage(state.currentPage - 1); }
  if (e.key === 'PageDown') { e.preventDefault(); goToPage(state.currentPage + 1); }
  if (e.key === 'Home' && mod) { e.preventDefault(); goToPage(0); }
  if (e.key === 'End' && mod) { e.preventDefault(); goToPage(state.pageCount - 1); }

  // Tool shortcuts
  if (e.key === 'v' && !mod) { setToolMode('select'); }
  if (e.key === 't' && !mod) { setToolMode('edit-text'); }
  if (e.key === 'n' && !mod) { setToolMode('insert-text'); }
  if (e.key === 'm' && !mod) { setToolMode('move-text'); }
  if (e.key === 'i' && !mod) { setToolMode('replace-image'); }

  if (state.toolMode === 'move-text' && state.selectedObjectId !== null && !mod) {
    const distance = e.shiftKey ? 5 : 1;
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-distance, 0], ArrowRight: [distance, 0],
      ArrowUp: [0, distance], ArrowDown: [0, -distance],
    };
    const delta = deltas[e.key];
    const selected = state.pageObjects.find((obj) => obj.id === state.selectedObjectId);
    if (delta && selected?.type === 'text') {
      e.preventDefault();
      void moveTextWithUndo(selected.id, delta[0], delta[1]);
    }
  }

  // Escape deselects
  if (e.key === 'Escape') {
    state.selectedObjectId = null;
    drawSelectionOverlay();
    updatePropertiesPanel(null);
    updateTextFormatAvailability();
  }
}

// ── UI Helpers ──────────────────────────────────────────────────────

function enableDocumentControls(): void {
  btnSave.disabled = false;
  btnSaveAs.disabled = false;
  btnZoomIn.disabled = false;
  btnZoomOut.disabled = false;
  btnZoomFit.disabled = false;
  btnPrevPage.disabled = false;
  btnNextPage.disabled = false;
  pageInput.disabled = false;
  btnToolSelect.disabled = false;
  btnToolEditText.disabled = false;
  btnToolInsertText.disabled = false;
  btnToolMoveText.disabled = false;
  btnToolReplaceImage.disabled = false;
  updateTextFormatAvailability();
}

function updatePageInfo(): void {
  pageInput.value = String(state.currentPage + 1);
  pageInput.max = String(state.pageCount);
  pageTotalEl.textContent = `/ ${state.pageCount}`;
  pageInfo.textContent = `Page ${state.currentPage + 1} of ${state.pageCount}`;
  btnPrevPage.disabled = state.currentPage === 0;
  btnNextPage.disabled = state.currentPage >= state.pageCount - 1;
}

function updateZoomInfo(): void {
  zoomLevelEl.textContent = `${state.zoomPercent}%`;
  zoomInfoEl.textContent = `Zoom: ${state.zoomPercent}%`;
  btnZoomIn.disabled = state.zoomPercent >= MAX_ZOOM_PERCENT;
  btnZoomOut.disabled = state.zoomPercent <= MIN_ZOOM_PERCENT;
}

function setStatus(text: string): void {
  statusText.textContent = text;
}

// ── Boot ────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error('[Renderer] Init failed:', err);
  setStatus('初期化エラー');
});
