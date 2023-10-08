// 所有的 Node.js API接口 都可以在 preload 进程中被调用.
// 它拥有与Chrome扩展一样的沙盒。

const { ipcRenderer, contextBridge } = require('electron')

function fetch_electron(path, msg) {
    console.log(msg)
    return ipcRenderer.invoke('message', path, msg).then((result) => {
        let [status, msg, file] = result
        
        console.log(result)
        return [status, msg, file]
    })
}

function new_window() {
    return ipcRenderer.invoke('new_window')
}


window.addEventListener('DOMContentLoaded', () => {
    contextBridge.exposeInMainWorld('is_electron', true)
    contextBridge.exposeInMainWorld('fetch_electron', fetch_electron)
    contextBridge.exposeInMainWorld('new_window', new_window)
  })
