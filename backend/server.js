const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BLENDER_BIN = process.env.BLENDER_BIN || 'blender';
const BLENDER_SCRIPT = path.join(__dirname, 'blender_scene.py');
const TMP_DIR = '/tmp';
const AGY_BRAIN_DIR = '/root/.gemini/antigravity-cli/brain';
// Simple queue: one Blender job at a time
let blenderBusy = false;

// ─── Session Manager ─────────────────────────────────────────────────────────
// Maps short sessionId -> { conversationUUID, sseClients: [res, ...] }
const sessions = new Map();

// Periodically send keep-alive comment pings (every 15s) to all active clients of all sessions to prevent proxy/browser timeouts
setInterval(() => {
  for (const [sessionId, sess] of sessions.entries()) {
    if (sess.sseClients && sess.sseClients.length > 0) {
      sess.sseClients = sess.sseClients.filter(res => {
        try {
          res.write(': keepalive\n\n');
          return true;
        } catch (e) {
          return false;
        }
      });
    }
  }
}, 15000);

// Broadcast a log line to all SSE clients for a session
function sessionLog(sessionId, type, text) {
  console.log(`[session:${sessionId}] [${type}] ${text}`);
  const sess = sessions.get(sessionId);
  if (!sess) return;
  const data = JSON.stringify({ type, text, ts: Date.now() });
  sess.sseClients = sess.sseClients.filter(res => {
    try {
      res.write(`data: ${data}\n\n`);
      return true;
    } catch (e) {
      return false;
    }
  });
}

// Find the most recently created UUID directory in AGY_BRAIN_DIR that appeared after `afterMs`
function findNewestBrainDir(afterMs) {
  try {
    if (!fs.existsSync(AGY_BRAIN_DIR)) return null;
    const entries = fs.readdirSync(AGY_BRAIN_DIR)
      .filter(name => /^[0-9a-f-]{36}$/.test(name))
      .map(name => {
        const fullPath = path.join(AGY_BRAIN_DIR, name);
        try {
          const stat = fs.statSync(fullPath);
          return { name, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
        } catch (e) { return null; }
      })
      .filter(Boolean)
      .filter(e => e.ctime > afterMs || e.mtime > afterMs)
      .sort((a, b) => b.ctime - a.ctime);
    return entries.length > 0 ? entries[0].name : null;
  } catch (e) {
    return null;
  }
}

const app = express();
const port = 3014;

// Enable CORS and increase body limits for base64 screenshots
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Multer config for file upload (in memory)
const upload = multer({ storage: multer.memoryStorage() });

// Helper to spawn agy CLI
// options: { conversationId, sessionId, logPrefix }
function runAgyCommand(promptText, options = {}) {
  return new Promise((resolve, reject) => {
    const { conversationId, sessionId, logPrefix = 'agy' } = options;
    const args = ['--dangerously-skip-permissions', '--print-timeout', '10m', '--model', 'Gemini 3.5 Flash (Medium)'];
    if (conversationId) {
      args.push('--conversation', conversationId);
    }
    args.push('-p', promptText);

    console.log(`[${logPrefix}] Spawning agy CLI, prompt length: ${promptText.length}${conversationId ? `, conv: ${conversationId}` : ''}`);
    if (sessionId) sessionLog(sessionId, 'system', `⚙️ Spawning AI agent...`);

    const child = spawn('/root/.local/bin/agy', args, {
      cwd: '/tmp',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 85000 // Timeout after 85 seconds to prevent Cloudflare 524
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Stream meaningful lines to session log
      if (sessionId) {
        chunk.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed.length > 0 && !trimmed.startsWith('{') && !trimmed.startsWith('"')) {
            sessionLog(sessionId, 'progress', trimmed);
          }
        });
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (sessionId) {
        chunk.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed.length > 2) sessionLog(sessionId, 'debug', trimmed);
        });
      }
    });

    child.on('exit', (code, signal) => {
      const displayExit = code !== null ? `exit ${code}` : `signal ${signal}`;
      console.log(`[${logPrefix}] Process exited via ${displayExit}, stdout: ${stdout.length} bytes, stderr: ${stderr.length} bytes`);
      if (sessionId) sessionLog(sessionId, 'system', `✅ AI agent finished (${displayExit})`);
      
      let finalCode = code;
      if (code === null && signal) {
        finalCode = -1;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          stderr += `\n[Error] AI command execution timed out after 85 seconds.`;
        }
      }
      resolve({ code: finalCode, stdout, stderr });
    });

    child.on('error', (err) => {
      console.error(`[${logPrefix}] Process spawn error:`, err);
      if (sessionId) sessionLog(sessionId, 'error', `❌ Failed to spawn: ${err.message}`);
      reject(err);
    });
  });
}

// Check if agy response indicates a quota/rate-limit error
function checkTranscriptForRateLimit(conversationId) {
  if (!conversationId) return false;
  try {
    const transcriptPath = path.join(AGY_BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) return false;
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'ERROR_MESSAGE' && (obj.error_code === 429 || (obj.error && obj.error.includes('overloaded')))) {
          return true;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('Error reading transcript for rate limit check:', e);
  }
  return false;
}

// Check if agy response indicates a quota/rate-limit error
function checkForQuotaError(stdout, stderr, conversationId = null) {
  const combined = (stdout + ' ' + stderr).toLowerCase();
  const quotaPatterns = [
    'quota', 'rate limit', 'rate_limit', 'too many requests',
    '429', 'resource exhausted', 'resourceexhausted',
    'tokens per minute', 'requests per minute', 'rpm limit',
    'overloaded', 'capacity', 'try again later'
  ];
  for (const pattern of quotaPatterns) {
    if (combined.includes(pattern)) {
      return true;
    }
  }
  if (conversationId && checkTranscriptForRateLimit(conversationId)) {
    return true;
  }
  return false;
}

// Robust JSON extraction from agy output
// agy may print JSON inline, or may write it to a file via write_to_file tool
function extractJSON(stdout, tempDir) {
  // Strategy 1: Find JSON in stdout by matching balanced braces
  const text = stdout.trim();
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    // Walk forward to find the matching closing brace
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"' ) { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.substring(firstBrace, i + 1);
          try {
            return JSON.parse(candidate);
          } catch (e) {
            console.log(`[extractJSON] Inline parse failed at pos ${firstBrace}-${i}, trying next...`);
            // Continue scanning for another JSON object
          }
        }
      }
    }
  }

  // Strategy 2: Check if agy wrote JSON files to temp_uploads
  if (tempDir && fs.existsSync(tempDir)) {
    const jsonFiles = fs.readdirSync(tempDir)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(tempDir, f),
        mtime: fs.statSync(path.join(tempDir, f)).mtimeMs
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    for (const jf of jsonFiles) {
      try {
        const content = fs.readFileSync(jf.path, 'utf8');
        const parsed = JSON.parse(content);
        console.log(`[extractJSON] Found JSON in file: ${jf.name}`);
        // Clean up the file
        try { fs.unlinkSync(jf.path); } catch (e) {}
        return parsed;
      } catch (e) {
        // Not valid JSON, skip
      }
    }
  }

  // Strategy 3: Look for file:// links in stdout and try reading them
  const fileLinks = stdout.match(/(?:file:\/\/)?(\/[^\s\)\]]+\.json)/g);
  if (fileLinks) {
    for (const link of fileLinks) {
      const filePath = link.replace('file://', '');
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(content);
          console.log(`[extractJSON] Found JSON via file link: ${filePath}`);
          try { fs.unlinkSync(filePath); } catch (e) {}
          return parsed;
        } catch (e) {}
      }
    }
  }

  return null;
}

function clearTempJsonFiles(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(tempDir, file));
            console.log(`[cleanup] Deleted stale JSON file: ${file}`);
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    console.error('Failed to clear temp JSON files:', e);
  }
}

