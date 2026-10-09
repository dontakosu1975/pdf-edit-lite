import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import './style.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

const $ = (id) => document.getElementById(id);
const state = { pdfBytes: null, pdfDoc: null, page: 1, scale: 1, overlays: new Map(), selected: null, fontBytes: null, fontName: '' };
const canvas = $('pdf-canvas');
const ctx = canvas.getContext('2d');

function setEnabled(enabled) {
  ['add-text', 'delete-text', 'add-quick', 'export', 'prev-page', 'next-page', 'zoom-out', 'zoom-in'].forEach((id) => $(id).disabled = !enabled);
}

function currentItems() { return state.overlays.get(state.page) || []; }

function renderOverlay() {
  const overlay = $('overlay');
  overlay.replaceChildren();
  currentItems().forEach((item) => {
    const el = document.createElement('div');
    el.className = `text-item${item.id === state.selected ? ' selected' : ''}`;
    el.dataset.id = item.id;
    el.textContent = item.text || '入力';
    el.style.left = `${item.x * state.scale}px`;
    el.style.top = `${item.y * state.scale}px`;
    el.style.fontSize = `${item.size * state.scale}px`;
    el.style.color = item.color;
    el.addEventListener('pointerdown', startDrag);
    el.addEventListener('click', (event) => { event.stopPropagation(); selectItem(item.id); });
    overlay.appendChild(el);
  });
}

function selectItem(id) {
  state.selected = id;
  const item = currentItems().find((candidate) => candidate.id === id);
  $('property-form').hidden = !item;
  $('properties').querySelector('.muted').hidden = Boolean(item);
  if (item) {
    $('text-value').value = item.text;
    $('text-size').value = item.size;
    $('text-color').value = item.color;
  }
  renderOverlay();
}

function addText(text = '入力') {
  const items = currentItems();
  const item = { id: crypto.randomUUID(), text, x: 80 / state.scale, y: 80 / state.scale, size: 24, color: '#111111' };
  items.push(item);
  state.overlays.set(state.page, items);
  selectItem(item.id);
}

function startDrag(event) {
  event.preventDefault();
  const id = event.currentTarget.dataset.id;
  selectItem(id);
  const item = currentItems().find((candidate) => candidate.id === id);
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = item.x;
  const originY = item.y;
  const move = (moveEvent) => {
    item.x = Math.max(0, originX + (moveEvent.clientX - startX) / state.scale);
    item.y = Math.max(0, originY + (moveEvent.clientY - startY) / state.scale);
    renderOverlay();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

async function renderPage() {
  const page = await state.pdfDoc.getPage(state.page);
  const viewport = page.getViewport({ scale: state.scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  $('overlay').style.width = `${viewport.width}px`;
  $('overlay').style.height = `${viewport.height}px`;
  await page.render({ canvasContext: ctx, viewport }).promise;
  $('page-label').textContent = `${state.page} / ${state.pdfDoc.numPages}`;
  $('zoom-label').textContent = `${Math.round(state.scale * 100)}%`;
  $('prev-page').disabled = state.page <= 1;
  $('next-page').disabled = state.page >= state.pdfDoc.numPages;
  renderOverlay();
}

async function openPdf(file) {
  state.pdfBytes = new Uint8Array(await file.arrayBuffer());
  state.pdfDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() }).promise;
  state.page = 1;
  state.scale = 1;
  state.overlays.clear();
  $('empty-state').hidden = true;
  $('page-wrap').hidden = false;
  setEnabled(true);
  await renderPage();
}

$('pdf-input').addEventListener('change', (event) => event.target.files[0] && openPdf(event.target.files[0]));
window.electronAPI?.onOpenFile(async (file) => {
  await openPdf(new File([new Uint8Array(file.bytes)], file.name, { type: 'application/pdf' }));
});
$('add-text').addEventListener('click', () => addText());
$('delete-text').addEventListener('click', () => {
  if (!state.selected) return;
  state.overlays.set(state.page, currentItems().filter((item) => item.id !== state.selected));
  state.selected = null;
  selectItem(null);
});
$('overlay').addEventListener('click', () => selectItem(null));
$('apply-properties').addEventListener('click', () => {
  const item = currentItems().find((candidate) => candidate.id === state.selected);
  if (!item) return;
  item.text = $('text-value').value;
  item.size = Number($('text-size').value) || 24;
  item.color = $('text-color').value;
  renderOverlay();
});
$('prev-page').addEventListener('click', async () => { if (state.page > 1) { state.page -= 1; state.selected = null; await renderPage(); } });
$('next-page').addEventListener('click', async () => { if (state.page < state.pdfDoc.numPages) { state.page += 1; state.selected = null; await renderPage(); } });
$('zoom-out').addEventListener('click', async () => { state.scale = Math.max(.5, state.scale - .1); await renderPage(); });
$('zoom-in').addEventListener('click', async () => { state.scale = Math.min(2.5, state.scale + .1); await renderPage(); });
$('add-quick').addEventListener('click', () => {
  document.querySelectorAll('[data-quick]').forEach((input, index) => {
    if (input.value.trim()) {
      addText(input.value.trim());
      const item = currentItems().find((candidate) => candidate.id === state.selected);
      item.x = [80, 80, 80][index]; item.y = [80, 130, 180][index];
    }
  });
  renderOverlay();
});
$('font-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  state.fontBytes = new Uint8Array(await file.arrayBuffer());
  state.fontName = file.name;
  $('font-status').textContent = `読み込み済み: ${file.name}`;
});

async function exportPdf() {
  const doc = await PDFDocument.load(state.pdfBytes);
  if (state.fontBytes) doc.registerFontkit(fontkit);
  const font = state.fontBytes ? await doc.embedFont(state.fontBytes) : await doc.embedFont(StandardFonts.Helvetica);
  state.overlays.forEach((items, pageNumber) => {
    const page = doc.getPage(pageNumber - 1);
    const factor = page.getWidth() / canvas.width * state.scale;
    items.forEach((item) => {
      const width = Math.max(90, item.text.length * item.size * .7);
      page.drawRectangle({ x: item.x * factor - 3, y: page.getHeight() - (item.y + item.size) * factor - 4, width: width * factor, height: (item.size + 8) * factor, color: rgb(1, 1, 1) });
      const hex = item.color.replace('#', '');
      const color = rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
      page.drawText(item.text, { x: item.x * factor, y: page.getHeight() - (item.y + item.size) * factor, size: item.size * factor, font, color });
    });
  });
  const bytes = await doc.save();
  if (window.electronAPI) {
    await window.electronAPI.savePdf(Array.from(bytes));
  } else {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a'); link.href = url; link.download = 'edited.pdf'; link.click(); URL.revokeObjectURL(url);
  }
}
$('export').addEventListener('click', exportPdf);
window.electronAPI?.onRequestExport(() => exportPdf());
