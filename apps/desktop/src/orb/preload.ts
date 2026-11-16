// The orb page's only door to the main process (sandboxed, context-isolated): two IPC channels, nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import type { FromOrb, OrbBridge, ToOrb } from './protocol.ts';

const bridge: OrbBridge = {
  on: (listener) => void ipcRenderer.on('orb', (_e, msg: ToOrb) => listener(msg)),
  send: (msg: FromOrb) => ipcRenderer.send('orb:event', msg),
};
contextBridge.exposeInMainWorld('orb', bridge);