// Helper to save buffer to a temporary file
async function saveBufferToTempFile(buffer, prefix, mimetype) {
  const tempDir = path.join(__dirname, 'temp_uploads');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  let ext = '.jpg';
  if (mimetype === 'image/png') ext = '.png';
  else if (mimetype === 'image/gif') ext = '.gif';
  
  const tempFilename = `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const tempFilePath = path.join(tempDir, tempFilename);
  await fs.promises.writeFile(tempFilePath, buffer);
  return tempFilePath;
}

// Helper to resize image using Python & Pillow in place
function resizeImageWithPython(inputPath) {
  return new Promise((resolve, reject) => {
    const pythonScript = `
import sys
from PIL import Image
try:
    img = Image.open('${inputPath}')
    try:
        resample = Image.Resampling.LANCZOS
    except AttributeError:
        resample = Image.ANTIALIAS
    img.thumbnail((1200, 1200), resample)
    img.save('${inputPath}', quality=85)
    print("success")
except Exception as e:
    print(str(e))
    sys.exit(1)
`;
    const py = spawn('python3', ['-c', pythonScript]);
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', d => stdout += d.toString());
    py.stderr.on('data', d => stderr += d.toString());
    py.on('close', (code) => {
      if (code === 0 && stdout.trim() === 'success') {
        console.log(`[resize] Image successfully resized: ${inputPath}`);
        resolve(inputPath);
      } else {
        console.warn(`[resize] Python resize failed: code ${code}, stderr: ${stderr.trim()}, stdout: ${stdout.trim()}`);
        resolve(inputPath); // fallback to original
      }
    });
  });
}

// Wall Tracing Endpoint
app.post('/trace', upload.single('image'), async (req, res) => {
  let tempFilePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file uploaded." });
    }

    console.log(`Received file: ${req.file.originalname}, size: ${req.file.size} bytes`);
    tempFilePath = await saveBufferToTempFile(req.file.buffer, 'trace', req.file.mimetype);
    await resizeImageWithPython(tempFilePath);

    const designBrief = req.body && req.body.designBrief ? req.body.designBrief : '';
    const prompt = `
Analyze the 2D floor plan image located at the absolute path: ${tempFilePath}
${designBrief ? `\nDesign Brief/Context:\n"${designBrief}"\nUse this context when detecting wall types, room proportions, structural elements, or scaling assumptions.\n` : ''}
You are an expert architectural blueprint digitizer and floor plan recognition AI.
Generate a coordinate-based floor plan representation in centimeters, using the following rules:

1. Define the coordinate system such that the top-left corner of the ENTIRE image is (0, 0).
2. Look for dimension markings of the building in the drawing to estimate the real-world scale (e.g. if the blueprint says a room or the building width is 4.80 meters, use that to calibrate the pixel-to-centimeter scale). Estimate the total real-world width and height of the ENTIRE image frame in centimeters (including any margins, white or black borders, empty spaces, or legend areas around the actual building floor plan drawing). For example, if the building is 4.80m wide and there are substantial margins on the sides, the entire image width might be around 600cm.
3. Output the estimated total image width and height as "imageWidth" and "imageHeight" in centimeters.
4. Output the coordinates of all wall corners in centimeters relative to the top-left corner of the ENTIRE image (0, 0). This means the building walls should NOT start at x=0 or y=0 if there are margins on the left or top of the building in the image; they should start at the actual estimated coordinate of the walls in the image.
5. Detect both the outer perimeter walls and any interior partition walls.
6. Ignore all red dimension lines, dimension texts, annotations, arrows, labels, door swing arcs, and furniture outlines. Only map actual structural walls.
7. Output a clean, valid JSON object matching the following structure:
{
  "imageWidth": number,
  "imageHeight": number,
  "corners": {
    "c1": { "x": number, "y": number },
    "c2": { "x": number, "y": number }
  },
  "walls": [
    { "corner1": "c1", "corner2": "c2" }
  ]
}
Each key in "corners" must be a unique string ID, and X and Y must be numbers representing coordinates in centimeters relative to the top-left of the entire image.
Each item in "walls" must connect two corner IDs.

8. CRITICAL QUALITY RULE: Enforce strict orthogonal alignment (horizontal and vertical walls). Blueprints use straight, perpendicular walls. If a wall segment is horizontal, its two corners MUST have identical Y coordinates. If a wall segment is vertical, its two corners MUST have identical X coordinates. Correct any small vision measurement noise to ensure perfectly straight, clean wall joins.

CRITICAL RULES FOR EFFICIENCY:
1. You are NOT allowed to execute terminal commands, run shell commands, or write/execute any Python scripts. Any attempt to write or execute code will be blocked or cause execution failure.
2. Use your native vision capability directly to inspect the image, perform all measurements/calculations internally, and output the final JSON in your first reply step.
3. Print the raw JSON object directly to stdout. Do NOT write it to a file. Do NOT explain your steps or print anything else beside the JSON.
`;

    const tempDir = path.join(__dirname, 'temp_uploads');
    clearTempJsonFiles(tempDir);
    const sessionId = req.body && req.body.sessionId ? req.body.sessionId : (req.query.sessionId || null);
    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    if (sessionId) sessionLog(sessionId, 'system', '🗺️ Starting wall trace...');
    const { code, stdout, stderr } = await runAgyCommand(prompt, { sessionId, conversationId, logPrefix: 'trace' });

    // Check for quota/rate-limit errors
    if (checkForQuotaError(stdout, stderr, conversationId)) {
      console.error('[trace] Quota/rate-limit error detected');
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }

    if (code !== 0) {
      throw new Error(`agy CLI exited with code ${code}. Stderr: ${stderr}`);
    }

    const parsedData = extractJSON(stdout, tempDir);
    if (!parsedData) {
      console.error(`[trace] Failed to extract JSON from stdout:`, stdout);
      throw new Error(`Could not extract JSON from agy response (${stdout.length} bytes)`);
    }
    res.json(parsedData);

  } catch (error) {
    console.error("Error processing trace request:", error);
    res.status(500).json({ error: error.message || "Internal server error." });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("Failed to delete temp file:", e); }
    }
  }
});

// Interactive AI Design Assistant & Render generator
app.post('/chat', async (req, res) => {
  let tempFilePath = null;
  let chatImageTempPath = null;
  let screenshot3DTempPath = null;
  try {
    const { message, floorplan, chatHistory, screenshot, designBrief, chatImage, screenshot3d, objects } = req.body;
    
    if (screenshot) {
      const base64Data = screenshot.split(',')[1] || screenshot;
      const buffer = Buffer.from(base64Data, 'base64');
      tempFilePath = await saveBufferToTempFile(buffer, 'screenshot_blender', 'image/png');
    }

    if (chatImage) {
      const base64Data = chatImage.split(',')[1] || chatImage;
      const buffer = Buffer.from(base64Data, 'base64');
      chatImageTempPath = await saveBufferToTempFile(buffer, 'chat_2dplan', 'image/png');
    }

    if (screenshot3d) {
      const base64Data = screenshot3d.split(',')[1] || screenshot3d;
      const buffer = Buffer.from(base64Data, 'base64');
      screenshot3DTempPath = await saveBufferToTempFile(buffer, 'screenshot_threejs', 'image/png');
    }

    let contextPrompt = `
You are an expert CAD architect and photorealistic interior design assistant. The user is working on a 3D floor plan.

Current floorplan state (corners and walls in centimetres):
${JSON.stringify(floorplan || {}, null, 2)}

Identified Objects Layout details (with numbers corresponding to the 2D layout):
${JSON.stringify(objects || [], null, 2)}

${designBrief ? `\nDesign Brief / Style Context:\n"${designBrief}"\n` : ''}
FLOORPLAN EDITING: If the user asks to modify the layout (add/delete/move walls, resize), return the complete updated floorplan in "floorplan".

Renders/Reference Images provided:
- Blender Render Image: ${tempFilePath ? `saved at "${tempFilePath}"` : 'Not provided'}. This is the primary spatial layout, depth, lighting, and perspective reference.
- 2D Floor Plan layout with numbered circles: ${chatImageTempPath ? `saved at "${chatImageTempPath}"` : 'Not provided'}. Shows item numbers, bounds, walls, and camera direction pins.
- Three.js Interactive 3D Viewport screenshot: ${screenshot3DTempPath ? `saved at "${screenshot3DTempPath}"` : 'Not provided'}. Shows the overall room layout, shapes, and color schemes.

SPATIAL POSITIONING & OCCLUSION RULES:
1. Compare the 2D plan, the Three.js viewport screenshot, and the Blender render.
2. Note that objects located behind or next to the active camera position (refer to the camera pin C2 in the 2D plan and the 3D viewport) will NOT be visible in the Blender perspective render. You must NOT force them into the image prompt if they are out of the camera's view frustum.
3. Place each object exactly where its numbered circle is located, matching its drawn shape and dimensions.

RENDER GENERATION: For ANY message about visual appearance, materials, lighting, furniture, colors, mood, or style, ALWAYS produce an "imagePrompt" for generating the final photorealistic render.
`;

    contextPrompt += `
CRITICAL RULES FOR "imagePrompt":
1. Preserve the exact 3D room geometry (wall positions, doorways, openings) shown in the Blender render.
2. Do NOT change structural elements — only add/change furniture, decor, textures, materials, lighting.
3. Be hyper-specific: describe exact materials (e.g. "brushed brass pendant lights", "herringbone oak parquet floor"), colors, finishes, and atmosphere.
4. Reference the previous render for continuity — keep unchanged elements consistent.
5. If design brief was provided, ensure the style matches it.
6. Map all object descriptions directly to screen-space coordinates of the provided Blender render. If an object appears on the left side of the Blender render, you MUST describe it as being on the left side of the image. Do NOT swap or invert positions.
7. If an object is not in the Blender render frame because it is behind the camera, do not mention or place it in the imagePrompt.

Response Schema (return raw JSON only, no markdown):
{
  "reply": "Brief, clear explanation of what you changed or are doing. Max 2-3 sentences.",
  "floorplan": { ... },    // Optional: only if layout changed
  "imagePrompt": "string"  // ALWAYS include for any visual change request
}
`;

    let agyPrompt = contextPrompt + "\n\nChat History:\n";
    (chatHistory || []).forEach(h => {
      agyPrompt += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}\n`;
    });
    agyPrompt += `\nUser's new message: ${message}\n`;


    const tempDir = path.join(__dirname, 'temp_uploads');
    const sessionId = req.body.sessionId || null;
    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    if (sessionId) sessionLog(sessionId, 'system', '💬 Processing chat message...');
    const { code, stdout, stderr } = await runAgyCommand(agyPrompt, { sessionId, conversationId, logPrefix: 'chat' });

    if (checkForQuotaError(stdout, stderr, conversationId)) {
      console.error('[chat] Quota/rate-limit error detected');
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }

    if (code !== 0) {
      throw new Error(`agy CLI exited with code ${code}. Stderr: ${stderr}`);
    }

    const chatData = extractJSON(stdout, tempDir);
    if (!chatData) {
      console.error(`[chat] Failed to extract JSON from stdout:`, stdout);
      throw new Error(`Could not extract JSON from agy response (${stdout.length} bytes)`);
    }
    let imageUrl = null;

    if (chatData.imagePrompt) {
      console.log(`Generating realistic render with prompt: ${chatData.imagePrompt}`);
      try {
        let refImages = [];
        if (tempFilePath) refImages.push(tempFilePath);
        if (chatImageTempPath) refImages.push(chatImageTempPath);
        if (screenshot3DTempPath) refImages.push(screenshot3DTempPath);

        let refImageText = '';
        if (refImages.length > 0) {
          const pathList = refImages.map(p => `"${p}"`).join(', ');
          refImageText = `You MUST pass the reference image paths: [${pathList}] in the ImagePaths parameter of the generate_image tool. The layout/depth image "${tempFilePath}" preserves the exact room proportions and camera perspective. The 2D plan layout is at "${chatImageTempPath}". ${screenshot3DTempPath ? `The third image at "${screenshot3DTempPath}" is either a previous AI render of the same room (for style consistency) or a 3D viewport reference — use it to match materials, colors, lighting mood, and furniture styles exactly.` : ''} Use these reference images to analyze colors, layouts, materials, and spatial positioning.`;
        }

        const imageAgyPrompt = `Generate a photorealistic 3D render using the generate_image tool.
Use this text prompt: "${chatData.imagePrompt}".
${refImageText}
Return ONLY the markdown link to the generated image file, do not include any other text.`;
        const imageResult = await runAgyCommand(imageAgyPrompt, { sessionId, conversationId, logPrefix: 'chat-imagen' });
        const match = imageResult.stdout.match(/(?:file:\/\/|file:)?(\/[^\s\)]+)/);
        if (match) {
          const generatedFilePath = match[1];
          if (fs.existsSync(generatedFilePath)) {
            const imgBuffer = fs.readFileSync(generatedFilePath);
            imageUrl = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;
            fs.unlinkSync(generatedFilePath);
            console.log("Imagen render generated successfully.");
          }
        } else {
          console.warn("Failed to find image path in agy output:", imageResult.stdout);
        }
      } catch (imgErr) {
        console.error("Failed to generate Imagen render:", imgErr);
      }
    }

    res.json({
      reply: chatData.reply,
      floorplan: chatData.floorplan || null,
      imageUrl: imageUrl
    });

  } catch (error) {
    console.error("Error in chat handler:", error);
    res.status(500).json({ error: error.message || "Internal server error." });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("Failed to delete temp screenshot file:", e); }
    }
    if (chatImageTempPath && fs.existsSync(chatImageTempPath)) {
      try { fs.unlinkSync(chatImageTempPath); } catch (e) { console.error("Failed to delete temp reference image file:", e); }
    }
    if (screenshot3DTempPath && fs.existsSync(screenshot3DTempPath)) {
      try { fs.unlinkSync(screenshot3DTempPath); } catch (e) { console.error("Failed to delete temp screenshot3d file:", e); }
    }
  }
});

