// renderer.js (or in the script tag of your HTML)
const srcButton = document.getElementById('select-src-btn');
const destButton = document.getElementById('select-destination-btn');
const folderDisplay = document.getElementById('selected-src-folder');
const destDisplay = document.getElementById('selected-dest-folder');
const nextButton = document.getElementById('next-btn');

let sourcePath = '';
let destinationPath = '';

srcButton.addEventListener('click', async () => {
    const folderPath = await window.electron.selectFolder();
    sourcePath = folderPath;
    console.log(folderPath);
    folderDisplay.textContent = folderPath || 'No folder selected';
    enableNextButton();
});

destButton.addEventListener('click', async () => {
    const folderPath = await window.electron.selectFolder();
    destinationPath = folderPath;
    destDisplay.textContent = folderPath || 'No folder selected';
    enableNextButton();
});

nextButton.addEventListener('click', async () => {
    const modules = await window.electron.getModules(sourcePath);
    if (!modules.error) {
        if (sourcePath && destinationPath) {
            window.electron.setPaths({ source: sourcePath, destination: destinationPath });
            window.electron.openModuleSelection(modules);
        } else {
            alert('Please select both source and destination paths.');
        }
    } else {
        alert(modules.error);
    }
});

function enableNextButton() {
    nextButton.disabled = !(sourcePath && destinationPath);
}
