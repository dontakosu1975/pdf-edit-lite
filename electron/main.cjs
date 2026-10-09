const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 720, backgroundColor: '#eef2f7', title: 'PDF Edit Lite', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.loadURL('http://127.0.0.1:5173');
}
async function openPdf() {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePaths[0]) return;
  mainWindow.webContents.send('open-file', { name: path.basename(result.filePaths[0]), bytes: Array.from(fs.readFileSync(result.filePaths[0])) });
}
ipcMain.handle('save-pdf', async (_event, bytes) => {
  const result = await dialog.showSaveDialog(mainWindow, { defaultPath: 'edited.pdf', filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!result.canceled && result.filePath) fs.writeFileSync(result.filePath, Buffer.from(bytes));
  return !result.canceled;
});
app.whenReady().then(() => {
  createWindow();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'ファイル', submenu: [{ label: 'PDFを開く', accelerator: 'CmdOrCtrl+O', click: openPdf }, { label: '編集済みPDFを書き出す', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('request-export') }, { type: 'separator' }, { role: 'quit', label: '終了' }] }, { label: '表示', submenu: [{ role: 'reload', label: '再読み込み' }, { role: 'toggleDevTools', label: '開発者ツール' }] }]));
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