// ─── Auto Scan: unified floor plan analysis (walls + doors + windows + rooms + objects + cameras) ───
app.post('/auto-scan', upload.single('image'), async (req, res) => {
  let tempFilePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file uploaded.' });
    console.log(`[auto-scan] Received file: ${req.file.originalname}, size: ${req.file.size} bytes`);

    tempFilePath = await saveBufferToTempFile(req.file.buffer, 'autoscan', req.file.mimetype);
    await resizeImageWithPython(tempFilePath);

    const designBrief = req.body && req.body.designBrief ? req.body.designBrief : '';
    const sessionId   = req.body && req.body.sessionId  ? req.body.sessionId  : null;
    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    const tempDir = path.join(__dirname, 'temp_uploads');

    clearTempJsonFiles(tempDir);
    if (sessionId) sessionLog(sessionId, 'system', '🔍 Auto Scan: analysing floor plan...');

    const prompt = `
Analyze the 2D floor plan blueprint image located at the absolute path: ${tempFilePath}
${designBrief ? `\nDesign Brief / Space Context:\n"${designBrief}"\nUse this to understand the type of establishment, room purposes, and expected furniture/fixtures.\n` : ''}

You are an expert architectural floor plan digitizer. In ONE single pass, extract ALL of the following from the image:

COORDINATE SYSTEM: Top-left corner of the ENTIRE image (including all margins) is (0, 0). All coordinates are in centimetres.

━━━ 1. SCALE ━━━
- Look for dimension markings on the blueprint (e.g. "4.80m", "12.00m") to calibrate pixel→cm scale.
- Output "imageWidth" and "imageHeight": the estimated real-world size of the ENTIRE image frame in cm (including margins).

━━━ 2. WALLS ━━━
- Extract ALL structural wall corners as unique IDs (c1, c2, …) with (x, y) in cm.
- Extract wall segments as pairs of corner IDs.
- Include outer perimeter walls AND all interior partition walls.
- CRITICAL: Enforce strict orthogonal alignment. Horizontal walls: both corners share IDENTICAL Y. Vertical walls: both corners share IDENTICAL X. Snap any measurement noise.
- IGNORE: dimension lines, door swing arcs, furniture symbols, annotations, labels.

━━━ 3. DOORS ━━━
- Detect every door symbol (usually an arc + a line segment on a wall).
- For each door output: id (door_1, door_2, …), centroid x/y in cm, width w in cm (typical 80–100cm), height h (use 200 as default), swingDirection ("inward" or "outward"), and label (room label from the plan if visible, e.g. "Bathroom", "Kitchen").

━━━ 4. WINDOWS ━━━
- Detect every window symbol (a double or triple line break in a wall).
- For each window output: id (win_1, win_2, …), centroid x/y in cm, width w in cm, height h (use 120 as default), sillHeight (use 90 as default if not marked).

━━━ 5. ROOMS ━━━
- Identify every enclosed room/space by its label text on the plan.
- For each room output: id (room_1, room_2, …), label (the text label shown), centroid {x, y} in cm, areaM2 (estimated area in square metres).

━━━ 6. OBJECTS ━━━
- Identify every furniture/fixture SYMBOL — NOT walls, NOT dimension lines, NOT text annotations.
- For each object output: id (obj_1, obj_2, …), centroid x/y in cm, bounding box w/h in cm, typeGuess (use one of: dining_table, table, chair, bar_stool, sofa, counter, kitchen_counter, bar, sink, stove, oven, refrigerator, display_case, shelves, staircase, stairs, plant, generic), rotation in degrees (0 if unknown).

━━━ 7. SUGGESTED CAMERAS ━━━
- Based on the design brief and the room layout, suggest 1 to 3 optimal camera positions for architectural photography.
- Each camera should face toward the most interesting or representative part of the space.
- For each camera output: id (cam_1, cam_2, …), x/y in cm (camera pin position), angle in degrees (0=north/up, 90=east/right, 180=south/down, 270=west/left — the direction the camera is FACING), label (short descriptive name), reasoning (one sentence why).

━━━ OUTPUT FORMAT ━━━
Output ONLY a single raw JSON object matching EXACTLY this schema. No explanations, no markdown, no additional text:

{
  "imageWidth": number,
  "imageHeight": number,
  "corners": {
    "c1": { "x": number, "y": number },
    "c2": { "x": number, "y": number }
  },
  "walls": [
    { "corner1": "c1", "corner2": "c2" }
  ],
  "doors": [
    { "id": "door_1", "x": number, "y": number, "w": number, "h": number, "swingDirection": "inward", "label": "string" }
  ],
  "windows": [
    { "id": "win_1", "x": number, "y": number, "w": number, "h": number, "sillHeight": number }
  ],
  "rooms": [
    { "id": "room_1", "label": "string", "centroid": { "x": number, "y": number }, "areaM2": number }
  ],
  "objects": [
    { "id": "obj_1", "x": number, "y": number, "w": number, "h": number, "typeGuess": "string", "rotation": number }
  ],
  "suggestedCameras": [
    { "id": "cam_1", "x": number, "y": number, "angle": number, "label": "string", "reasoning": "string" }
  ]
}

CRITICAL RULES:
1. Do NOT execute any terminal commands, shell commands, or Python scripts.
2. Use your native vision capability to inspect the image. Perform all measurements internally.
3. Output the raw JSON in your FIRST reply step. No other text before or after.
`;

    const result = await runAgyCommand(prompt, { sessionId, conversationId, logPrefix: 'auto-scan' });

    if (checkForQuotaError(result.stdout, result.stderr, conversationId)) {
      console.error('[auto-scan] Quota/rate-limit error');
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }
    if (result.code !== 0) {
      throw new Error(`agy CLI exited with code ${result.code} at auto-scan. Stderr: ${result.stderr}`);
    }

    const parsedData = extractJSON(result.stdout, tempDir);
    if (!parsedData) {
      console.error('[auto-scan] Failed to extract JSON from stdout:', result.stdout);
      throw new Error(`Could not extract JSON from agy auto-scan response (${result.stdout.length} bytes)`);
    }

    // Ensure required fields exist with sensible defaults
    parsedData.corners         = parsedData.corners         || {};
    parsedData.walls           = parsedData.walls           || [];
    parsedData.doors           = parsedData.doors           || [];
    parsedData.windows         = parsedData.windows         || [];
    parsedData.rooms           = parsedData.rooms           || [];
    parsedData.objects         = parsedData.objects         || [];
    parsedData.suggestedCameras = parsedData.suggestedCameras || [];

    console.log(`[auto-scan] Success — corners:${Object.keys(parsedData.corners).length} walls:${parsedData.walls.length} doors:${parsedData.doors.length} windows:${parsedData.windows.length} objects:${parsedData.objects.length} cameras:${parsedData.suggestedCameras.length}`);
    if (sessionId) sessionLog(sessionId, 'system', `✅ Auto Scan complete — ${Object.keys(parsedData.corners).length} corners, ${parsedData.walls.length} walls, ${parsedData.doors.length} doors, ${parsedData.windows.length} windows, ${parsedData.objects.length} objects, ${parsedData.suggestedCameras.length} camera(s) suggested`);

    res.json(parsedData);

  } catch (error) {
    console.error('[auto-scan] Error:', error);
    res.status(500).json({ error: error.message || 'Internal server error.' });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
  }
});

