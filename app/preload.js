
function createElectronPort() {
    const SerialPort = require('electron').remote.require('serialport');
    let serialport = (port, baudRate, onOpen, onData, onClose, onError) => {
        return new Promise((resolve, reject) => {
            let serial = new SerialPort(port, { baudRate, autoOpen: true }, (err) => {
                if (err) {
                    reject(err);
                } else {
                    onOpen();
                    resolve({
                        write: (data) => {
                            serial.write(data);
                        },
                        reset: () => {
                            return new Promise((r, j) => {
                                serial.set({ dtr: false });
                                setTimeout(() => serial.set({ dtr: true }), 10);
                                setTimeout(() => {
                                    serial.set({ dtr: false });
                                    r();
                                }, 10);
                            })
                        },
                        close: () => {
                            return new Promise((r, j) => {
                                serial.close((e) => {
                                    e ? j(e) : r();
                                });
                            })
                        }
                    })
                }
            })
            serial.on("error", (e) => {
                if (onError) onError(e);
            });
            serial.on("data", (d) => {
                onData(d);
            });
            serial.on("close", (e) => {
                onClose();
            });
        })
    }
    const { ipcRenderer } = require('electron');
    let listports = () => {
        let mdns = new Promise(r => {
            ipcRenderer.once('mdns', (event, ps) => r(ps.map(p => ({
                type: 'ws',
                value: p.ip,
                name: p.hostName
            }))));
            ipcRenderer.send('mdns');
        })
        let splist = SerialPort.list().then(ps => ps.map(p => ({
            type: 'serial',
            value: p.path,
        })));
        return Promise.all([mdns, splist]).then(([mps, sps]) => mps.concat(sps))
    };

    let arduinoPath = null;
    const fs = require("fs");
    const path = require("path");
    let isArduinoPath = (dir) => {
        let ps = [
            dir,
            path.join(dir, "Contents", "Java")
        ].map(p => [path.join(p, "hardware", "tools", "avr", "bin", "avrdude"), path.join(p, 'arduino-builder')]);

        ps = ps.concat(ps.map(p => p.map(s => s + '.exe')));

        for (let p of ps) {
            if (fs.existsSync(p[0]) && fs.existsSync(p[1])) {
                arduinoPath = {
                    path: dir,
                    builder: p[1],
                    uploader: p[0]
                }
                return true;
            }
        }
        return false;
    }

    const { dialog, app } = require("electron").remote;
    let curPath = path.resolve(app.getPath("exe"));
    curPath = path.dirname(curPath);
    let dirset = [curPath];
    while (dirset.length) {
        let dir = dirset.pop();
        let files = fs.readdirSync(dir);
        for (let f of files) {
            let fp = path.join(dir, f);
            let st = fs.statSync(fp);
            if (st.isDirectory(fp)) {
                if (f.toLowerCase().indexOf('arduino') >= 0) {
                    if (isArduinoPath(fp)) return;
                }
                dirset.push(fp);
            }
        }
    }

    let doCompile = (code, callback) => {
        return new Promise((resolve, reject) => {
            if (!code || !code.trim()) {
                callback('error', 'empty code')
                return reject('empty code');;
            }
            if (!arduinoPath) {
                let file = dialog.showOpenDialogSync({
                    title: 'arduinoPath',
                    properties: ["openFile"],
                    filters: [{
                        extensions: ['', 'exe'],
                        name: 'arduino-builder'
                    }]
                });
                if (file) {
                    isArduinoPath(path.dirname(file[0]));
                }
            }
            if (!arduinoPath) {
                callback('error', 'compiler not found');
                return reject('compiler not found');
            }
            try {
                let curPath = path.resolve(app.getPath("exe"));
                curPath = path.dirname(curPath);
                let cachedir = path.join(curPath, 'build', 'cache');
                let sketchdir = path.join(curPath, 'build', 'sketch');
                [
                    cachedir,
                    sketchdir
                ].forEach(p => {
                    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
                })
                fs.writeFileSync(path.join(sketchdir, "sketch.ino"), code);
                callback('message', 'compiling');
                const spawn = require("child_process").spawn;
                const genhex = spawn(arduinoPath.builder,
                    [
                        `-hardware "${path.join(arduinoPath.path, "/hardware")}"`,
                        `-tools "${path.join(arduinoPath.path, "/hardware/tools/avr")}"`,
                        `-tools "${path.join(arduinoPath.path, "/tools-builder")}"`,
                        `-libraries "${path.join(arduinoPath.path, "/libraries")}"`,
                        "-fqbn arduino:avr:uno",
                        `-build-path "${cachedir}"`,
                        `"${path.join(sketchdir, "sketch.ino")}"`
                    ], { shell: true });
                genhex.stdout.on("data", (data) => {
                    callback('stdout', data.toString());
                });
                genhex.stderr.on("data", (data) => {
                    callback('stderr', data.toString());
                });
                genhex.on("close", (exitcode) => {
                    if (exitcode == 0) {
                        let hexfile = path.join(cachedir, 'sketch.ino.hex');
                        resolve(hexfile);
                    } else {
                        callback('error', 'exit code:' + exitcode);
                        return reject('exit code:' + exitcode);
                    }
                });
            } catch (e) {
                callback('error', e);
                return reject(e);
            }
        })
    }
    let compiler = (code, callback) => {
        callback('start', 'verify');
        return doCompile(code, callback).then(f => { callback('done'); return fs.readFileSync(f).toString(); })
    }

    let doUpload = (hexfile, port, callback, rate) => {
        return new Promise((resolve, reject) => {
            try {
                callback('message', 'uploading');
                const spawn = require("child_process").spawn;
                const up = spawn(arduinoPath.uploader, [
                    `-C "${path.join(arduinoPath.path, "/hardware/tools/avr/etc/avrdude.conf")}"`,
                    "-patmega328p -carduino -D",
                    `-Uflash:w:"${hexfile}":i`,
                    `-P "${port}"`,
                    `-b${rate}`,
                    " -q"],
                    { shell: true });
                up.stdout.on("data", (data) => {
                    callback('stdout', data.toString());
                });
                up.stderr.on("data", (data) => {
                    callback('stderr', data.toString());
                });

                up.on("close", (exitcode) => {
                    if (exitcode == 0) {
                        callback('done');
                        return resolve();
                    } else {
                        callback('error', 'exit code:' + exitcode);
                        return reject('exit code:' + exitcode);
                    }
                });
            } catch (e) {
                callback('error', e);
                return reject(e);
            }
        })
    }


    let uploader = (code, port, callback, rate = 115200) => {
        callback('start', 'compiling');
        return doCompile(code, callback).then(hexfile => doUpload(hexfile, port, callback, rate));
    }

    return {
        SerialPort: serialport,
        ListPorts: listports,
        compiler,
        uploader
    }
}

window.electronPort = createElectronPort();
