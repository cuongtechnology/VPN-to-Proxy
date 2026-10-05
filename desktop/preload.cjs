const { contextBridge, ipcRenderer } = require("electron");
const allowed = new Set([
  "load",
  "save",
  "status",
  "start",
  "stop",
  "keys",
  "parseProfile",
  "exportPeer",
  "enginePath",
  "chooseEngine",
]);
contextBridge.exposeInMainWorld("vpntoproxy", {
  call(method, args) {
    if (!allowed.has(method))
      return Promise.reject(new Error("unknownOperation"));
    return ipcRenderer.invoke("vpntoproxy", method, args);
  },
});
