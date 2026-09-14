const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 3333;
const HOST = '127.0.0.1';
const ENGINE_PATH = path.join(__dirname, 'engine', 'stockfish.exe');

if (!fs.existsSync(ENGINE_PATH)) {
    console.error(`Error: Stockfish binary not found at ${ENGINE_PATH}`);
    console.error('Please run: node setup-stockfish.js first!');
    process.exit(1);
}

console.log(`[Stockfish 17] Starting native engine: ${ENGINE_PATH}...`);
const sf = spawn(ENGINE_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });

let isReady = false;
let currentJob = null; // { fen, moves, startFen, searchmoves, depth, key, callbacks: [], t0, lastEval, lastMate, timeoutId }
let pendingJob = null; // { fen, moves, startFen, searchmoves, depth, key, callbacks: [], t0 }

function startSearch(job) {
    currentJob = job;
    currentJob.lastEval = 0;
    currentJob.lastMate = null;

    // Safety timeout: abort search if it hangs longer than 20 seconds
    currentJob.timeoutId = setTimeout(() => {
        if (currentJob === job) {
            console.warn(`[Stockfish 17] Search exceeded 20s, forcing stop`);
            sf.stdin.write('stop\n');
        }
    }, 20000);

    if (job.moves && job.moves.trim()) {
        const startPosCmd = (job.startFen && job.startFen !== 'startpos')
            ? `position fen ${job.startFen} moves ${job.moves.trim()}`
            : `position startpos moves ${job.moves.trim()}`;
        sf.stdin.write(`${startPosCmd}\n`);
    } else {
        sf.stdin.write(`position fen ${job.fen}\n`);
    }

    if (job.searchmoves && job.searchmoves.trim()) {
        sf.stdin.write(`go depth ${job.depth} searchmoves ${job.searchmoves.trim()}\n`);
    } else {
        sf.stdin.write(`go depth ${job.depth}\n`);
    }
}

sf.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (let raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line === 'uciok') {
            sf.stdin.write('setoption name Threads value 4\n');
            sf.stdin.write('setoption name Hash value 128\n');
            sf.stdin.write('setoption name MultiPV value 1\n');
            sf.stdin.write('setoption name Skill Level value 20\n');
            sf.stdin.write('setoption name Move Overhead value 10\n');
            sf.stdin.write('isready\n');
        } else if (line === 'readyok') {
            isReady = true;
            console.log('Stockfish 17 ready (4 threads, 128MB hash, MultiPV 1, Skill Level 20)');
            console.log(`   Listening on http://${HOST}:${PORT}`);
        } else if (line.startsWith('info ') && line.includes('score ')) {
            if (currentJob) {
                const cpMatch = line.match(/score cp (-?\d+)/);
                const mateMatch = line.match(/score mate (-?\d+)/);
                if (cpMatch) currentJob.lastEval = parseInt(cpMatch[1], 10) / 100;
                if (mateMatch) currentJob.lastMate = parseInt(mateMatch[1], 10);
            }
        } else if (line.startsWith('bestmove ')) {
            const parts = line.split(/\s+/);
            const move = parts[1];

            if (currentJob) {
                if (currentJob.timeoutId) clearTimeout(currentJob.timeoutId);
                const dur = Date.now() - currentJob.t0;
                console.log(`[Stockfish 17] Move: ${move} | Depth: ${currentJob.depth} | ${dur}ms`);

                const payload = JSON.stringify({
                    success: move && move !== '(none)',
                    move: move && move !== '(none)' ? move : null,
                    bestmove: `bestmove ${move}`,
                    evaluation: currentJob.lastEval,
                    mate: currentJob.lastMate,
                    depth: currentJob.depth,
                    durationMs: dur
                });

                for (const cb of currentJob.callbacks) {
                    try { cb(payload); } catch (_) { }
                }
                currentJob = null;
            }

            // If a newer search was queued while this one finished, launch it immediately
            if (pendingJob) {
                const next = pendingJob;
                pendingJob = null;
                startSearch(next);
            }
        }
    }
});

sf.stderr.on('data', (chunk) => {
    console.error('[Stockfish stderr]:', chunk.toString());
});

sf.on('close', (code) => {
    console.log(`[Stockfish] Process exited with code ${code}`);
    process.exit(code || 0);
});

// Initialize UCI protocol
sf.stdin.write('uci\n');

// HTTP Bridge Server
const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const reqUrl = new URL(req.url, `http://${HOST}:${PORT}`);

    // Health
    if (reqUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            ready: isReady,
            engine: 'Stockfish 17',
            threads: 4,
            hash: 128,
            multiPV: 1,
            activeJob: !!currentJob
        }));
        return;
    }

    // New Game (reset hash table)
    if (reqUrl.pathname === '/newgame') {
        if (currentJob) {
            if (currentJob.timeoutId) clearTimeout(currentJob.timeoutId);
            sf.stdin.write('stop\n');
            currentJob = null;
        }
        pendingJob = null;
        sf.stdin.write('ucinewgame\n');
        sf.stdin.write('isready\n');
        console.log('[Stockfish 17] New game - hash table reset');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Stockfish 17 reset for new game' }));
        return;
    }

    // Best Move
    if (reqUrl.pathname === '/bestmove') {
        const fen = reqUrl.searchParams.get('fen');
        const moves = reqUrl.searchParams.get('moves');
        const startFen = reqUrl.searchParams.get('startFen');
        const searchmoves = reqUrl.searchParams.get('searchmoves');
        const depth = parseInt(reqUrl.searchParams.get('depth'), 10) || 18;

        if (!fen && !moves) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing fen or moves parameter' }));
            return;
        }

        if (!isReady) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Stockfish 17 initializing...' }));
            return;
        }

        const sendReply = (payload) => {
            if (!res.writableEnded) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(payload);
            }
        };

        const jobKey = `${fen || ''}_${moves || ''}_${searchmoves || ''}`;

        // If currently searching
        if (currentJob) {
            if (currentJob.key === jobKey) {
                // Same position requested again (duplicate query)
                currentJob.callbacks.push(sendReply);
                return;
            } else {
                // Board position or search constraints changed! Preempt old search with new one immediately
                pendingJob = { fen, moves, startFen, searchmoves, depth, key: jobKey, callbacks: [sendReply], t0: Date.now() };
                sf.stdin.write('stop\n');
                return;
            }
        }

        // Idle — start search immediately
        startSearch({ fen, moves, startFen, searchmoves, depth, key: jobKey, callbacks: [sendReply], t0: Date.now() });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
    console.log(`Stockfish 17 Server running on http://${HOST}:${PORT}`);
    console.log(`   Endpoints: /bestmove?fen=...&depth=18 | /newgame | /health`);
});