// AI identifies furniture/fixtures in a floor plan image
app.post('/identify', upload.single('image'), async (req, res) => {
  let tempFilePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "No image file uploaded." });
    console.log(`[identify] Received file: ${req.file.originalname}, size: ${req.file.size} bytes`);
    
    tempFilePath = await saveBufferToTempFile(req.file.buffer, 'identify', req.file.mimetype);
    await resizeImageWithPython(tempFilePath);

    const designBrief = req.body && req.body.designBrief ? req.body.designBrief : '';
    const calibrateWidth = req.body && req.body.calibrateWidth ? parseFloat(req.body.calibrateWidth) : null;
    const calibrateHeight = req.body && req.body.calibrateHeight ? parseFloat(req.body.calibrateHeight) : null;
    
    let scaleInstruction = '';
    if (calibrateWidth && calibrateHeight) {
      scaleInstruction = `We are using a coordinate system where the top-left corner of the ENTIRE image frame is (0, 0).
The user has manually calibrated the real-world dimensions of this floor plan image to be exactly: ${calibrateWidth} meters wide by ${calibrateHeight} meters high.
You MUST use this exact scale to calculate the centimeter coordinates of all identified objects. The overall image frame represents these exact dimensions (e.g. the width of the image is exactly ${calibrateWidth * 100}cm and the height of the image is exactly ${calibrateHeight * 100}cm). Perform all your measurements and centroid/bounding box calculations in centimeters using this scale. Do not perform any other scale estimation.`;
    } else {
      scaleInstruction = `We are using a coordinate system where the top-left corner of the ENTIRE image frame is (0, 0) (including all margins).
Look for dimension markings in the drawing to estimate the real-world scale (using the same scale as the wall trace: building size is scaled to the overall image size).`;
    }

    const prompt = `
Analyze the 2D floor plan image located at the absolute path: ${tempFilePath}
${designBrief ? `\nDesign Brief/Context:\n"${designBrief}"\nUse this context (e.g. the type of establishment or home) to help guide what kind of furniture, fixtures, and objects to look for and how to label/identify them.\n` : ''}
You are an expert architectural floor plan analyst.
Analyze this 2D floor plan image carefully.
Identify every furniture item, fixture, or equipment symbol visible — NOT walls, NOT dimension lines, NOT text annotations.

${scaleInstruction}

For each object found, return its approximate centroid position in centimeters relative to the top-left corner of the ENTIRE image (0, 0) (not relative to the building). For example, if there is a margin of 60cm on the left, an object on the left wall of the building will have X around 60.
Also return approximate bounding box width and height in centimeters, and a best-guess type name.

Format the output as a valid JSON object in this exact structure:
{
  "objects": [
    { "id": "obj_1", "x": 120, "y": 340, "w": 80, "h": 80, "typeGuess": "dining_table" },
    { "id": "obj_2", "x": 80, "y": 200, "w": 40, "h": 40, "typeGuess": "chair" }
  ]
}

Valid typeGuess values: dining_table, chair, bar_stool, counter, kitchen_counter, sink, stove, oven, refrigerator, shelves, staircase, sofa, plant, bar, display_case, door, window, generic.
Do not include walls, columns, dimension lines, or text labels as objects.

CRITICAL RULES FOR EFFICIENCY:
1. You are NOT allowed to execute terminal commands, run shell commands, or write/execute any Python scripts. Any attempt to write or execute code will be blocked or cause execution failure.
2. Use your native vision capability directly to inspect the image, perform all measurements/calculations internally, and output the final JSON in your first reply step.
3. Print the raw JSON object directly to stdout. Do NOT write it to a file. Do NOT explain your steps or print anything else beside the JSON.
`;

    const tempDir = path.join(__dirname, 'temp_uploads');
    clearTempJsonFiles(tempDir);
    const sessionId = req.body && req.body.sessionId ? req.body.sessionId : (req.query.sessionId || null);
    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    if (sessionId) sessionLog(sessionId, 'system', '🔍 Identifying furniture and fixtures...');
    const { code, stdout, stderr } = await runAgyCommand(prompt, { sessionId, conversationId, logPrefix: 'identify' });

    if (checkForQuotaError(stdout, stderr, conversationId)) {
      console.error('[identify] Quota/rate-limit error detected');
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }

    if (code !== 0) {
      throw new Error(`agy CLI exited with code ${code}. Stderr: ${stderr}`);
    }

    const parsedData = extractJSON(stdout, tempDir);
    if (!parsedData) {
      console.error(`[identify] Failed to extract JSON from stdout:`, stdout);
      throw new Error(`Could not extract JSON from agy response (${stdout.length} bytes)`);
    }
    res.json(parsedData);

  } catch (error) {
    console.error("Error in /identify:", error);
    res.status(500).json({ error: error.message });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("Failed to delete temp file:", e); }
    }
  }
});

// AI visions a reference photo and returns a description
app.post('/describe-object', upload.single('image'), async (req, res) => {
  let tempFilePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "No image file uploaded." });
    console.log(`[describe-object] Received file: ${req.file.originalname}, size: ${req.file.size} bytes`);
    
    tempFilePath = await saveBufferToTempFile(req.file.buffer, 'describe', req.file.mimetype);
    await resizeImageWithPython(tempFilePath);

    const prompt = `
Analyze the reference photo of a furniture piece or fixture located at the absolute path: ${tempFilePath}

You are an interior design assistant. The user has uploaded a reference photo of a furniture piece or fixture.
Describe it in detail for use in a photorealistic render prompt.
Focus on: shape, material, color, finish, style (modern, industrial, rustic, etc.), size impression.
Keep the description under 60 words. Be specific and vivid.

You can EITHER print the raw JSON object { "description": "..." } directly to stdout, OR write it to a .json file using the write_to_file tool. Do what is fastest and most reliable.
Do NOT read or explore other files in the directory. Focus only on the image file.
`;

    const tempDir = path.join(__dirname, 'temp_uploads');
    clearTempJsonFiles(tempDir);
    const sessionId = req.body && req.body.sessionId ? req.body.sessionId : (req.query.sessionId || null);
    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    const { code, stdout, stderr } = await runAgyCommand(prompt, { sessionId, conversationId, logPrefix: 'describe-object' });

    if (checkForQuotaError(stdout, stderr, conversationId)) {
      console.error('[describe-object] Quota/rate-limit error detected');
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }

    if (code !== 0) {
      throw new Error(`agy CLI exited with code ${code}. Stderr: ${stderr}`);
    }

    const parsedData = extractJSON(stdout, tempDir);
    if (!parsedData) {
      console.error(`[describe-object] Failed to extract JSON from stdout:`, stdout);
      throw new Error(`Could not extract JSON from agy response (${stdout.length} bytes)`);
    }
    res.json(parsedData);

  } catch (error) {
    console.error("Error in /describe-object:", error);
    res.status(500).json({ error: error.message });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) { console.error("Failed to delete temp file:", e); }
    }
  }
});

// AI Generates a simplified 3D shape breakdown (primitives) for custom/non-standard objects
app.post('/generate-primitives', async (req, res) => {
  try {
    const { objects, designBrief, sessionId } = req.body;
    if (!objects || objects.length === 0) {
      return res.json({ primitives: {} });
    }

    console.log(`[generate-primitives] Request for ${objects.length} custom objects`);

    const prompt = `
You are an expert 3D interior designer and architectural spatial planner.
We need to generate simplified 3D shape breakdowns (primitives) for the following custom objects in our scene layout:
${JSON.stringify(objects.map(o => ({ id: o.id, type: o.label || o.typeGuess, w: o.w || 60, h: o.h || 60 })), null, 2)}

Design style context: "${designBrief || 'No specific style'}"

For each custom object, your task is to break it down into a list of 2 to 8 basic 3D primitive shapes (cubes, cylinders, spheres) that represent it roughly but recognizably.
All coordinates, positions, and dimensions must be in METERS.
Local coordinate system:
- The origin (0, 0, 0) is the center of the object's footprint bounding box on the floor.
- Z = 0 is floor level. (Z coordinate must be positive, representing height above floor).
- Sizes must fit roughly within the object's bounding box: width (X size), depth (Y size), height (Z size).

Format the output as a valid JSON object mapping each object's ID to its array of primitives. Format:
{
  "obj_id_1": [
    {
      "shape": "cube", // "cube", "cylinder", "sphere"
      "size": [width, depth, height], // size in meters. For cylinder: [radius, depth]. For sphere: [radius]
      "pos": [x, y, z], // local position in meters (z is height off the floor)
      "rot": [rx, ry, rz], // local rotation in degrees (roll, pitch, yaw)
      "mat": "wood" // material: wood, steel, glass, ceramic, painted, foliage, stone, leather, fabric, marble
    }
  ]
}

Available materials: wood, steel, glass, ceramic, painted, foliage, stone, leather, fabric, marble, tile.
Output ONLY the valid raw JSON object. Do not include markdown \`\`\`json blocks. Do not explain your steps or write any other text.
`;

    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    const { code, stdout, stderr } = await runAgyCommand(prompt, { sessionId, conversationId, logPrefix: 'generate-primitives' });

    if (checkForQuotaError(stdout, stderr, conversationId)) {
      console.error('[generate-primitives] Quota/rate-limit error detected');
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }

    if (code !== 0) {
      throw new Error(`agy CLI exited with code ${code}. Stderr: ${stderr}`);
    }

    const tempDir = path.join(__dirname, 'temp_uploads');
    const parsedData = extractJSON(stdout, tempDir);
    if (!parsedData) {
      console.error(`[generate-primitives] Failed to extract JSON from stdout:`, stdout);
      throw new Error(`Could not extract JSON from agy response (${stdout.length} bytes)`);
    }

    res.json({ primitives: parsedData });

  } catch (error) {
    console.error("Error in /generate-primitives:", error);
    res.status(500).json({ error: error.message });
  }
});

