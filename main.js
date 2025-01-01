const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const { exec, spawn } = require('child_process');
const extract = require('extract-zip'); // In case you're dealing with zip files.

let runningProcess = null;

let mainWindow, moduleSelectionWindow;
let sourcePath, destinationPath;

let isBuilding = false;

const gitBashPath = 'C:\\Program Files\\Git\\bin\\bash.exe'; // Adjust the path if Git is installed elsewhere
const timeoutMs = 60 * 60 * 1000 // 1 hour timeout;


// Create the main window
const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), // Path to preload.js
            contextIsolation: true, // Prevent direct access to Node.js from renderer
            nodeIntegration: false, // Disable Node.js integration for security
        }
    });

    mainWindow.loadFile('index.html');
}

// Handle selecting a folder (called from renderer process)
ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
    });

    return result.filePaths[0]; // Return the selected folder path
});

// Store paths received from the first window
ipcMain.on('set-paths', (event, { source, destination }) => {
    sourcePath = source;
    destinationPath = destination;
});

// Get paths when requested by the second window
ipcMain.handle('get-paths', () => {
    return { sourcePath, destinationPath };
});

// Read modules from the source folder
ipcMain.handle('get-modules', async (event, sourcePath) => {
    try {
        const modules = {};
        const topFolders = fs.readdirSync(sourcePath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        // Read packages in each top-level folder
        for (const folder of topFolders) {
            const packagesPath = path.join(sourcePath, folder, 'packages');
            if (fs.existsSync(packagesPath)) {
                const subModules = fs.readdirSync(packagesPath, { withFileTypes: true })
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => entry.name);
                modules[folder] = subModules;
            }
        }

        return modules;
    } catch (error) {
        console.error('Error reading modules:', error);
        return { error: 'Failed to read modules. Make sure the source path is valid.' };
    }
});

// Open module selection window after modules are loaded
ipcMain.on('open-module-selection', (event, modules) => {
    moduleSelectionWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), // Path to preload.js
            contextIsolation: true, // Prevent access to Node.js from renderer
        },
    });

    moduleSelectionWindow.loadFile('module-selector.html');
    moduleSelectionWindow.webContents.once('did-finish-load', () => {
        moduleSelectionWindow.webContents.send('load-modules', modules); // Send modules data to the renderer
    });
});
// handle the halt build command
ipcMain.handle('halt-build', async (event) => {
    stopCommand();
    return { success: true };
});

// Handle the extraction of selected modules
ipcMain.handle('start-build', async (event, { selectedModulesObj }) => {
    try {
        isBuilding = true;
        // Define the default folders that are always extracted
        const alwaysExtract = ['call-center-custom', 'lib', "container-build"];
        // get the keys from the selectedModulesObj
        const selectedModules = Object.keys(selectedModulesObj)
        console.log("Selected modules:", JSON.stringify(selectedModulesObj));
        // Combine the alwaysExtract folders with the selected modules
        const foldersToExtract = [...new Set([...alwaysExtract, ...selectedModules])];

        // Extract the tar file based on the selected folders
        await extractTar(sourcePath, destinationPath, foldersToExtract);
        // // we need to copy the respective sub folders src/custom to destinationPath/src/custom
        copySubModules(sourcePath, destinationPath, selectedModulesObj);
        await copyBuildAssetsForModules(sourcePath, destinationPath, selectedModulesObj);
        copyCustomModule(sourcePath, destinationPath, selectedModulesObj);

        const baseBuildPath = path.join(destinationPath, 'extracted');
        console.log("Base build path:", baseBuildPath);
        await runBuildCommandsForCustomFolder(baseBuildPath, "call-center-custom", gitBashPath, timeoutMs, event);
        await runBuildScript(baseBuildPath, selectedModules, event);
        return { success: true };
    } catch (error) {
        console.error('Error extracting modules:', error);
        return { success: false, error: error.message };
    }
});

