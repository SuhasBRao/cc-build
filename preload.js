const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    getModules: (sourcePath) => ipcRenderer.invoke('get-modules', sourcePath),
    openModuleSelection: (modules) => ipcRenderer.send('open-module-selection', modules),
    openHomePage: () => ipcRenderer.send('open-home-page'),
    onLoadModules: (callback) => ipcRenderer.on('load-modules', (event, modules) => callback(modules)),
    // Add the method for extracting selected modules
    setPaths: ({ source, destination }) => ipcRenderer.send('set-paths', { source, destination }),
    getPaths: () => ipcRenderer.invoke('get-paths'),
    startBuild: (selectedModules) => ipcRenderer.invoke('start-build', selectedModules),
    haltBuild: () => ipcRenderer.invoke('halt-build'),
    on: (channel, callback) => {
        const validChannels = ['update-progress']; // Add all valid channels here
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, data) => callback(data));
        }
    },
});