// AI Direct Photo Decorator Endpoint
app.post('/direct-decorate', async (req, res) => {
  let baseTempPath = null;
  let annotatedTempPath = null;
  try {
    const { message, baseImage, annotatedImage, chatHistory } = req.body;

    if (!baseImage || !annotatedImage) {
      return res.status(400).json({ error: "Missing baseImage or annotatedImage." });
    }

    // Decode and save base image
    const baseBuffer = Buffer.from(baseImage.split(',')[1] || baseImage, 'base64');
    baseTempPath = await saveBufferToTempFile(baseBuffer, 'direct_base', 'image/jpeg');
    await resizeImageWithPython(baseTempPath);

    // Decode and save annotated image
    const annotatedBuffer = Buffer.from(annotatedImage.split(',')[1] || annotatedImage, 'base64');
    annotatedTempPath = await saveBufferToTempFile(annotatedBuffer, 'direct_annotated', 'image/jpeg');
    await resizeImageWithPython(annotatedTempPath);

    console.log(`[direct-decorate] Saved and resized temp images. Base: ${baseTempPath}, Annotated: ${annotatedTempPath}`);

    const promptText = `
You are an expert AI interior designer and spatial reasoning vision assistant.
Analyze these two versions of a space:
1. Original space photo: ${baseTempPath}
2. Annotated space photo (with user's custom markups/drawings): ${annotatedTempPath}

In the annotated photo, the user has drawn markup shapes (colored lines, circles, dashed lines, or shaded/highlighted areas) directly on top of the space to indicate regions of modification, placement of new items, or areas to fix/decorate.

Refinement Instructions:
- Read the user's refinement instructions: "${message}"
- Study the areas highlighted/drawn in the annotated image. Those drawings show the location where changes should be placed or fixed.
- Describe a new, decorated room that incorporates these changes. Replace the hand-drawn markings with actual, high-quality, photorealistic items (e.g. elegant furniture, lighting fixtures, realistic textures, matching decorations) that blend naturally into the rest of the room.
- Formulate a detailed text-to-image prompt to generate this refined scene. The prompt should describe the whole scene in detail, focusing on replacing the marked areas with the new items while keeping the rest of the room's architecture, windows, doors, and perspective identical.

Output a valid JSON object matching this schema:
{
  "reply": "Explain in detail what updates you have planned for the marked areas and how they address the user's request.",
  "imagePrompt": "A highly detailed, photorealistic prompt for generating the updated room design. Do NOT mention drawings, circles, lines, or markup in the prompt. Describe the finished room with actual elements replacing the drawings."
}

Do not include any explanation or markdown formatting outside the JSON. Return raw JSON.
`;

    let agyPrompt = promptText + "\n\nChat History:\n";
    (chatHistory || []).forEach(h => {
      agyPrompt += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}\n`;
    });
    agyPrompt += `\nUser's new message: ${message}\n`;

    const tempDir = path.join(__dirname, 'temp_uploads');
    clearTempJsonFiles(tempDir);
    const sessionId = req.body.sessionId || null;
    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    if (sessionId) sessionLog(sessionId, 'system', '🎨 Analyzing marked areas with Vision AI...');
    const { code, stdout, stderr } = await runAgyCommand(agyPrompt, { sessionId, conversationId, logPrefix: 'direct-decorate' });

    if (checkForQuotaError(stdout, stderr, conversationId)) {
      console.error('[direct-decorate] Quota/rate-limit error detected');
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }

    if (code !== 0) {
      throw new Error(`agy CLI exited with code ${code}. Stderr: ${stderr}`);
    }

    const decorData = extractJSON(stdout, tempDir);
    if (!decorData) {
      console.error(`[direct-decorate] Failed to extract JSON from stdout:`, stdout);
      throw new Error(`Could not extract JSON from agy response (${stdout.length} bytes)`);
    }

    let imageUrl = null;
    if (decorData.imagePrompt) {
      console.log(`[direct-decorate] Generating render with prompt: ${decorData.imagePrompt}`);
      try {
        const refImageText = baseTempPath ? `You MUST use the original room photo at the path: "${baseTempPath}" as the reference image (pass it in the ImagePaths parameter of the generate_image tool) to preserve the exact camera perspective, structural walls, windows, and layout of the original room.` : '';
        const imageAgyPrompt = `Generate a photorealistic room design using the generate_image tool.
Use this text prompt: "${decorData.imagePrompt}".
${refImageText}
Return ONLY the markdown link to the generated image file, do not include any other text.`;
        const imageResult = await runAgyCommand(imageAgyPrompt, { sessionId, conversationId, logPrefix: 'direct-imagen' });
        const match = imageResult.stdout.match(/(?:file:\/\/|file:)?(\/[^\s\)]+)/);
        if (match) {
          const generatedFilePath = match[1];
          if (fs.existsSync(generatedFilePath)) {
            // Save to the static folder for download and persistence!
            const staticFolder = path.join(__dirname, '..', 'cad', 'img');
            if (!fs.existsSync(staticFolder)) {
              fs.mkdirSync(staticFolder, { recursive: true });
            }
            const destFilename = `decor_render_${Date.now()}.jpg`;
            const destPath = path.join(staticFolder, destFilename);
            fs.copyFileSync(generatedFilePath, destPath);
            fs.unlinkSync(generatedFilePath); // clean up the temp file
            imageUrl = `/cad/img/${destFilename}`;
            console.log(`[direct-decorate] Saved design to static path: ${imageUrl}`);
          }
        } else {
          console.warn("[direct-decorate] Failed to find image path in agy output:", imageResult.stdout);
        }
      } catch (imgErr) {
        console.error("[direct-decorate] Failed to generate Imagen render:", imgErr);
      }
    }

    res.json({
      reply: decorData.reply,
      imageUrl: imageUrl
    });

  } catch (error) {
    console.error("Error in direct-decorate handler:", error);
    res.status(500).json({ error: error.message || "Internal server error." });
  } finally {
    if (baseTempPath && fs.existsSync(baseTempPath)) {
      try { fs.unlinkSync(baseTempPath); } catch (e) {}
    }
    if (annotatedTempPath && fs.existsSync(annotatedTempPath)) {
      try { fs.unlinkSync(annotatedTempPath); } catch (e) {}
    }
  }
});

// Build 3D scene with Blender headless and return JPEG
app.post('/blender-render', async (req, res) => {
  try {
    if (blenderBusy) {
      return res.status(429).json({ error: "A render is already in progress. Please wait." });
    }

    const { walls: wallsData, corners: cornersData, objects: objectsData, camera: cameraData,
            floor_w, floor_h, wall_height, wall_thick } = req.body;

    const jobId = crypto.randomBytes(6).toString('hex');
    const outputPath = path.join(TMP_DIR, `cad_render_${jobId}.jpg`);

    const sceneJson = JSON.stringify({
      walls:       wallsData   || [],
      corners:     cornersData || {},
      objects:     objectsData || [],
      camera:      cameraData  || {},
      floor_w:     floor_w     || 480,
      floor_h:     floor_h     || 1160,
      wall_height: wall_height || 250,
      wall_thick:  wall_thick  || 15,
      output_path: outputPath
    });

    console.log(`[blender-render] Starting job ${jobId}, output: ${outputPath}`);
    blenderBusy = true;

    const blender = spawn(BLENDER_BIN, [
      '--background',
      '--python', BLENDER_SCRIPT,
      '--', sceneJson
    ], { timeout: 60000 });

    let stdout = '';
    let stderr = '';
    blender.stdout.on('data', d => { stdout += d; process.stdout.write('[blender] ' + d); });
    blender.stderr.on('data', d => { stderr += d; });

    blender.on('close', (code) => {
      blenderBusy = false;
      if (code !== 0) {
        console.error(`[blender-render] Blender exited with code ${code}`);
        console.error('[blender-render] stderr:', stderr);
        return res.status(500).json({ error: `Blender render failed (exit ${code}).`, stderr });
      }
      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: 'Blender finished but output file not found.' });
      }
      const imgBuffer = fs.readFileSync(outputPath);
      const b64 = imgBuffer.toString('base64');
      fs.unlinkSync(outputPath); // cleanup

      // Read depth map if it exists
      const depthPath = outputPath.replace('.jpg', '_depth.png');
      let depthUrl = null;
      if (fs.existsSync(depthPath)) {
        const depthBuffer = fs.readFileSync(depthPath);
        depthUrl = `data:image/png;base64,${depthBuffer.toString('base64')}`;
        fs.unlinkSync(depthPath);
        console.log(`[blender-render] Depth map included.`);
      }

      // Read GLB model if it exists
      const glbPath = outputPath.replace('.jpg', '.glb');
      let glbUrl = null;
      if (fs.existsSync(glbPath)) {
        const glbBuffer = fs.readFileSync(glbPath);
        glbUrl = `data:model/gltf-binary;base64,${glbBuffer.toString('base64')}`;
        fs.unlinkSync(glbPath);
        console.log(`[blender-render] GLB model included.`);
      }

      console.log(`[blender-render] Job ${jobId} done.`);
      res.json({ imageUrl: `data:image/jpeg;base64,${b64}`, depthUrl, glbUrl });
    });

    blender.on('error', (err) => {
      blenderBusy = false;
      console.error('[blender-render] Failed to start Blender:', err);
      res.status(500).json({ error: 'Failed to start Blender: ' + err.message });
    });

  } catch (error) {
    blenderBusy = false;
    console.error("Error in /blender-render:", error);
    res.status(500).json({ error: error.message });
  }
});

