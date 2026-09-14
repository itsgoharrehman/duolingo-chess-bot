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

// ══════════════════════════════════════════════════════════════════════════════
//  REQUEST QUEUE — Prevents race conditions by serializing Stockfish access
// ══════════════════════════════════════════════════════════════════════════════
const requestQueue = [];
let isProcessing = false;

function enqueueRequest(fen, depth, multipv, callback) {
    requestQueue.push({ fen, depth, multipv, callback });
    processQueue();
}

function processQueue() {
    if (isProcessing || requestQueue.length === 0) return;
    isProcessing = true;
    const { fen, depth, multipv, callback } = requestQueue.shift();
    executeStockfish(fen, depth, multipv, (result) => {
        callback(result);
        isProcessing = false;
        // Process next request in queue
        if (requestQueue.length > 0) {
            setImmediate(processQueue);
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
//  STOCKFISH UCI COMMUNICATION — Collects MultiPV lines
// ══════════════════════════════════════════════════════════════════════════════
let currentResolve = null;
let collectedPVs = [];  // Array of { pv: number, move: string, eval: number, mate: number|null }
let currentMultiPV = 1;

sf.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        if (line === 'uciok') {
            sf.stdin.write('setoption name Threads value 4\n');
            sf.stdin.write('setoption name Hash value 128\n');
            sf.stdin.write('isready\n');
        } else if (line === 'readyok') {
            isReady = true;
            console.log('✅ Stockfish 17 GOD MODE ready (4 threads, 128MB hash)');
            console.log('   Listening on http://' + HOST + ':' + PORT);
        } else if (line.startsWith('info ') && line.includes('score ') && line.includes(' pv ')) {
            // Parse MultiPV info lines
            const pvMatch = line.match(/multipv (\d+)/);
            const pvNum = pvMatch ? parseInt(pvMatch[1], 10) : 1;
            const cpMatch = line.match(/score cp (-?\d+)/);
            const mateMatch = line.match(/score mate (-?\d+)/);
            const pvMoves = line.match(/ pv (.+)/);

            if (pvMoves) {
                const firstMove = pvMoves[1].split(/\s+/)[0];
                const evalVal = cpMatch ? parseInt(cpMatch[1], 10) / 100 : 0;
                const mateVal = mateMatch ? parseInt(mateMatch[1], 10) : null;

                // Update or insert PV entry (keep latest for each pv number)
                const existing = collectedPVs.find(p => p.pv === pvNum);
                if (existing) {
                    existing.move = firstMove;
                    existing.eval = evalVal;
                    existing.mate = mateVal;
                } else {
                    collectedPVs.push({ pv: pvNum, move: firstMove, eval: evalVal, mate: mateVal });
                }
            }
        } else if (line.startsWith('bestmove ')) {
            const parts = line.split(/\s+/);
            const bestMove = parts[1];

            // Ensure bestmove is PV1 if not already collected
            if (collectedPVs.length === 0) {
                collectedPVs.push({ pv: 1, move: bestMove, eval: 0, mate: null });
            } else if (collectedPVs[0].move !== bestMove) {
                // bestmove overrides PV1
                collectedPVs[0].move = bestMove;
            }

            // Sort by PV number
            collectedPVs.sort((a, b) => a.pv - b.pv);

            if (currentResolve) {
                const result = {
                    moves: collectedPVs.map(p => ({
                        move: p.move,
                        eval: p.eval,
                        mate: p.mate
                    }))
                };
                currentResolve(result);
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

function executeStockfish(fen, depth, multipv, callback) {
    collectedPVs = [];
    currentResolve = callback;
    currentMultiPV = multipv;

    // Set MultiPV before each search (in case it changed)
    sf.stdin.write(`setoption name MultiPV value ${multipv}\n`);
    sf.stdin.write(`position fen ${fen}\n`);
    sf.stdin.write(`go depth ${depth}\n`);

    // Safety timeout — if Stockfish somehow hangs, don't block the queue forever
    setTimeout(() => {
        if (currentResolve === callback) {
            console.warn(`[Stockfish] Timeout on depth ${depth}, forcing response`);
            currentResolve = null;
            callback({ moves: collectedPVs.length > 0 ? collectedPVs.map(p => ({ move: p.move, eval: p.eval, mate: p.mate })) : [] });
        }
    }, 30000);  // 30s hard safety limit
}

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP BRIDGE SERVER
// ══════════════════════════════════════════════════════════════════════════════
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

    // ── Health Check ────────────────────────────────────────────────────────
    if (parsed.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            ready: isReady,
            engine: 'Stockfish 17 GOD MODE',
            threads: 4,
            hash: 128,
            port: PORT,
            queueLength: requestQueue.length
        }));
        return;
    }

    // ── New Game (reset engine state) ───────────────────────────────────────
    if (parsed.pathname === '/newgame') {
        sf.stdin.write('ucinewgame\n');
        sf.stdin.write('isready\n');
        console.log('[Stockfish] New game — hash table cleared');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Engine state reset for new game' }));
        return;
    }

    // ── Best Move (with MultiPV support) ────────────────────────────────────
    if (parsed.pathname === '/bestmove') {
        const fen = parsed.query.fen;
        const depth = parseInt(parsed.query.depth, 10) || 15;
        const multipv = Math.min(parseInt(parsed.query.multipv, 10) || 1, 5);

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

        enqueueRequest(fen, depth, multipv, (result) => {
            const dur = Date.now() - t0;
            const moves = result.moves || [];
            const best = moves[0] || { move: null, eval: 0, mate: null };

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: best.move !== null,
                bestmove: best.move ? `bestmove ${best.move}` : null,
                move: best.move,
                depth,
                evaluation: best.eval,
                mate: best.mate,
                durationMs: dur,
                // MultiPV: all candidate moves ranked by Stockfish
                candidates: moves.map((m, i) => ({
                    rank: i + 1,
                    move: m.move,
                    eval: m.eval,
                    mate: m.mate
                }))
            }));
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
    console.log(`🚀 Stockfish 17 GOD MODE Bridge Server on http://${HOST}:${PORT}`);
    console.log(`   Endpoints: /bestmove?fen=...&depth=15&multipv=3 | /newgame | /health`);
});
