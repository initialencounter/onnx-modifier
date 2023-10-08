
// electron 模块可以用来控制应用的生命周期和创建原生浏览窗口
const { app, BrowserWindow, ipcMain, webContents, shell, Menu } = require('electron')
const { spawn } = require("node:child_process")
const { EventEmitter } = require('events')
var fs = require('fs')
const path = require('path')

class ElectronMsgHandelManager {
    constructor() {
        this.map_ipc = new Map()
    }

    handleMessage(event, path, msg_send) {
        let senderId = event.processId
        if (!this.map_ipc.has(senderId)) {
            this.map_ipc.set(senderId, new PythonIPC())
        }

        let python_ipc = this.map_ipc.get(senderId)
        return python_ipc.send(path, msg_send)
    }

    close() {
        for (const [key, ipc] of this.map_ipc) {
            ipc.send("/exit", "")
        }
    }
}

let handle_msg = new ElectronMsgHandelManager()

const createWindow = () => {
    // 创建浏览窗口
    const mainWindow = new BrowserWindow({
        width: 1450,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js')
        }
    })

    Menu.setApplicationMenu(null)

    // 加载 index.html
    mainWindow.loadFile('static/index.html')
}

// 这段程序将会在 Electron 结束初始化
// 和创建浏览器窗口的时候调用
// 部分 API 在 ready 事件触发后才能使用。
app.whenReady().then(() => {
    createWindow()

    app.on('activate', () => {
        // 在 macOS 系统内, 如果没有已开启的应用窗口
        // 点击托盘图标时通常会重新创建一个新窗口
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    ipcMain.handle('message', (event, path, msg_send) => {
        return handle_msg.handleMessage(event, path, msg_send)
    })

    ipcMain.handle('new_window', (event, path, msg_send) => {
        createWindow()
    })
})

// 除了 macOS 外，当所有窗口都被关闭的时候退出程序。 因此, 通常
// 对应用程序和它们的菜单栏来说应该时刻保持激活状态,
// 直到用户使用 Cmd + Q 明确退出
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
    handle_msg.close()
})


app.on('web-contents-created', (e, webContents) => {
    webContents.setWindowOpenHandler(({url})=>{
        shell.openExternal(url)
        return {action: 'deny'}
    })
})

// 在当前文件中你可以引入所有的主进程代码
// 也可以拆分成几个文件，然后用 require 导入。


class PythonIPC {
    constructor() {
        let python_path = path.join(__dirname, "..", "python", process.platform == "win32" ? "python.exe" : "bin/python")
        python_path = fs.existsSync(python_path) ? python_path : "python"
        let app_path = path.join(__dirname, "..", "server.py")
        console.debug(python_path,  [app_path, ...process.argv].join(" "))
        this.process = spawn(python_path, [app_path, ...process.argv])
        this.msg_event = new EventEmitter()
        this.req_index = 9
        this.process_exit_code = null

        this.process.stdout.on("data", (data_text) => {
            data_text = data_text.toString()
            console.debug(`${data_text}`)
            let data_array = data_text.split(/\r?\n/)
            if (data_array.length < 6) {
                return
            }
            data_array = data_array.slice(-6)

            if (data_array[0] == "" && data_array[1] == "" && data_array[2] == ">>" && data_array[4] == "" && data_array[5] == "") {
                let data = decodeURIComponent(data_array[3])
                console.debug("recv", `${data}`)
                let { msg, status, file, req_ind } = JSON.parse(data)
                this.msg_event_emit(req_ind, msg, status, file)
            }
        })

        this.process.stderr.on("data", (data_text) => {
            data_text = data_text.toString()
            console.error(`${data_text}`)
        })

        this.process.on("close", (code) => {
            this.process_exit_code = code
            this.msg_event_emit_exit_event()
        })
    }

    get req_ind() {
        if (this.req_index == 999999) {
            this.req_index = 9
        }
        return this.req_index++
    }

    msg_event_emit(req_ind, msg, status, file) {
        if (req_ind > 0) {
            this.msg_event.emit(`server-msg-${req_ind}`, msg, status, file)
        } else {
            for (const event_name of this.msg_event.eventNames()) {
                this.msg_event.emit(event_name, msg, status, file)
            }
        }
    }

    msg_event_emit_exit_event() {
        this.msg_event_emit(0,
            `The service has been shut down abnormally with error code: ${this.process_exit_code}.`,
            500, null)
    }

    send(path, msg_send) {
        console.log(this.process.pid)
        return new Promise((resolve) => {
            const req_ind = this.req_ind
            this.msg_event.once(`server-msg-${req_ind}`, (msg, status, file) => {
                if (file) {
                    msg.filepath = file
                    file = fs.readFileSync(file)
                }
                resolve([status, msg, file])
            })
            if (this.process_exit_code !== null) {
                this.msg_event_emit_exit_event()
                return 
            }
            let send_obj_data = { path, msg: msg_send, req_ind}
            let send_obj_str = JSON.stringify(send_obj_data, null, 1)

            console.debug("send", `\n${send_obj_str}\n`)
            this.process.stdin.write(`${encodeURI(send_obj_str)}\n`)
            this.process.stdin.write(`\n\n`)
        })
    }
}