// AI-Generated Blender Scene Builder route
app.post('/blender-ai-render', async (req, res) => {
  try {
    if (blenderBusy) {
      return res.status(429).json({ error: "A render is already in progress. Please wait." });
    }

    const { walls: wallsData, corners: cornersData, objects: objectsData, camera: cameraData,
            floor_w, floor_h, wall_height, wall_thick, designBrief, sessionId } = req.body;

    const conversationId = sessionId && sessions.has(sessionId) ? sessions.get(sessionId).conversationUUID : null;
    if (sessionId) sessionLog(sessionId, 'system', '🤖 Vision AI writing Blender code for 3D layout...');

    const standardTypes = [
      'dining_table', 'table', 'chair', 'bar_stool', 'sofa', 'counter',
      'kitchen_counter', 'bar', 'sink', 'stove', 'oven', 'refrigerator',
      'display_case', 'shelves', 'staircase', 'stairs', 'plant', 'door', 'window', 'generic'
    ];

    let customObjects = [];
    let scriptChunks = [];

    (objectsData || []).forEach((obj, idx) => {
      const otype = (obj.type || 'generic').toLowerCase();
      const shape = (obj.shape || 'rectangle').toLowerCase();

      // If it's a polygon or L-shape, or if its type is standard, generate programmatically
      if (shape === 'polygon' || shape === 'l-shape' || standardTypes.includes(otype)) {
        let builderName = null;
        if (otype === 'dining_table' || otype === 'table') builderName = 'build_dining_table';
        else if (otype === 'chair') builderName = 'build_chair';
        else if (otype === 'bar_stool') builderName = 'build_bar_stool';
        else if (otype === 'sofa') builderName = 'build_sofa';
        else if (otype === 'counter' || otype === 'kitchen_counter') builderName = 'build_counter';
        else if (otype === 'bar') builderName = 'build_bar';
        else if (otype === 'sink') builderName = 'build_sink';
        else if (otype === 'stove' || otype === 'oven') builderName = 'build_stove';
        else if (otype === 'refrigerator') builderName = 'build_refrigerator';
        else if (otype === 'display_case') builderName = 'build_display_case';
        else if (otype === 'shelves') builderName = 'build_shelves';
        else if (otype === 'staircase' || otype === 'stairs') builderName = 'build_staircase';
        else if (otype === 'plant') builderName = 'build_plant';
        else if (otype === 'door') builderName = 'build_door';
        else if (otype === 'window') builderName = 'build_window';
        else builderName = 'build_generic';

        let chunk = '';
        if (shape === 'l-shape') {
          chunk = `
# L-Shape Custom Object idx=${idx} (${obj.id}: ${obj.type || 'l-shape'})
try:
    ox, oy = p2b(${obj.x}, ${obj.y})
    ow = max(${obj.w || 60}, 10) * SCALE
    od = max(${obj.h || 60}, 10) * SCALE
    rot = math.radians(${obj.rotation || 0})
    t = 0.40  # 40cm wall thickness in meters
    vertices_2d = [
        (-ow/2, -od/2),
        (ow/2, -od/2),
        (ow/2, -od/2 + t),
        (-ow/2 + t, -od/2 + t),
        (-ow/2 + t, od/2),
        (-ow/2, od/2)
    ]
    parent_obj = add_polygon_extrusion(vertices_2d, 0.75, (ox, oy), rot, "L_Shape_${idx}", mat_painted)
    if parent_obj:
        if ${obj.flipH ? 'True' : 'False'}: parent_obj.scale.x *= -1
        if ${obj.flipV ? 'True' : 'False'}: parent_obj.scale.y *= -1
except Exception as e:
    print(f"[blender_scene] Error placing L-shape ${idx}: {e}")
`;
        } else if (shape === 'polygon' && obj.points && obj.points.length >= 3) {
          const pointsStr = JSON.stringify(obj.points);
          chunk = `
# Polygon Custom Object idx=${idx} (${obj.id}: ${obj.type || 'polygon'})
try:
    ox, oy = p2b(${obj.x}, ${obj.y})
    rot = math.radians(${obj.rotation || 0})
    points = ${pointsStr}
    cx_cm = ${obj.x}
    cy_cm = ${obj.y}
    vertices_2d = []
    for p in points:
        px = (p["x"] - cx_cm) * SCALE
        py = (p["y"] - cy_cm) * SCALE
        vertices_2d.append((px, py))
    parent_obj = add_polygon_extrusion(vertices_2d, 0.75, (ox, oy), rot, "Custom_Poly_${idx}", mat_painted)
    if parent_obj:
        if ${obj.flipH ? 'True' : 'False'}: parent_obj.scale.x *= -1
        if ${obj.flipV ? 'True' : 'False'}: parent_obj.scale.y *= -1
except Exception as e:
    print(f"[blender_scene] Error placing polygon ${idx}: {e}")
`;
        } else {
          chunk = `
# Standard Object idx=${idx} (${obj.id}: ${obj.type})
try:
    ox, oy = p2b(${obj.x}, ${obj.y})
    ow = max(${obj.w || 60}, 10) * SCALE
    od = max(${obj.h || 60}, 10) * SCALE
    rot = math.radians(${obj.rotation || 0})
    parent_obj = ${builderName}(ox, oy, ow, od, rot, ${idx})
    if parent_obj:
        if ${obj.flipH ? 'True' : 'False'}: parent_obj.scale.x *= -1
        if ${obj.flipV ? 'True' : 'False'}: parent_obj.scale.y *= -1
except Exception as e:
    print(f"[blender_scene] Error placing standard object ${idx}: {e}")
`;
        }
        scriptChunks.push({ idx, code: chunk });
      } else {
        // Custom object that needs AI rendering!
        customObjects.push({ obj, idx });
      }
    });

    if (customObjects.length > 0) {
      if (sessionId) sessionLog(sessionId, 'system', `🤖 Generating 3D shape breakdowns for ${customObjects.length} custom object(s)...`);

      const customObjectsToGenerate = customObjects.filter(({ obj }) => !obj.primitives || obj.primitives.length === 0);
      let primitivesMap = {};

      if (customObjectsToGenerate.length > 0) {
        try {
          const batchPrompt = `
You are an expert 3D interior designer and spatial planner.
We need to generate simplified 3D shape breakdowns (primitives) for the following custom objects in our scene layout:
${JSON.stringify(customObjectsToGenerate.map(({ obj }) => ({ id: obj.id, type: obj.type || 'custom', w: obj.w || 60, h: obj.h || 60 })), null, 2)}

Design style context: "${designBrief || 'No specific style'}"

For each custom object, your task is to break it down into a list of 2 to 8 basic 3D primitive shapes (cubes, cylinders, spheres) that represent it roughly but recognizably.
All coordinates, positions, and dimensions must be in METERS.
Local coordinate system:
- The origin (0, 0, 0) is the center of the object's footprint bounding box on the floor.
- Z = 0 is floor level (Z coordinate must be positive, representing height above floor).
- Sizes must fit roughly within the object's bounding box: width (X size), depth (Y size), height (Z size).

Format the output as a valid JSON object mapping each object's ID to its array of primitives. Format:
{
  "obj_id_1": [
    {
      "shape": "cube", // "cube", "cylinder", "sphere"
      "size": [width, depth, height], // size in meters. For cylinder: [radius, depth]. For sphere: [radius]
      "pos": [x, y, z], // local position in meters (z is height off floor)
      "rot": [rx, ry, rz], // local rotation in degrees (roll, pitch, yaw)
      "mat": "wood" // material: wood, steel, glass, ceramic, painted, foliage, stone, leather, fabric, marble
    }
  ]
}

Available materials: wood, steel, glass, ceramic, painted, foliage, stone, leather, fabric, marble, tile.
Output ONLY the valid raw JSON object. Do not include markdown \`\`\`json blocks. Do not explain your steps or write any other text.
`;

          const { code, stdout, stderr } = await runAgyCommand(batchPrompt, { sessionId, conversationId, logPrefix: 'blender-ai-primitives-batch' });
          if (checkForQuotaError(stdout, stderr, conversationId)) {
            return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
          }
          if (code !== 0) {
            throw new Error(`AI primitives generation failed. Stderr: ${stderr}`);
          }

          const tempDir = path.join(__dirname, 'temp_uploads');
          primitivesMap = extractJSON(stdout, tempDir) || {};
        } catch (err) {
          console.error("Batch primitives generation failed, falling back to generic boxes:", err);
        }
      }

      customObjects.forEach(({ obj, idx }) => {
        const prims = obj.primitives || primitivesMap[obj.id] || [];
        const chunk = `
# Custom Object idx=${idx} (${obj.id}: ${obj.type})
try:
    ox, oy = p2b(${obj.x}, ${obj.y})
    rot = math.radians(${obj.rotation || 0})
    primitives_json = """${JSON.stringify(prims)}"""
    primitives = json.loads(primitives_json)
    parent_obj = build_from_primitives(ox, oy, rot, ${idx}, "${obj.type}", primitives)
    if parent_obj:
        if ${obj.flipH ? 'True' : 'False'}: parent_obj.scale.x *= -1
        if ${obj.flipV ? 'True' : 'False'}: parent_obj.scale.y *= -1
except Exception as e:
    print(f"[blender_scene] Error placing custom primitives object ${idx}: {e}")
`;
        scriptChunks.push({ idx, code: chunk });
      });
    }

    // Sort script chunks by object index to maintain plan order
    scriptChunks.sort((a, b) => a.idx - b.idx);
    const aiPythonCode = scriptChunks.map(chunk => chunk.code).join('\n');

    if (objectsData && objectsData.length > 0 && (!aiPythonCode || aiPythonCode.length < 10)) {
      console.error('[blender-ai-render] AI generated code is empty or too short:', aiPythonCode);
      throw new Error('AI failed to generate a valid Blender scene script (empty response).');
    }

    // Load the base blender_scene.py
    const baseScriptPath = BLENDER_SCRIPT;
    const baseScriptContent = fs.readFileSync(baseScriptPath, 'utf8');

    // Split at marker
    const marker = '# === LIBRARY END ===';
    const parts = baseScriptContent.split(marker);
    if (parts.length < 2) {
      throw new Error("Could not find '# === LIBRARY END ===' marker in blender_scene.py");
    }

    const libraryCode = parts[0];

    // Combine library code with the AI generated placement/render code
    const combinedScript = `${libraryCode}

# ─── AI GENERATED CODE ───

${aiPythonCode}

# ─── Render Execution ───
scene.render.engine                     = 'CYCLES'
scene.cycles.device                     = 'CPU'
scene.cycles.samples                    = 16
scene.cycles.use_denoising             = True
scene.render.resolution_x               = 1280
scene.render.resolution_y               = 720
scene.render.resolution_percentage      = 100
scene.render.image_settings.file_format = 'JPEG'
scene.render.image_settings.quality     = 85
scene.render.filepath                   = output_path

print(f"[blender_scene] Rendering AI custom scene to {output_path}")
bpy.ops.render.render(write_still=True)
print("[blender_scene] Color render done.")

# ─── GLB Scene Export ───
glb_output_path = output_path.replace('.jpg', '.glb')
try:
    bpy.ops.export_scene.gltf(
        filepath=glb_output_path,
        export_format='GLB',
        export_apply=True,
        export_colors=True
    )
    print(f"[blender_scene] GLB exported → {glb_output_path}")
except Exception as e:
    print(f"[blender_scene] GLB export failed (non-fatal): {e}")

# ─── Depth Pass Render ───
depth_output_path = output_path.replace('.jpg', '_depth.png')
try:
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()

    rl = tree.nodes.new('CompositorNodeRLayers')
    normalize = tree.nodes.new('CompositorNodeNormalize')
    composite = tree.nodes.new('CompositorNodeComposite')

    tree.links.new(rl.outputs['Depth'], normalize.inputs[0])
    tree.links.new(normalize.outputs[0], composite.inputs[0])

    scene.cycles.samples = 1
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'BW'
    scene.render.image_settings.color_depth = '16'
    scene.render.filepath = depth_output_path

    bpy.ops.render.render(write_still=True)
    print(f"[blender_scene] Depth map rendered → {depth_output_path}")
except Exception as e:
    print(f"[blender_scene] Depth map render failed (non-fatal): {e}")

print("[blender_scene] Done.")
`;

    const jobId = crypto.randomBytes(6).toString('hex');
    const tempScriptPath = path.join(TMP_DIR, `blender_ai_${jobId}.py`);
    const outputPath = path.join(TMP_DIR, `cad_ai_render_${jobId}.jpg`);

    // Write combined script to temp file
    fs.writeFileSync(tempScriptPath, combinedScript, 'utf8');

    const sceneJson = JSON.stringify({
      walls:       wallsData   || [],
      corners:     cornersData || {},
      objects:     objectsData || [],
      camera:      cameraData  || {},
      floor_w:     floor_w     || 480,
      floor_h:     floor_h     || 1160,
      wall_height: wall_height || 250,
      wall_thick:  wall_thick  || 15,
      output_path: outputPath
    });

    console.log(`[blender-ai-render] Starting job ${jobId}, script: ${tempScriptPath}, output: ${outputPath}`);
    blenderBusy = true;

    if (sessionId) sessionLog(sessionId, 'system', '🔨 Running Blender to draw 3D view...');

    const blender = spawn(BLENDER_BIN, [
      '--background',
      '--python', tempScriptPath,
      '--', sceneJson
    ], { timeout: 60000 });

    let blenderStdout = '';
    let blenderStderr = '';
    blender.stdout.on('data', d => { blenderStdout += d; process.stdout.write('[blender-ai] ' + d); });
    blender.stderr.on('data', d => { blenderStderr += d; process.stderr.write('[blender-ai-err] ' + d); });

    blender.on('close', (exitCode) => {
      blenderBusy = false;
      // Clean up temp script
      try { fs.unlinkSync(tempScriptPath); } catch (e) {}

      if (exitCode !== 0) {
        console.error(`[blender-ai-render] Blender exited with code ${exitCode}`);
        console.error('[blender-ai-render] stderr:', blenderStderr);
        return res.status(500).json({ error: `Blender render failed (exit ${exitCode}).`, stderr: blenderStderr });
      }

      if (!fs.existsSync(outputPath)) {
        console.error(`[blender-ai-render] Output file not found. Stderr: ${blenderStderr}`);
        return res.status(500).json({ error: 'Blender finished but output file not found.', stderr: blenderStderr });
      }

      const imgBuffer = fs.readFileSync(outputPath);
      const b64 = imgBuffer.toString('base64');
      try { fs.unlinkSync(outputPath); } catch (e) {} // cleanup output

      // Read depth map if it exists
      const depthPath = outputPath.replace('.jpg', '_depth.png');
      let depthUrl = null;
      if (fs.existsSync(depthPath)) {
        const depthBuffer = fs.readFileSync(depthPath);
        depthUrl = `data:image/png;base64,${depthBuffer.toString('base64')}`;
        try { fs.unlinkSync(depthPath); } catch (e) {}
        console.log(`[blender-ai-render] Depth map included.`);
      }

      // Read GLB model if it exists
      const glbPath = outputPath.replace('.jpg', '.glb');
      let glbUrl = null;
      if (fs.existsSync(glbPath)) {
        const glbBuffer = fs.readFileSync(glbPath);
        glbUrl = `data:model/gltf-binary;base64,${glbBuffer.toString('base64')}`;
        try { fs.unlinkSync(glbPath); } catch (e) {}
        console.log(`[blender-ai-render] GLB model included.`);
      }

      console.log(`[blender-ai-render] Job ${jobId} done.`);
      if (sessionId) sessionLog(sessionId, 'system', '✅ 3D Preview layout generated successfully!');
      res.json({ imageUrl: `data:image/jpeg;base64,${b64}`, code: aiPythonCode, depthUrl, glbUrl });
    });

    blender.on('error', (err) => {
      blenderBusy = false;
      try { fs.unlinkSync(tempScriptPath); } catch (e) {}
      console.error('[blender-ai-render] Failed to start Blender:', err);
      res.status(500).json({ error: 'Failed to start Blender: ' + err.message });
    });

  } catch (error) {
    blenderBusy = false;
    console.error("Error in /blender-ai-render:", error);
    res.status(500).json({ error: error.message });
  }
});

