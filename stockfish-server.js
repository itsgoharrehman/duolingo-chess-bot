const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const url = require('url');
const fs = require('fs');

const PORT = 3333;
const HOST = '127.0.0.1';
const ENGINE_PATH = path.join(__dirname, 'engine', 'stockfish.exe');

if (!fs.existsSync(ENGINE_PATH)) {
    console.error(`❌ Error: Stockfish binary not found at ${ENGINE_PATH}`);
    console.error('Please run: node setup-stockfish.js first!');
    process.exit(1);
}

// Spawn persistent Stockfish process
console.log(`[Stockfish] Starting ${ENGINE_PATH}...`);
const sf = spawn(ENGINE_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });

let isReady = false;
let currentResolve = null;
let currentMoveData = { move: null, eval: 0, mate: null };

sf.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        if (line === 'uciok') {
            sf.stdin.write('setoption name Threads value 2\n');
            sf.stdin.write('setoption name Hash value 64\n');
            sf.stdin.write('isready\n');
        } else if (line === 'readyok') {
            isReady = true;
            console.log('✅ Stockfish Engine ready and waiting for moves on http://' + HOST + ':' + PORT);
        } else if (line.startsWith('info ') && line.includes('score ')) {
            const cpMatch = line.match(/score cp (-?\d+)/);
            if (cpMatch) currentMoveData.eval = parseInt(cpMatch[1], 10) / 100;
            const mateMatch = line.match(/score mate (-?\d+)/);
            if (mateMatch) currentMoveData.mate = parseInt(mateMatch[1], 10);
        } else if (line.startsWith('bestmove ')) {
            const parts = line.split(/\s+/);
            const mv = parts[1];
            currentMoveData.move = mv;
            if (currentResolve) {
                const res = { ...currentMoveData };
                currentResolve(res);
                currentResolve = null;
            }
        }
    }
});

sf.stderr.on('data', (chunk) => {
    console.error('[Stockfish stderr]:', chunk.toString());
});

sf.on('close', (code) => {
    console.log(`[Stockfish] Process exited with code ${code}`);
    process.exit(code);
});

// Initialize UCI protocol
sf.stdin.write('uci\n');

// HTTP Bridge Server
const server = http.createServer((req, res) => {
    // Enable CORS for userscript
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', ready: isReady, engine: 'Stockfish 17 Local', port: PORT }));
        return;
    }

    if (parsed.pathname === '/bestmove') {
        const fen = parsed.query.fen;
        const depth = parseInt(parsed.query.depth, 10) || 15;

        if (!fen) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing fen parameter' }));
            return;
        }

        if (!isReady) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Engine still initializing' }));
            return;
        }

        const t0 = Date.now();
        currentMoveData = { move: null, eval: 0, mate: null };

        currentResolve = (result) => {
            const dur = Date.now() - t0;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                bestmove: `bestmove ${result.move}`,
                move: result.move,
                depth,
                evaluation: result.eval,
                mate: result.mate,
                durationMs: dur
            }));
        };

        // Send UCI command to Stockfish
        sf.stdin.write(`position fen ${fen}\n`);
        sf.stdin.write(`go depth ${depth}\n`);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
    console.log(`🚀 Local Stockfish Bridge Server listening on http://${HOST}:${PORT}`);
});