runBuildScript = async (baseBuildPath, selectedModules, ipcMainEvent) => {
    console.log(`Running build script for ${selectedModules}`);
    let moduleName = 'container-build';
    try {
        // run the build script for each selected module
        const containerBuildPath = path.join(baseBuildPath, moduleName);
        await runCommand(
            './build-customization.sh build-ui',
            [...selectedModules],
            {
                cwd: containerBuildPath,
                shell: gitBashPath,
                timeout: timeoutMs,
            },
            moduleName,
            ipcMainEvent // Pass the ipcMainEvent to emit progress updates
        );

        // Run `build package` for each selected module
        await runCommand(
            './build-customization.sh package-jar',
            [...selectedModules],
            {
                cwd: containerBuildPath,
                shell: gitBashPath,
                timeout: timeoutMs,
            },
            moduleName,
            ipcMainEvent // Pass the ipcMainEvent to emit progress updates
        );

        console.log(`Successfully built extensions in ${moduleName}`);

    } catch (error) {
        console.error(`Error while running commands for ${moduleName}:`, error.message);

        if (ipcMainEvent) {
            ipcMainEvent.sender.send('update-progress', {
                moduleName,
                message: `Error while running commands: ${error.message}`,
            });
        }
    }
};

const copyCustomModule = (sourcePath, destinationPath, selectedModulesObj) => {
    const customModulePath = path.join(sourcePath, '/call-center-custom/libs/cc-components/src');
    const customModuleDestinationPath = path.join(destinationPath, '/extracted/call-center-custom/libs/cc-components/src');
    copyFolderWithPath(customModulePath, customModuleDestinationPath);
    console.log("Copied custom modules successfully!");
}

const copyBuildAssetsForModules = async (sourcePath, destinationPath, selectedModulesObj) => {
    // Build assets are in the root of each module
    for (const module of Object.keys(selectedModulesObj)) {
        const modulePath = path.join(sourcePath, module);
        const moduleDestinationPath = path.join(destinationPath, '/extracted', module);

        const angularJsonPath = path.join(modulePath, 'angular.json');
        const packageJsonPath = path.join(modulePath, 'package.json');
        const packageCustomizationPath = path.join(moduleDestinationPath, 'package-customization.json');

        // Copy the angular.json file
        fs.copyFileSync(angularJsonPath, path.join(moduleDestinationPath, 'angular.json'));
        fs.copyFileSync(packageJsonPath, path.join(moduleDestinationPath, 'package.json'));
        // we need to modify the contents of package-customization.json, dynamically based on 
        // selected subModules
        const packageCustomizationJson = JSON.parse(fs.readFileSync(packageCustomizationPath));
        const subModules = selectedModulesObj[module];
        // set the routes.json to blank object
        packageCustomizationJson.routes = {};
        // Add the routes for the selected submodules
        // route needs to have entries like this "create-order": {"type": "code"},
        for (const subModule of subModules) {
            packageCustomizationJson.routes[subModule] = { "type": "code" };
        }
        // Write the modified JSON back to the file
        fs.writeFileSync(packageCustomizationPath, JSON.stringify(packageCustomizationJson, null, 2));
        // Copy the package-customization.json file
        fs.copyFileSync(packageCustomizationPath, path.join(moduleDestinationPath, 'package-customization.json'));

    }

    console.log("Copied build assets successfully!");
}