// Blind AI Render (Text-Only) pipeline route
// Blind AI Render (Text-Only) Stage 1 route
app.post('/blind-render/stage1', async (req, res) => {
  let chatImageTempPath = null;
  try {
    const { chatImage, floorplan, objects, camera, designBrief, sessionId } = req.body;
    if (!chatImage) {
      return res.status(400).json({ error: 'Missing chatImage' });
    }
    const base64Data = chatImage.split(',')[1] || chatImage;
    const buffer = Buffer.from(base64Data, 'base64');
    chatImageTempPath = await saveBufferToTempFile(buffer, 'chat_2dplan', 'image/png');
    await resizeImageWithPython(chatImageTempPath);

    const tempDir = path.join(__dirname, 'temp_uploads');
    
    const stage1Prompt = `
Analyze the 2D floor plan blueprint image located at the absolute path: ${chatImageTempPath}
The camera position and orientation are described here:
Camera: ${JSON.stringify(camera || {})}
Floorplan geometry: ${JSON.stringify(floorplan || {})}
Identified objects in space: ${JSON.stringify(objects || [])}

${designBrief ? `Use this design brief/context to understand the nature, usability, functionality, and type of the space (e.g. restaurant, commercial dining, residential apartment) and guide your spatial identification:\n"${designBrief}"\n` : ''}

Generate a description of the space layout from the camera's perspective.
Identify exactly which walls, doors, windows, and furniture items are in the camera's line of sight (field of view).
Specify their exact relative positions (left, center, right) and distances (close, middle, far).
Pay special attention to aligned elements (e.g. "exactly 2 doors aligned on the same flat wall").

CRITICAL REQUIREMENT ON ROOM IDENTIFICATION:
Carefully identify the room behind each visible doorway. If a doorway leads into a Bathroom (as labeled on the floor plan, e.g. Door 28 / room next to living room), explicitly specify that it is a Bathroom and describe bathroom features (such as tiled walls, a vanity mirror, or a sink) visible through the doorway. Do NOT describe or place a bed or bedroom furniture inside a bathroom doorway. If it leads into a Bedroom, specify that it is a Bedroom and describe bedroom elements (such as a bed).

Output a structured JSON object matching this schema (do NOT include other text or explanations):
{
  "cameraPositionDescription": "description of camera location",
  "visibleWalls": "detailed description of walls in view",
  "visibleDoors": "exact count and position of doors/openings in view",
  "visibleWindows": "exact count and position of windows in view",
  "visibleFurniture": "detailed descriptions and numbers of furniture items in view",
  "spatialRelationships": "detailed layout of the space from left to right, close to far"
}

CRITICAL RULES FOR EFFICIENCY:
1. You are NOT allowed to execute terminal commands, run shell commands, or write/execute any Python scripts. Any attempt to write or execute code will be blocked or cause execution failure.
2. Use your native vision capability directly to inspect the image, perform all measurements/calculations internally, and output the final JSON in your first reply step.
3. Print the raw JSON object directly. Do NOT explain your steps or print anything else beside the JSON.
`;

    const stage1Result = await runAgyCommand(stage1Prompt, { sessionId, logPrefix: 'blind-s1' });
    if (checkForQuotaError(stage1Result.stdout, stage1Result.stderr)) {
      return res.status(429).json({ error: 'AI quota or rate limit reached. Please wait a few minutes and try again.', isQuotaError: true });
    }
    if (stage1Result.code !== 0) {
      throw new Error(`agy CLI exited with code ${stage1Result.code} at Stage 1. Stderr: ${stage1Result.stderr}`);
    }

    const stage1Json = extractJSON(stage1Result.stdout, tempDir);
    if (!stage1Json) {
      console.error(`[blind-s1] Failed to extract JSON from stdout:`, stage1Result.stdout);
      throw new Error('Failed to extract JSON in Stage 1.');
    }

    res.json({ stage1Json });
  } catch (error) {
    console.error("Error in blind-render Stage 1:", error);
    res.status(500).json({ error: error.message || "Internal server error." });
  } finally {
    if (chatImageTempPath && fs.existsSync(chatImageTempPath)) {
      try { fs.unlinkSync(chatImageTempPath); } catch (e) {}
    }
  }
});

// Blind AI Render (Text-Only) Stage 2 route
app.post('/blind-render/stage2', async (req, res) => {
  let screenshot3DTempPath = null;
  try {
    const { screenshot3d, stage1Json, designBrief, sessionId } = req.body;
    if (!screenshot3d) {
      return res.status(400).json({ error: 'Missing screenshot3d' });
    }
    const base64Data = screenshot3d.split(',')[1] || screenshot3d;
    const buffer = Buffer.from(base64Data, 'base64');
    screenshot3DTempPath = await saveBufferToTempFile(buffer, 'screenshot_threejs', 'image/png');
    await resizeImageWithPython(screenshot3DTempPath);

    const tempDir = path.join(__dirname, 'temp_uploads');

    const stage2Prompt = `
Compare the 3D interactive viewport screenshot located at the absolute path: ${screenshot3DTempPath}
with the following initial layout description:
${JSON.stringify(stage1Json, null, 2)}

Your task is to verify and refine this description. Ensure that:
1. The structural elements (number of doors, windows, walls, and alignments) match the 3D view EXACTLY. For example, if the 3D view shows exactly two doors aligned on the same flat wall, but the description says something else, correct the description to "exactly two doors on the same flat wall".
2. The furniture items match the 3D view.
3. If a doorway leads into a Bathroom (check the 2D floor plan labels and room names), ensure that the refined description and the final prompt specify that the view through this doorway reveals a clean bathroom interior (e.g. styled tiles, a vanity mirror, a sink, or neutral bathroom details) and does NOT contain a bed or bedroom furniture in that space.
4. ENCLOSED INTERIOR ONLY: The final prompt MUST describe a fully enclosed interior space. Do NOT generate isometric views, cutaway models, floating boxes, or grid-like flooring. The view must be from a camera positioned inside the space, with the floor, walls, and ceiling fully bounding the frame as a realistic indoor room (e.g., "a photorealistic wide-angle interior photograph...").
5. Generate a final detailed prompt for a text-to-image generator (like Imagen) to draw this scene. The prompt must be hyper-detailed, describing materials, lighting, style, and layout, but strictly locking the structure (e.g. 'a photorealistic interior shot of a room with exactly two doors on the same white wall, a counter on the left...').
6. PLACE TYPE & FUNCTIONAL INTEGRITY: Make the generated image prompt highly aware of the type, purpose, usability, and functionality of the space (e.g. commercial restaurant/bar/cafe vs. residential room/kitchen) from the design brief or object layouts:
   - If it is a restaurant or commercial dining space:
     - The roofing/ceiling must fit the restaurant nature. Specify a commercial-style ceiling, such as "a modern commercial ceiling with exposed painted ductwork, matte black industrial piping, acoustic panels, and minimalist black track lighting" or "a clean contemporary tray ceiling with recessed architectural spotlights and warm wood paneled accents". Do NOT describe a cozy residential drywall ceiling.
     - The chairs/seating must match commercial usability. Specify commercial-grade seating suitable for a public dining space, such as "sturdy low-back restaurant bar stools with footrests made of black steel and dark oak wood at the counter" or "sleek modern cafe dining chairs that align correctly with the counter and table height". Do NOT place domestic/cozy residential armchairs, desk chairs, or basic stools.
     - The tables, countertops, and floor materials must match a high-durability public space (e.g. polished concrete, industrial hardwood planks, luxury terrazzo).

${designBrief ? `Apply the style, materials and mood specified in this design brief:\n"${designBrief}"\n` : ''}

Output a refined JSON object matching this schema (do NOT include other text or explanations):
{
  "correctionsMade": "what corrections were made",
  "finalDescription": "refined spatial layout description",
  "imagenPrompt": "final hyper-detailed prompt for image generation, locking the layout geometry"
}

CRITICAL RULES FOR EFFICIENCY:
1. You are NOT allowed to execute terminal commands, run shell commands, or write/execute any Python scripts. Any attempt to write or execute code will be blocked or cause execution failure.
2. Use your native vision capability directly to inspect the image, perform all measurements/calculations internally, and output the final JSON in your first reply step.
3. Print the raw JSON object directly. Do NOT explain your steps or print anything else beside the JSON.
`;

    const stage2Result = await runAgyCommand(stage2Prompt, { sessionId, logPrefix: 'blind-s2' });
    if (stage2Result.code !== 0) {
      throw new Error(`agy CLI exited with code ${stage2Result.code} at Stage 2. Stderr: ${stage2Result.stderr}`);
    }

    const stage2Json = extractJSON(stage2Result.stdout, tempDir);
    if (!stage2Json) {
      console.error(`[blind-s2] Failed to extract JSON from stdout:`, stage2Result.stdout);
      throw new Error('Failed to extract JSON in Stage 2.');
    }

    res.json({ stage2Json });
  } catch (error) {
    console.error("Error in blind-render Stage 2:", error);
    res.status(500).json({ error: error.message || "Internal server error." });
  } finally {
    if (screenshot3DTempPath && fs.existsSync(screenshot3DTempPath)) {
      try { fs.unlinkSync(screenshot3DTempPath); } catch (e) {}
    }
  }
});

