const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ENGINE_DIR = path.join(__dirname, 'engine');
const TARGET_EXE = path.join(ENGINE_DIR, 'stockfish.exe');

async function setup() {
    if (fs.existsSync(TARGET_EXE)) {
        console.log('✅ Stockfish binary already exists at:', TARGET_EXE);
        return;
    }

    if (!fs.existsSync(ENGINE_DIR)) {
        fs.mkdirSync(ENGINE_DIR, { recursive: true });
    }

    const zipUrl = 'https://github.com/official-stockfish/Stockfish/releases/download/sf_17/stockfish-windows-x86-64-sse41-popcnt.zip';
    const tempZip = path.join(ENGINE_DIR, 'stockfish.zip');

    console.log('Downloading Stockfish 17 (SSE4.1/POPCNT optimized for Intel i5-2400S)...');
    console.log('Source:', zipUrl);

    // Fast download with curl
    execSync(`curl.exe -L -o "${tempZip}" "${zipUrl}"`, { stdio: 'inherit' });

    console.log('Extracting archive...');
    execSync(`tar.exe -xf "${tempZip}" -C "${ENGINE_DIR}"`, { stdio: 'inherit' });

    // Find the extracted .exe inside any nested subfolder
    function findExe(dir) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                const found = findExe(fullPath);
                if (found) return found;
            } else if (file.endsWith('.exe') && file.toLowerCase().includes('stockfish')) {
                return fullPath;
            }
        }
        return null;
    }

    const foundExe = findExe(ENGINE_DIR);
    if (!foundExe) {
        throw new Error('Could not find extracted stockfish.exe in ' + ENGINE_DIR);
    }

    if (path.resolve(foundExe) !== path.resolve(TARGET_EXE)) {
        fs.copyFileSync(foundExe, TARGET_EXE);
    }

    // Clean up zip
    if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip);

    console.log('✅ Stockfish 17 successfully installed to:', TARGET_EXE);

    // Verify it runs
    const testOut = execSync(`"${TARGET_EXE}" uci`, { encoding: 'utf8', timeout: 5000 });
    if (testOut.includes('Stockfish') && testOut.includes('uciok')) {
        console.log('✅ Stockfish 17 verified and working perfectly on your CPU!');
    } else {
        console.warn('⚠️ Warning: Stockfish started but did not return uciok. Output:', testOut.slice(0, 100));
    }
}

setup().catch(err => {
    console.error('❌ Setup failed:', err);
    process.exit(1);
});