const copySubModules = (sourcePath, destinationPath, selectedModulesObj) => {

    for (const module of Object.keys(selectedModulesObj)) {
        const subModules = selectedModulesObj[module];
        for (const subModule of subModules) {
            const source = path.join(sourcePath, `${module}/packages/`, subModule, 'src-custom');
            const destination = path.join(destinationPath, `/extracted/${module}/packages`, subModule, 'src-custom');
            copyFolderWithPath(source, destination);
        }
    }

    // we need to copy always the sub folder ending with root-config and shared
    for (const module of Object.keys(selectedModulesObj)) {
        const source = path.join(sourcePath, `${module}/packages/`);
        const destination = path.join(destinationPath, `/extracted/${module}/packages`);
        const subModules = fs.readdirSync(source, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        for (const subModule of subModules) {
            if (subModule.endsWith('root-config') || subModule.endsWith('shared')) {
                const source = path.join(sourcePath, `${module}/packages/`, subModule);
                const destination = path.join(destinationPath, `/extracted/${module}/packages`, subModule);
                copyFolderWithPath(source, destination);
            }
        }
    }

    console.log("Copied sub modules successfully!");
}

const copyFolderWithPath = (source, destination) => {
    // Ensure the destination folder exists
    if (!fs.existsSync(destination)) {
        fs.mkdirSync(destination, { recursive: true });
    }

    // Get the contents of the source folder
    const items = fs.readdirSync(source);

    // Iterate over each item in the source folder
    items.forEach((item) => {
        const sourcePath = path.join(source, item);
        const destPath = path.join(destination, item);

        // Check if the item is a directory or a file
        if (fs.statSync(sourcePath).isDirectory()) {
            // If it's a directory, copy recursively
            copyFolderWithPath(sourcePath, destPath);
        } else {
            // If it's a file, copy it
            fs.copyFileSync(sourcePath, destPath);
        }
    });
};

const extractTar = (sourceTar, destinationPath, foldersToExtract) => {
    return new Promise((resolve, reject) => {
        console.log('Source TAR:', sourceTar);
        console.log('Destination Path:', destinationPath);
        console.log('Folders to Extract:', foldersToExtract);

        if (!foldersToExtract || foldersToExtract.length === 0) {
            console.error('Error: No folders to extract!');
            reject(new Error('No folders to extract'));
            return;
        }

        sourceTar = path.join(sourceTar, 'source.tar');
        destinationPath = path.join(destinationPath, 'extracted'); // Create a subfolder for extracted files

        // If the destination path exists, clear it out while keeping node_modules folders
        if (fs.existsSync(destinationPath)) {
            const modules = fs.readdirSync(destinationPath);


            modules.forEach((subfolder) => {
                if (foldersToExtract.includes(subfolder)) {
                    const modulePath = path.join(destinationPath, subfolder);
                    console.log(`Checking: ${modulePath}`);

                    const subFoldersInModule = fs.readdirSync(modulePath);
                    subFoldersInModule.forEach((directories) => {
                        const dirPath = path.join(destinationPath, subfolder, directories);
                        if (fs.statSync(dirPath).isDirectory()) {
                            console.log("sub folder in module " + dirPath)
                            if (dirPath.endsWith('node_modules')) {
                                console.log(`Preserving: ${dirPath}`);
                            } else {
                                // Recursively remove other folders except node_modules
                                fs.rmSync(dirPath, { recursive: true, force: true });
                                console.log(`Removed folder: ${dirPath}`);
                            }
                        } else {
                            // Remove files directly under the destinationPath
                            fs.rmSync(dirPath, { force: true });
                            console.log(`Removed file: ${dirPath}`);
                        }
                    });
                }else{
                    const modulePath = path.join(destinationPath, subfolder);
                    console.log(`Checking: ${modulePath}`);
                    fs.rmSync(modulePath, { recursive: true, force: true });
                    console.log(`Removed folder: ${modulePath}`);
                }

            });
        } else {
            fs.mkdirSync(destinationPath); // Create the destination folder if it doesn't exist
        }

        // Extract only the folders we need from the tar file
        tar.x({
            file: sourceTar,
            cwd: destinationPath,
            filter: (pathInsideTar) => {
                const normalizedPath = pathInsideTar.replace(/\\/g, '/');
                const folderName = normalizedPath.split('/')[0]; // Get the root folder name
                return foldersToExtract.includes(folderName); // Check if the folder is in foldersToExtract
            }
        })
            .then(() => {
                console.log('Extraction complete.');
                resolve();
            })
            .catch((error) => {
                console.error('Error during extraction:', error);
                reject(error);
            });
    });
};

async function runBuildCommandsForCustomFolder(modulePath, moduleName, gitBashPath, timeoutMs, ipcMainEvent) {
    console.log(`Running prod build for ${moduleName} and creating a symlink`);
    const moduleDirectory = path.join(modulePath, moduleName);

    try {
        // Run `yarn install`
        await runCommand(
            'yarn',
            ['install'],
            {
                cwd: moduleDirectory,
                shell: gitBashPath,
                timeout: timeoutMs,
            },
            moduleName,
            ipcMainEvent // Pass the ipcMainEvent to emit progress updates
        );

        // Run `yarn cc-components:prod`
        await runCommand(
            'yarn',
            ['cc-components:prod'],
            {
                cwd: moduleDirectory,
                shell: gitBashPath,
                timeout: timeoutMs,
            },
            moduleName,
            ipcMainEvent // Pass the ipcMainEvent to emit progress updates
        );
        // cd into dist/libs/cc-components and run yarn unlink and yarn link
        const ccComponentsPath = path.join(moduleDirectory, 'dist','libs','cc-components');
        console.log("Custom components path:", ccComponentsPath);
        await runCommand(
            'yarn',
            ['unlink'],
            {
                cwd: ccComponentsPath,
                shell: gitBashPath,
                timeout: timeoutMs,
            },
            moduleName,
            ipcMainEvent // Pass the ipcMainEvent to emit progress updates
        );

        await runCommand(
            'yarn',
            ['link'],
            {
                cwd: ccComponentsPath,
                shell: gitBashPath,
                timeout: timeoutMs,
            },
            moduleName,
            ipcMainEvent // Pass the ipcMainEvent to emit progress updates
        );

        console.log(`Successfully created a symlink for ${moduleName}`);

    } catch (error) {
        console.error(`Error while running commands for ${moduleName}:`, error.message);

        if (ipcMainEvent) {
            ipcMainEvent.sender.send('update-progress', {
                moduleName,
                message: `Error while running commands: ${error.message}`,
            });
        }
    }
}

function runCommand(command, args, options, moduleName, ipcMainEvent) {
    return new Promise((resolve, reject) => {
        runningProcess = spawn(command, args, options);

        let progressMessage = `[${moduleName}] Running: ${command} ${args.join(' ')}`;
        // console.log(progressMessage);

        // Emit initial progress update
        if (ipcMainEvent) {
            ipcMainEvent.sender.send('update-progress', { moduleName, message: progressMessage });
        }

        runningProcess.stdout.on('data', (data) => {
            const output = data.toString();
            progressMessage = `[${moduleName}] ${output}`;
            // console.log(progressMessage);

            // Emit progress update
            if (ipcMainEvent) {
                ipcMainEvent.sender.send('update-progress', { moduleName, message: progressMessage });
            }
        });

        runningProcess.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            progressMessage = `[${moduleName} ERROR] ${errorOutput}`;
            // console.error(progressMessage);

            // Emit error progress update
            if (ipcMainEvent) {
                ipcMainEvent.sender.send('update-progress', { moduleName, message: progressMessage });
            }
        });

        runningProcess.on('close', (code) => {
            if (code === 0) {
                progressMessage = `[${moduleName}] Command completed successfully.`;
                console.log(progressMessage);

                // Emit completion progress update
                if (ipcMainEvent) {
                    ipcMainEvent.sender.send('update-progress', { moduleName, message: progressMessage });
                }
                resolve();
            } else {
                const errorMessage = `[${moduleName}] Command failed with code: ${code}`;
                console.error(errorMessage);

                // if command is yarn unlink, we can ignore the error
                if (command === 'yarn' && args[0] === 'unlink') {
                    console.log("Ignoring the error for yarn unlink");
                    resolve();
                }
                // Emit failure progress update
                if (ipcMainEvent) {
                    ipcMainEvent.sender.send('update-progress', { moduleName, message: errorMessage });
                }
                reject(new Error(errorMessage));
            }
        });
    });
}


const stopCommand = () => {
    if (runningProcess) {
        console.log('Stopping the command...');
        runningProcess.kill('SIGINT'); // Sends the default SIGTERM signal
        runningProcess = null; // Clear the reference
    } else {
        console.log('No running process to stop.');
    }
};

// Start the app when ready
app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Quit app when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