// Blind AI Render (Text-Only) Stage 3 route
app.post('/blind-render/stage3', async (req, res) => {
  try {
    const { stage2Json, sessionId } = req.body;
    if (!stage2Json || !stage2Json.imagenPrompt) {
      return res.status(400).json({ error: 'Missing stage2Json or imagenPrompt' });
    }

    const stage3Prompt = `Generate a photorealistic 3D render using the generate_image tool.
Use this text prompt: "${stage2Json.imagenPrompt}".
Do NOT pass any reference image paths in the ImagePaths parameter. The image must be generated blindly based ONLY on the text prompt.
Return ONLY the markdown link to the generated image file, do not include any other text.`;

    const stage3Result = await runAgyCommand(stage3Prompt, { sessionId, logPrefix: 'blind-s3' });
    const match = stage3Result.stdout.match(/(?:file:\/\/|file:)?(\/[^\s\)]+)/);
    let imageUrl = null;
    if (match) {
      const generatedFilePath = match[1];
      if (fs.existsSync(generatedFilePath)) {
        const imgBuffer = fs.readFileSync(generatedFilePath);
        imageUrl = `data:image/jpeg;base64,${imgBuffer.toString('base64')}`;
        fs.unlinkSync(generatedFilePath);
        console.log("Blind Imagen render generated successfully.");
      }
    } else {
      console.warn("Failed to find image path in stage 3 agy output:", stage3Result.stdout);
      throw new Error("Failed to generate image.");
    }

    res.json({ imageUrl });
  } catch (error) {
    console.error("Error in blind-render Stage 3:", error);
    res.status(500).json({ error: error.message || "Internal server error." });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: "ok", systemAgyConfigured: true, blenderBusy, activeSessions: sessions.size });
});

// ─── Session Init ─────────────────────────────────────────────────────────────
// POST /session/init — fires a "hi" handshake to agy, captures the generated UUID
app.post('/session/init', async (req, res) => {
  try {
    const beforeMs = Date.now() - 2000; // scan for dirs created just before we start
    sessionLog('pre', 'system', 'Initializing new AI session...');

    const { code, stdout, stderr } = await runAgyCommand(
      'This is a headless assistant session initialisation. Just say "hi" in your reply — nothing else.',
      { logPrefix: 'session-init' }
    );

    // Give agy a moment to flush the brain dir
    await new Promise(r => setTimeout(r, 800));

    const convUUID = findNewestBrainDir(beforeMs);

    // Check for rate limit/overload error
    if (checkForQuotaError(stdout, stderr, convUUID)) {
      console.error('[session/init] Quota/rate-limit error detected during session init');
      return res.status(429).json({ error: 'AI quota or rate limit reached. The Google Gemini API is currently overloaded. Please wait a few minutes and try again.', isQuotaError: true });
    }

    if (!convUUID) {
      console.warn('[session/init] Could not auto-detect conversation UUID. Will proceed without session pinning.');
    }

    const sessionId = 'cad-' + crypto.randomBytes(4).toString('hex');
    sessions.set(sessionId, { conversationUUID: convUUID || null, sseClients: [] });

    console.log(`[session/init] New session: ${sessionId} -> conv UUID: ${convUUID}`);
    res.json({ sessionId, conversationUUID: convUUID, reply: stdout.trim() });
  } catch (err) {
    console.error('[session/init] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Session SSE Log Stream ────────────────────────────────────────────────────
// GET /session/logs/:sessionId — SSE stream for real-time progress
app.get('/session/logs/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const sess = sessions.get(sessionId);
  if (!sess) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'system', text: '🔌 Log stream connected', ts: Date.now() })}\n\n`);

  sess.sseClients.push(res);

  req.on('close', () => {
    if (sessions.has(sessionId)) {
      sessions.get(sessionId).sseClients = sessions.get(sessionId).sseClients.filter(c => c !== res);
    }
  });
});

// ─── Session Wipe ─────────────────────────────────────────────────────────────
// DELETE /session/:sessionId — safely deletes only this session's brain JSONL files
app.delete('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const sess = sessions.get(sessionId);
  if (!sess) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const { conversationUUID } = sess;
  let deleted = [];
  let errors = [];

  if (conversationUUID) {
    const brainSessionDir = path.join(AGY_BRAIN_DIR, conversationUUID);
    if (fs.existsSync(brainSessionDir)) {
      // Only delete JSONL transcript files, not images/artifacts
      const logsDir = path.join(brainSessionDir, '.system_generated', 'logs');
      const targets = [
        path.join(brainSessionDir, 'conversation.jsonl'),
        path.join(brainSessionDir, '.system_generated', 'conversation.jsonl'),
      ];
      if (fs.existsSync(logsDir)) {
        try {
          fs.readdirSync(logsDir)
            .filter(f => f.endsWith('.jsonl'))
            .forEach(f => targets.push(path.join(logsDir, f)));
        } catch (e) {}
      }
      for (const target of targets) {
        if (fs.existsSync(target)) {
          try {
            fs.unlinkSync(target);
            deleted.push(target);
            console.log(`[session/wipe] Deleted: ${target}`);
          } catch (e) {
            errors.push(target + ': ' + e.message);
          }
        }
      }
    }
  }

  // Close any SSE clients
  sess.sseClients.forEach(c => { try { c.end(); } catch (e) {} });
  sessions.delete(sessionId);

  res.json({ ok: true, sessionId, conversationUUID, deleted, errors });
});

// ─── Saved Sessions Store ──────────────────────────────────────────────────────
const SAVED_SESSIONS_DIR = path.join(__dirname, 'saved_sessions');
if (!fs.existsSync(SAVED_SESSIONS_DIR)) {
  fs.mkdirSync(SAVED_SESSIONS_DIR, { recursive: true });
}

// POST /session/save — saves full floorplan, objects, cameras, scale, and image state
app.post('/session/save', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const { sessionId, state } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }
    const sessionFile = path.join(SAVED_SESSIONS_DIR, `${sessionId}.json`);
    fs.writeFileSync(sessionFile, JSON.stringify({
      updatedAt: Date.now(),
      state: state
    }, null, 2));
    console.log(`[session/save] Saved session ${sessionId}`);
    res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('[session/save] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /session/load/:sessionId — loads a previously saved session state
// Also re-registers the session in memory and spawns a fresh AI conversation
app.get('/session/load/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionFile = path.join(SAVED_SESSIONS_DIR, `${sessionId}.json`);
    if (!fs.existsSync(sessionFile)) {
      return res.status(404).json({ error: `Saved session ${sessionId} not found.` });
    }
    const content = fs.readFileSync(sessionFile, 'utf8');
    const data = JSON.parse(content);

    // Re-register this session in-memory so SSE logs and chat work
    if (!sessions.has(sessionId)) {
      console.log(`[session/load] Re-registering session ${sessionId} in memory`);

      // Spawn a fresh AI conversation for context continuity
      const beforeMs = Date.now() - 2000;
      try {
        await runAgyCommand(
          'This is a restored session handshake. Just say "hi" in your reply — nothing else.',
          { logPrefix: 'session-restore' }
        );
        await new Promise(r => setTimeout(r, 800));
        const convUUID = findNewestBrainDir(beforeMs);
        sessions.set(sessionId, { conversationUUID: convUUID || null, sseClients: [] });
        console.log(`[session/load] Session ${sessionId} re-registered with conv UUID: ${convUUID}`);
        data.conversationUUID = convUUID;
      } catch (initErr) {
        // Even if conversation init fails, register session so SSE works
        console.error(`[session/load] Conversation init failed, registering without conv:`, initErr.message);
        sessions.set(sessionId, { conversationUUID: null, sseClients: [] });
      }
    } else {
      console.log(`[session/load] Session ${sessionId} already in memory`);
      data.conversationUUID = sessions.get(sessionId).conversationUUID;
    }

    res.json(data);
  } catch (err) {
    console.error('[session/load] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /session/saved-list — lists all saved sessions
app.get('/session/saved-list', async (req, res) => {
  try {
    if (!fs.existsSync(SAVED_SESSIONS_DIR)) {
      return res.json({ sessions: [] });
    }
    const files = fs.readdirSync(SAVED_SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(SAVED_SESSIONS_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          sessionId: f.replace('.json', ''),
          updatedAt: stat.mtimeMs
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    res.json({ sessions: files });
  } catch (err) {
    console.error('[session/saved-list] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /session/saved/:sessionId — deletes a saved session
app.delete('/session/saved/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionFile = path.join(SAVED_SESSIONS_DIR, `${sessionId}.json`);
    if (fs.existsSync(sessionFile)) {
      fs.unlinkSync(sessionFile);
      console.log(`[session/delete] Deleted saved session ${sessionId}`);
    }
    res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('[session/delete] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, '127.0.0.1', () => {
  console.log(`CAD backend listening at http://127.0.0.1:${port}`);
});
