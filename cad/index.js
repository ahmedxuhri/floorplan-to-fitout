import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ─── Custom UI Toast Notification System ──────────────────────────────────
function showToast(message, type = 'info', duration = 4500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = {
    error: '❌',
    warning: '⚠️',
    success: '✅',
    info: 'ℹ️'
  };

  const toast = document.createElement('div');
  const toastType = ['error', 'warning', 'success', 'info'].includes(type) ? type : 'info';
  toast.className = `custom-toast toast-${toastType}`;

  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.textContent = icons[toastType] || 'ℹ️';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'toast-content';
  contentDiv.textContent = String(message || '');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = () => removeToast(toast);

  toast.appendChild(iconSpan);
  toast.appendChild(contentDiv);
  toast.appendChild(closeBtn);

  container.appendChild(toast);

  const timer = setTimeout(() => removeToast(toast), duration);

  function removeToast(t) {
    clearTimeout(timer);
    t.classList.add('toast-hiding');
    setTimeout(() => {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 250);
  }
}

// Override native browser alert to use custom UI toast
window.alert = function(message) {
  const msgStr = String(message || '');
  let type = 'info';
  if (msgStr.toLowerCase().includes('failed') || msgStr.toLowerCase().includes('error')) {
    type = 'error';
  } else if (msgStr.toLowerCase().includes('success') || msgStr.toLowerCase().includes('saved') || msgStr.toLowerCase().includes('restored')) {
    type = 'success';
  } else if (msgStr.toLowerCase().includes('first') || msgStr.toLowerCase().includes('please') || msgStr.toLowerCase().includes('draw')) {
    type = 'warning';
  }
  showToast(msgStr, type);
};

// ─── State Variables ─────────────────────────────────────────────────────────
let loadedBlenderGLB = null; // Stores high-fidelity glTF/GLB scene imported from Blender
let corners = {};
let walls   = [];
let identifiedObjects = []; // [{ id, x, y, w, h, typeGuess, label, referenceDescription, rotation }]
let cameraPositions   = []; // [{ id, x, y, angle, label }]
let selectedCamera    = null; // id of selected camera pin

let pipelineMode = 'cad'; // 'cad' | 'photo'
let photoFile = null;
let photoImage = null;
let annotationStrokes = []; // [{ type, color, size, points: [{x, y}, ...] }]
let currentStroke = null;
let isDrawingAnnotation = false;
let activeMarkupTool = 'free'; // 'free' | 'dashed' | 'circle' | 'shade'
let activeMarkupColor = '#ef4444';
let activeMarkupSize = 8;

let selectedCorner   = null;
let isDragging       = false;
let selectedWallIndex = -1;
let isDraggingWall = false;
let dragWallStartOffset = { x: 0, y: 0 };
let dragWallCorner1Start = { x: 0, y: 0 };
let dragWallCorner2Start = { x: 0, y: 0 };
let drawingStartCorner = null;
let tempMousePos     = { x: 0, y: 0 };
let activeTool       = 'select'; // 'select' | 'draw' | 'delete' | 'camera'
let viewMode         = 'split';

// Scale calibration (metres)
let calibrateWidth  = 4.80;
let calibrateHeight = 11.60;

// 3D customization (cm)
let wallHeight    = 250;
let wallThickness = 15;
let wallColor     = '#e2e8f0';
let showCeiling   = false;

// Uploaded template image
let templateImage        = null;
let templateImageOpacity = 0.5;
let uploadedFile         = null; // keep file reference for identify step
let templateImageBase64  = null; // base64 representation of template floorplan image

// 2D editor scale/pan
let screenScale = 1;
let offsetX     = 0;
let offsetY     = 0;
let isPanning   = false;
let startPanX   = 0;
let startPanY   = 0;

// Chat state
let chatHistory = [];
let lastBlenderRender = null; // base64 data URL of last Blender render (NEVER overwritten with AI output)
let lastAIRender = null;      // base64 data URL of last AI-generated render
let lastDepthMap = null;      // base64 data URL of last Blender depth map
let styleAnchor = null;       // extracted style description from first AI render for consistency
let chatAttachedImageBase64 = null; // base64 representation of attached reference image for chat

// Session state (persistent AI conversation)
let sessionId = null;       // short ID like 'cad-a1b2c3d4'
let sseEventSource = null;  // SSEEventSource for log stream
let sessionInitializing = false;

let selectedObjectIndex = -1;
let isDraggingObject = false;
let dragObjectOffset = { x: 0, y: 0 };
let objectGroup;
let drawingObjectPoints = [];

// ─── UI Elements ─────────────────────────────────────────────────────────────
const dropZone       = document.getElementById('drop-zone');
const fileInput      = document.getElementById('file-input');
const fileInfo       = document.getElementById('file-info');
const fileNameSpan   = document.getElementById('file-name');
const removeFileBtn  = document.getElementById('remove-file-btn');
const aiBtn          = document.getElementById('ai-btn');
const skipTraceCheckbox = document.getElementById('skip-trace-checkbox');
const identifyBtn    = document.getElementById('identify-btn');
const aiBlenderPreviewBtn = document.getElementById('ai-blender-preview-btn');
const setCameraBtn   = document.getElementById('set-camera-btn');
const blenderRenderBtn = document.getElementById('blender-render-btn');
const blindRenderBtn   = document.getElementById('blind-render-btn');
const autoScanBtn      = document.getElementById('auto-scan-btn');
const tabThree = document.getElementById('tab-three');
const tabBlender = document.getElementById('tab-blender');
const viewer3dContainer = document.getElementById('viewer-3d-container');
const blenderPreviewContainer = document.getElementById('blender-preview-container');
const blenderPreviewImg = document.getElementById('blender-preview-img');
const blenderPreviewPlaceholder = document.getElementById('blender-preview-placeholder');
const pipelineStatus = document.getElementById('pipeline-status');
const pipelineStatusText = document.getElementById('pipeline-status-text');

const toolSelect  = document.getElementById('tool-select');
const toolDraw    = document.getElementById('tool-draw');
const toolDelete  = document.getElementById('tool-delete');
const toolCamera  = document.getElementById('tool-camera');

const widthInput   = document.getElementById('width-input');
const heightInput  = document.getElementById('height-input');
const scaleApplyBtn = document.getElementById('scale-apply-btn');

const wallHeightInput    = document.getElementById('wall-height');
const wallThicknessInput = document.getElementById('wall-thickness');
const wallColorInput     = document.getElementById('wall-color');
const colorHex           = document.getElementById('color-hex');

const exportBtn        = document.getElementById('export-btn');
const importBtnTrigger = document.getElementById('import-btn-trigger');
const importInput      = document.getElementById('import-input');

const viewSplit  = document.getElementById('view-split');
const view2d     = document.getElementById('view-2d');
const view3d     = document.getElementById('view-3d');
const viewObjects = document.getElementById('view-objects');
const viewAi     = document.getElementById('view-ai');
const viewportsGrid = document.getElementById('viewports-grid');
const fpsBtn     = document.getElementById('fps-btn');

const zoomInBtn  = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const zoomFitBtn = document.getElementById('zoom-fit-btn');

const canvas2D = document.getElementById('canvas-2d');
const ctx2D    = canvas2D.getContext('2d');

const scannerOverlay  = document.getElementById('scanner-overlay');
const walkInstructions = document.getElementById('walk-instructions');

const cardAi     = document.getElementById('card-ai');
const cardObjects = document.getElementById('card-objects');
const cardChat   = document.getElementById('card-chat');

const aiRenderImg         = document.getElementById('ai-render-img');
const aiRenderPlaceholder = document.getElementById('ai-render-placeholder');
const renderLoading       = document.getElementById('render-loading');
const renderLoadingText   = document.getElementById('render-loading-text');
const renderProgressFill  = document.getElementById('render-progress-fill');
const regenerateBtn       = document.getElementById('regenerate-btn');
const downloadRenderBtn   = document.getElementById('download-render-btn');

const modeCadBtn         = document.getElementById('mode-cad-btn');
const modePhotoBtn       = document.getElementById('mode-photo-btn');
const photoDropZone      = document.getElementById('photo-drop-zone');
const photoFileInput     = document.getElementById('photo-file-input');
const photoFileInfo      = document.getElementById('photo-file-info');
const photoFileName      = document.getElementById('photo-file-name');
const removePhotoBtn     = document.getElementById('remove-photo-btn');
const photoGenerateBtn   = document.getElementById('photo-generate-btn');
const annotationCanvas   = document.getElementById('annotation-canvas');
const brushSizeInput     = document.getElementById('brush-size');
const initialPromptInput = document.getElementById('initial-prompt-input');
const initialPromptGroup = document.getElementById('initial-prompt-group');
const cadDesignBrief     = document.getElementById('cad-design-brief');

const wipeSessionBtn    = document.getElementById('wipe-session-btn');
const saveSessionBtn    = document.getElementById('save-session-btn');
const loadSessionBtn    = document.getElementById('load-session-btn');
const sessionsModal     = document.getElementById('sessions-modal');
const closeModalBtn     = document.getElementById('close-modal-btn');
const sessionsList      = document.getElementById('sessions-list');

const objectLibrary     = document.getElementById('object-library');
const confirmObjectsBtn = document.getElementById('confirm-objects-btn');

const cameraList              = document.getElementById('camera-list');
const cameraPositionsSection  = document.getElementById('camera-positions-section');

const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');
const chatSendBtn  = document.getElementById('chat-send-btn');
const chatImageInput = document.getElementById('chat-image-input');
const chatAttachBtn  = document.getElementById('chat-attach-btn');
const chatAttachmentPreview = document.getElementById('chat-attachment-preview');
const chatPreviewThumbnail  = document.getElementById('chat-preview-thumbnail');
const chatPreviewFilename   = document.getElementById('chat-preview-filename');
const chatRemoveAttachment  = document.getElementById('chat-remove-attachment');

// ─── Three.js Setup ───────────────────────────────────────────────────────────
let scene, camera, renderer, controls;
let wallGroup, floorMesh, ceilingMesh;
let fpsActive     = false;
let moveForward   = false, moveBackward = false, moveLeft = false, moveRight = false;
let prevTime      = performance.now();
const velocity    = new THREE.Vector3();
const direction   = new THREE.Vector3();
const playerHeight = 160;

function init3D() {
  const container = document.getElementById('viewer-3d-container');
  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0b0f19');

  camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 1, 5000);
  camera.position.set(0, 400, 600);

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.01;
  controls.minDistance = 50;
  controls.maxDistance = 2000;

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
  scene.add(ambientLight);

  const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.7);
  dirLight1.position.set(200, 400, 100);
  dirLight1.castShadow = true;
  dirLight1.shadow.mapSize.width = 2048;
  dirLight1.shadow.mapSize.height = 2048;
  const d = 500;
  dirLight1.shadow.camera.left = -d; dirLight1.shadow.camera.right = d;
  dirLight1.shadow.camera.top  =  d; dirLight1.shadow.camera.bottom = -d;
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x0ea5e9, 0.2);
  dirLight2.position.set(-200, 200, -100);
  scene.add(dirLight2);

  const gridHelper = new THREE.GridHelper(2000, 50, 0x334155, 0x1e293b);
  gridHelper.position.y = -0.5;
  scene.add(gridHelper);

  wallGroup = new THREE.Group();
  scene.add(wallGroup);

  objectGroup = new THREE.Group();
  scene.add(objectGroup);

  window.addEventListener('resize', onWindowResize);
  animate();
}

function onWindowResize() {
  const container = document.getElementById('viewer-3d-container');
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  resize2DCanvas();
}

function animate() {
  requestAnimationFrame(animate);
  if (fpsActive) handleWalkMode();
  else controls.update();
  renderer.render(scene, camera);
}

// ─── 2D Editor ───────────────────────────────────────────────────────────────
function resize2DCanvas() {
  const rect = canvas2D.parentElement.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    canvas2D.width  = rect.width;
    canvas2D.height = rect.height;
    resetViewOffset();
    draw2D();
  }
}

function resetViewOffset() {
  const canvasW = canvas2D.width;
  const canvasH = canvas2D.height;
  const designW = calibrateWidth * 100;
  const designH = calibrateHeight * 100;
  const padding = 60;
  const scaleX  = (canvasW - padding * 2) / designW;
  const scaleY  = (canvasH - padding * 2) / designH;
  screenScale   = Math.min(scaleX, scaleY);
  offsetX = (canvasW - designW * screenScale) / 2;
  offsetY = (canvasH - designH * screenScale) / 2;
}

function zoomAtCenter(factor) {
  const centerX = canvas2D.width / 2;
  const centerY = canvas2D.height / 2;
  const realPos = screenToReal(centerX, centerY);

  const newScale = Math.min(Math.max(screenScale * factor, 0.05), 100);
  screenScale = newScale;

  offsetX = centerX - realPos.x * screenScale;
  offsetY = centerY - realPos.y * screenScale;

  draw2D();
}

function screenToReal(x, y) {
  return { x: (x - offsetX) / screenScale, y: (y - offsetY) / screenScale };
}
function realToScreen(x, y) {
  return { x: x * screenScale + offsetX, y: y * screenScale + offsetY };
}

// ─── 2D Draw ─────────────────────────────────────────────────────────────────
function draw2D() {
  ctx2D.clearRect(0, 0, canvas2D.width, canvas2D.height);

  // 1. Template image background
  if (templateImage) {
    const designW = calibrateWidth * 100 * screenScale;
    const designH = calibrateHeight * 100 * screenScale;
    ctx2D.save();
    ctx2D.globalAlpha = templateImageOpacity;
    ctx2D.drawImage(templateImage, offsetX, offsetY, designW, designH);
    ctx2D.restore();
  } else {
    const designW = calibrateWidth * 100 * screenScale;
    const designH = calibrateHeight * 100 * screenScale;
    ctx2D.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx2D.setLineDash([5, 5]);
    ctx2D.strokeRect(offsetX, offsetY, designW, designH);
    ctx2D.setLineDash([]);
  }

  // 2. Walls
  walls.forEach(wall => {
    const c1 = corners[wall.corner1];
    const c2 = corners[wall.corner2];
    if (!c1 || !c2) return;
    const s1 = realToScreen(c1.x, c1.y);
    const s2 = realToScreen(c2.x, c2.y);
    ctx2D.strokeStyle = '#0ea5e9';
    ctx2D.lineWidth = Math.max(3, wallThickness * screenScale);
    ctx2D.lineCap = 'round';
    ctx2D.beginPath(); ctx2D.moveTo(s1.x, s1.y); ctx2D.lineTo(s2.x, s2.y);
    ctx2D.stroke();
    ctx2D.strokeStyle = '#f8fafc'; ctx2D.lineWidth = 1.5;
    ctx2D.beginPath(); ctx2D.moveTo(s1.x, s1.y); ctx2D.lineTo(s2.x, s2.y);
    ctx2D.stroke();
  });

  // 3. Draw-mode preview line
  if (activeTool === 'draw' && drawingStartCorner) {
    const cStart = corners[drawingStartCorner];
    const sStart = realToScreen(cStart.x, cStart.y);
    const sTemp  = realToScreen(tempMousePos.x, tempMousePos.y);
    ctx2D.strokeStyle = 'rgba(139,92,246,0.8)';
    ctx2D.lineWidth = Math.max(3, wallThickness * screenScale);
    ctx2D.setLineDash([6, 4]);
    ctx2D.beginPath(); ctx2D.moveTo(sStart.x, sStart.y); ctx2D.lineTo(sTemp.x, sTemp.y);
    ctx2D.stroke(); ctx2D.setLineDash([]);
  }

  // 4. Object bounding boxes and circles (identified)
  identifiedObjects.forEach((obj, idx) => {
    const sp = realToScreen(obj.x, obj.y);
    const r  = Math.max(10, (Math.min(obj.w || 40, obj.h || 40) / 2) * screenScale);
    const isSelected = (idx === selectedObjectIndex);

    // Draw bounding box / custom polygon
    const wReal = obj.w || 60;
    const hReal = obj.h || 60;
    const wScreen = wReal * screenScale;
    const hScreen = hReal * screenScale;

    if (obj.shape === 'polygon' && obj.points && obj.points.length >= 3) {
      ctx2D.save();
      ctx2D.translate(sp.x, sp.y);
      ctx2D.scale(obj.flipH ? -1 : 1, obj.flipV ? -1 : 1);
      ctx2D.strokeStyle = isSelected ? '#ef4444' : '#fb923c';
      ctx2D.lineWidth = isSelected ? 2.5 : 1.2;
      ctx2D.setLineDash([4, 4]);
      ctx2D.beginPath();
      const startPtX = (obj.points[0].x - obj.x) * screenScale;
      const startPtY = (obj.points[0].y - obj.y) * screenScale;
      ctx2D.moveTo(startPtX, startPtY);
      for (let i = 1; i < obj.points.length; i++) {
        const ptX = (obj.points[i].x - obj.x) * screenScale;
        const ptY = (obj.points[i].y - obj.y) * screenScale;
        ctx2D.lineTo(ptX, ptY);
      }
      ctx2D.closePath();
      ctx2D.stroke();
      ctx2D.restore();
    } else if (obj.shape === 'l-shape') {
      ctx2D.save();
      ctx2D.translate(sp.x, sp.y);
      ctx2D.rotate((obj.rotation || 0) * Math.PI / 180);
      ctx2D.scale(obj.flipH ? -1 : 1, obj.flipV ? -1 : 1);
      ctx2D.strokeStyle = isSelected ? '#ef4444' : '#fb923c';
      ctx2D.lineWidth = isSelected ? 2.5 : 1.2;
      ctx2D.setLineDash([4, 4]);
      const t = (obj.legThickness || 40) * screenScale;
      ctx2D.beginPath();
      ctx2D.moveTo(-wScreen / 2, -hScreen / 2);
      ctx2D.lineTo(wScreen / 2, -hScreen / 2);
      ctx2D.lineTo(wScreen / 2, -hScreen / 2 + t);
      ctx2D.lineTo(-wScreen / 2 + t, -hScreen / 2 + t);
      ctx2D.lineTo(-wScreen / 2 + t, hScreen / 2);
      ctx2D.lineTo(-wScreen / 2, hScreen / 2);
      ctx2D.closePath();
      ctx2D.stroke();
      ctx2D.restore();
    } else {
      ctx2D.save();
      ctx2D.translate(sp.x, sp.y);
      ctx2D.rotate((obj.rotation || 0) * Math.PI / 180);
      ctx2D.scale(obj.flipH ? -1 : 1, obj.flipV ? -1 : 1);
      ctx2D.strokeStyle = isSelected ? '#ef4444' : '#fb923c';
      ctx2D.lineWidth = isSelected ? 2.5 : 1.2;
      ctx2D.setLineDash([4, 4]);
      ctx2D.strokeRect(-wScreen / 2, -hScreen / 2, wScreen, hScreen);
      ctx2D.restore();
    }

    // Draw central node/circle
    ctx2D.beginPath();
    ctx2D.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx2D.fillStyle   = isSelected ? 'rgba(239,68,68,0.35)' : 'rgba(251,146,60,0.25)';
    ctx2D.strokeStyle = isSelected ? '#ef4444' : '#fb923c';
    ctx2D.lineWidth   = isSelected ? 2.5 : 2;
    ctx2D.fill();
    ctx2D.stroke();

    // Number label
    ctx2D.fillStyle  = '#fff';
    ctx2D.font       = `bold ${Math.max(10, r * 0.9)}px Inter, sans-serif`;
    ctx2D.textAlign  = 'center';
    ctx2D.textBaseline = 'middle';
    ctx2D.fillText(idx + 1, sp.x, sp.y);
    ctx2D.textAlign  = 'left';
    ctx2D.textBaseline = 'alphabetic';
  });

  // 5. Camera pins
  cameraPositions.forEach((cam, idx) => {
    const sp = realToScreen(cam.x, cam.y);
    const angle = (cam.angle || 0) * Math.PI / 180;
    const arrowLen = 28;
    // Pin circle
    ctx2D.beginPath();
    ctx2D.arc(sp.x, sp.y, 9, 0, Math.PI * 2);
    ctx2D.fillStyle   = selectedCamera === cam.id ? '#22c55e' : '#16a34a';
    ctx2D.strokeStyle = '#bbf7d0';
    ctx2D.lineWidth   = 2;
    ctx2D.fill(); ctx2D.stroke();
    // Direction arrow
    const ax = sp.x + Math.sin(angle) * arrowLen;
    const ay = sp.y - Math.cos(angle) * arrowLen;
    ctx2D.strokeStyle = '#4ade80';
    ctx2D.lineWidth   = 2.5;
    ctx2D.beginPath(); ctx2D.moveTo(sp.x, sp.y); ctx2D.lineTo(ax, ay); ctx2D.stroke();
    // Arrowhead
    const headLen = 8;
    const headAngle = 0.4;
    ctx2D.beginPath();
    ctx2D.moveTo(ax, ay);
    ctx2D.lineTo(ax - headLen * Math.sin(angle - headAngle), ay + headLen * Math.cos(angle - headAngle));
    ctx2D.moveTo(ax, ay);
    ctx2D.lineTo(ax - headLen * Math.sin(angle + headAngle), ay + headLen * Math.cos(angle + headAngle));
    ctx2D.stroke();
    // Label
    ctx2D.fillStyle = '#4ade80';
    ctx2D.font = 'bold 11px Inter, sans-serif';
    ctx2D.fillText(`C${idx + 1}`, sp.x + 11, sp.y - 9);
  });

  // 6. Corner handles
  Object.keys(corners).forEach(id => {
    const corner   = corners[id];
    const screenPos = realToScreen(corner.x, corner.y);
    ctx2D.fillStyle   = selectedCorner === id ? '#8b5cf6' : '#0ea5e9';
    ctx2D.strokeStyle = '#f8fafc';
    ctx2D.lineWidth   = 2;
    ctx2D.beginPath();
    ctx2D.arc(screenPos.x, screenPos.y, 7, 0, Math.PI * 2);
    ctx2D.fill(); ctx2D.stroke();
    ctx2D.fillStyle  = '#64748b';
    ctx2D.font       = '9px monospace';
    ctx2D.fillText(`${Math.round(corner.x)},${Math.round(corner.y)}`, screenPos.x + 10, screenPos.y - 10);
  });

  // Draw custom object shape drawing preview
  if (activeTool === 'draw-object-shape' && drawingObjectPoints.length > 0) {
    ctx2D.strokeStyle = '#8b5cf6';
    ctx2D.lineWidth = 2.5;
    ctx2D.beginPath();
    const sStart = realToScreen(drawingObjectPoints[0].x, drawingObjectPoints[0].y);
    ctx2D.moveTo(sStart.x, sStart.y);
    for (let i = 1; i < drawingObjectPoints.length; i++) {
      const sPt = realToScreen(drawingObjectPoints[i].x, drawingObjectPoints[i].y);
      ctx2D.lineTo(sPt.x, sPt.y);
    }
    const sMouse = realToScreen(tempMousePos.x, tempMousePos.y);
    ctx2D.lineTo(sMouse.x, sMouse.y);
    ctx2D.stroke();

    // Draw vertex handles
    drawingObjectPoints.forEach((pt, idx) => {
      const sPt = realToScreen(pt.x, pt.y);
      ctx2D.beginPath();
      ctx2D.arc(sPt.x, sPt.y, 5, 0, Math.PI * 2);
      ctx2D.fillStyle = '#c084fc';
      ctx2D.strokeStyle = '#8b5cf6';
      ctx2D.lineWidth = 1.5;
      ctx2D.fill();
      ctx2D.stroke();
      
      ctx2D.fillStyle = '#c084fc';
      ctx2D.font = '9px monospace';
      ctx2D.fillText(`${idx + 1}`, sPt.x + 8, sPt.y - 8);
    });
  }
}

function getWallAtPosition(screenX, screenY, maxDistance = 10) {
  let foundWallIdx = -1, minDist = maxDistance;
  walls.forEach((wall, idx) => {
    const c1 = corners[wall.corner1];
    const c2 = corners[wall.corner2];
    if (!c1 || !c2) return;
    
    const sp1 = realToScreen(c1.x, c1.y);
    const sp2 = realToScreen(c2.x, c2.y);
    
    const dx = sp2.x - sp1.x;
    const dy = sp2.y - sp1.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1) return;
    
    const wx = screenX - sp1.x;
    const wy = screenY - sp1.y;
    const t = Math.max(0, Math.min(1, (wx * dx + wy * dy) / lenSq));
    
    const projX = sp1.x + t * dx;
    const projY = sp1.y + t * dy;
    const dist = Math.hypot(screenX - projX, screenY - projY);
    
    if (dist < minDist) {
      minDist = dist;
      foundWallIdx = idx;
    }
  });
  return foundWallIdx;
}

function getCornerAtPosition(screenX, screenY, maxDistance = 12) {
  let foundId = null, minDist = maxDistance;
  Object.keys(corners).forEach(id => {
    const sp   = realToScreen(corners[id].x, corners[id].y);
    const dist = Math.hypot(screenX - sp.x, screenY - sp.y);
    if (dist < minDist) { minDist = dist; foundId = id; }
  });
  return foundId;
}

function getCameraAtPosition(screenX, screenY, maxDistance = 14) {
  let foundId = null, minDist = maxDistance;
  cameraPositions.forEach(cam => {
    const sp   = realToScreen(cam.x, cam.y);
    const dist = Math.hypot(screenX - sp.x, screenY - sp.y);
    if (dist < minDist) { minDist = dist; foundId = cam.id; }
  });
  return foundId;
}

function snapCoordinates(realX, realY, excludeId = null, snapDist = 15) {
  let snappedX = realX, snappedY = realY;
  Object.keys(corners).forEach(id => {
    if (id === excludeId) return;
    if (Math.abs(realX - corners[id].x) < snapDist) snappedX = corners[id].x;
    if (Math.abs(realY - corners[id].y) < snapDist) snappedY = corners[id].y;
  });
  return { x: snappedX, y: snappedY };
}

canvas2D.addEventListener('mousedown', e => {
  const rect = canvas2D.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const realPos = screenToReal(mouseX, mouseY);

  if (activeTool === 'draw-object-shape') {
    drawingObjectPoints.push({ x: realPos.x, y: realPos.y });
    draw2D();
    return;
  }

  const clickedCorner = getCornerAtPosition(mouseX, mouseY);
  let clickedWallIdx = -1;

  // Check for pan trigger: middle button, right button, or left button in select tool when no corner clicked
  const isRightClick = e.button === 2;
  const isMiddleClick = e.button === 1;
  const isLeftClick = e.button === 0;

  // 1. Check if clicking existing object first
  let clickedObjIdx = -1;
  if (activeTool === 'select' && isLeftClick) {
    identifiedObjects.forEach((obj, idx) => {
      const sp = realToScreen(obj.x, obj.y);
      const dx = mouseX - sp.x;
      const dy = mouseY - sp.y;

      // Rotated bounding box check
      const angleRad = -(obj.rotation || 0) * Math.PI / 180;
      const rotX = dx * Math.cos(angleRad) - dy * Math.sin(angleRad);
      const rotY = dx * Math.sin(angleRad) + dy * Math.cos(angleRad);
      const halfW = ((obj.w || 60) * screenScale) / 2;
      const halfH = ((obj.h || 60) * screenScale) / 2;

      const isInsideBox = Math.abs(rotX) <= halfW + 8 && Math.abs(rotY) <= halfH + 8;

      // Center circle fallback
      const r = Math.max(15, (Math.min(obj.w || 40, obj.h || 40) / 2) * screenScale);
      const isInsideCircle = Math.hypot(dx, dy) <= r + 8;

      if (isInsideBox || isInsideCircle) {
        clickedObjIdx = idx;
      }
    });

    if (!clickedCorner && clickedObjIdx === -1) {
      clickedWallIdx = getWallAtPosition(mouseX, mouseY);
    }
  }

  // Pan only if no corner, wall, or object was clicked in select tool!
  const hasHitAnything = clickedCorner || (clickedObjIdx !== -1) || (clickedWallIdx !== -1);
  if (isRightClick || isMiddleClick || (isLeftClick && activeTool === 'select' && !hasHitAnything)) {
    isPanning = true;
    startPanX = e.clientX;
    startPanY = e.clientY;
    if (isRightClick) {
      e.preventDefault();
    }
    return;
  }

  if (activeTool === 'camera') {
    // Check if clicking existing camera to select
    const hitCam = getCameraAtPosition(mouseX, mouseY);
    if (hitCam) {
      selectedCamera = hitCam;
    } else {
      // Place new camera
      const id = 'cam_' + Date.now();
      const newCam = { id, x: realPos.x, y: realPos.y, angle: 0, label: `Camera ${cameraPositions.length + 1}` };
      cameraPositions.push(newCam);
      selectedCamera = id;
      updateCameraList();
      updatePipelineState();
    }
    draw2D();
    return;
  }

  if (activeTool === 'select') {
    if (clickedObjIdx !== -1) {
      selectedObjectIndex = clickedObjIdx;
      isDraggingObject = true;
      dragObjectOffset = { 
        x: realPos.x - identifiedObjects[clickedObjIdx].x, 
        y: realPos.y - identifiedObjects[clickedObjIdx].y 
      };
      selectedCorner = null;
      selectedWallIndex = -1;
      isDragging = false;
      isDraggingWall = false;
      renderObjectLibrary();
      draw2D();
      rebuild3D();
      openObjectEditModal(clickedObjIdx); // Open modal immediately on single click!
      return;
    } else {
      if (!clickedCorner) {
        selectedObjectIndex = -1;
        renderObjectLibrary();
      }
    }

    if (clickedCorner) { 
      selectedCorner = clickedCorner; 
      isDragging = true; 
      selectedWallIndex = -1;
      isDraggingWall = false;
    } else if (clickedWallIdx !== -1) {
      selectedWallIndex = clickedWallIdx;
      isDraggingWall = true;
      const wall = walls[clickedWallIdx];
      dragWallStartOffset = { x: realPos.x, y: realPos.y };
      dragWallCorner1Start = { x: corners[wall.corner1].x, y: corners[wall.corner1].y };
      dragWallCorner2Start = { x: corners[wall.corner2].x, y: corners[wall.corner2].y };
      selectedCorner = null;
      isDragging = false;
    } else {
      selectedCorner = null;
      selectedWallIndex = -1;
      isDragging = false;
      isDraggingWall = false;
    }
  } else if (activeTool === 'draw') {
    if (clickedCorner) {
      if (!drawingStartCorner) {
        drawingStartCorner = clickedCorner;
      } else {
        if (drawingStartCorner !== clickedCorner) {
          addWall(drawingStartCorner, clickedCorner);
          drawingStartCorner = clickedCorner; // Keep chain drawing!
        } else {
          drawingStartCorner = null; // Click same corner twice to stop!
        }
      }
    } else {
      const snapped = snapCoordinates(realPos.x, realPos.y, drawingStartCorner);
      const newCornerId = addCorner(snapped.x, snapped.y);
      if (!drawingStartCorner) { 
        drawingStartCorner = newCornerId; 
      } else { 
        addWall(drawingStartCorner, newCornerId); 
        drawingStartCorner = newCornerId; // Keep chain drawing!
      }
    }
  } else if (activeTool === 'delete') {
    if (clickedCorner) { deleteCorner(clickedCorner); selectedCorner = null; }
  }

  draw2D();
});

canvas2D.addEventListener('mousemove', e => {
  if (isPanning) {
    const dx = e.clientX - startPanX;
    const dy = e.clientY - startPanY;
    offsetX += dx;
    offsetY += dy;
    startPanX = e.clientX;
    startPanY = e.clientY;
    draw2D();
    return;
  }

  const rect = canvas2D.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const realPos = screenToReal(mouseX, mouseY);

  if (activeTool === 'draw-object-shape') {
    tempMousePos.x = realPos.x;
    tempMousePos.y = realPos.y;
    draw2D();
    return;
  }

  if (activeTool === 'camera' && selectedCamera) {
    // Rotate selected camera arrow by dragging
    const cam = cameraPositions.find(c => c.id === selectedCamera);
    if (cam && e.buttons === 1) {
      const sp = realToScreen(cam.x, cam.y);
      const dx = mouseX - sp.x;
      const dy = mouseY - sp.y;
      cam.angle = Math.round(Math.atan2(dx, -dy) * 180 / Math.PI);
      updateCameraList();
      draw2D();
      return;
    }
  }

  if (isDraggingObject && selectedObjectIndex !== -1) {
    const obj = identifiedObjects[selectedObjectIndex];
    const newX = Math.round(realPos.x - dragObjectOffset.x);
    const newY = Math.round(realPos.y - dragObjectOffset.y);
    const dx = newX - obj.x;
    const dy = newY - obj.y;
    
    obj.x = newX;
    obj.y = newY;
    
    if (obj.points && obj.points.length > 0) {
      obj.points.forEach(p => {
        p.x += dx;
        p.y += dy;
      });
    }
    
    rebuild3D();
    draw2D();
    return;
  }

  if (isDraggingWall && selectedWallIndex !== -1) {
    const wall = walls[selectedWallIndex];
    const deltaX = Math.round(realPos.x - dragWallStartOffset.x);
    const deltaY = Math.round(realPos.y - dragWallStartOffset.y);
    
    corners[wall.corner1].x = dragWallCorner1Start.x + deltaX;
    corners[wall.corner1].y = dragWallCorner1Start.y + deltaY;
    corners[wall.corner2].x = dragWallCorner2Start.x + deltaX;
    corners[wall.corner2].y = dragWallCorner2Start.y + deltaY;

    if (skipTraceCheckbox && !skipTraceCheckbox.checked) {
      skipTraceCheckbox.checked = true;
      updatePipelineState();
    }
    rebuild3D();
    draw2D();
    return;
  }

  if (isDragging && selectedCorner) {
    const snapped = snapCoordinates(realPos.x, realPos.y, selectedCorner);
    corners[selectedCorner].x = snapped.x;
    corners[selectedCorner].y = snapped.y;
    if (skipTraceCheckbox && !skipTraceCheckbox.checked) {
      skipTraceCheckbox.checked = true;
      updatePipelineState();
    }
    rebuild3D();
  }

  if (activeTool === 'draw' && drawingStartCorner) {
    const snapped = snapCoordinates(realPos.x, realPos.y, drawingStartCorner);
    tempMousePos.x = snapped.x; tempMousePos.y = snapped.y;
  }

  draw2D();
});

canvas2D.addEventListener('mouseup', () => {
  isDragging = false;
  isDraggingObject = false;
  isDraggingWall = false;
  selectedWallIndex = -1;
  isPanning = false;
});

canvas2D.addEventListener('mouseleave', () => {
  isDragging = false;
  isDraggingObject = false;
  isDraggingWall = false;
  selectedWallIndex = -1;
  isPanning = false;
});

canvas2D.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = canvas2D.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  const realPos = screenToReal(mouseX, mouseY);
  const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
  const newScale = Math.min(Math.max(screenScale * zoomFactor, 0.05), 100);
  screenScale = newScale;

  offsetX = mouseX - realPos.x * screenScale;
  offsetY = mouseY - realPos.y * screenScale;

  draw2D();
}, { passive: false });

canvas2D.addEventListener('contextmenu', e => {
  e.preventDefault();
});

// ─── State Modifiers ─────────────────────────────────────────────────────────
function addCorner(x, y) {
  const id = 'c_' + Math.random().toString(36).substr(2, 9);
  corners[id] = { x, y };
  return id;
}

function addWall(c1, c2) {
  const exists = walls.some(w =>
    (w.corner1 === c1 && w.corner2 === c2) || (w.corner1 === c2 && w.corner2 === c1)
  );
  if (exists) return;
  const id = 'w_' + Math.random().toString(36).substr(2, 9);
  walls.push({ id, corner1: c1, corner2: c2 });
  if (skipTraceCheckbox && !skipTraceCheckbox.checked) {
    skipTraceCheckbox.checked = true;
  }
  rebuild3D();
  updatePipelineState();
}

function deleteCorner(id) {
  walls = walls.filter(w => w.corner1 !== id && w.corner2 !== id);
  delete corners[id];
  if (skipTraceCheckbox && !skipTraceCheckbox.checked) {
    skipTraceCheckbox.checked = true;
  }
  rebuild3D();
  updatePipelineState();
}

// ─── 3D Rebuild and Helpers ───────────────────────────────────────────────────
function buildProceduralObjectMesh(obj, w, h, height, isSelected) {
  const group = new THREE.Group();
  const otype = (obj.label || obj.typeGuess || obj.type || 'generic').toLowerCase();

  // Common materials
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x854d0e, roughness: 0.6 }); // brown
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.9, roughness: 0.2 }); // steel
  const fabricMat = new THREE.MeshStandardMaterial({ color: isSelected ? 0xef4444 : 0x3b82f6, roughness: 0.9 }); // blue/red
  const leatherMat = new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.5 }); // dark brown
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, transparent: true, opacity: 0.4, roughness: 0.1 });
  const ceramicMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 }); // white
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.9 }); // green
  const potMat = new THREE.MeshStandardMaterial({ color: 0xc2410c, roughness: 0.7 }); // terracotta

  if (obj.primitives && obj.primitives.length > 0) {
    const matMap = {
      wood: woodMat,
      steel: metalMat,
      metal: metalMat,
      glass: glassMat,
      ceramic: ceramicMat,
      painted: new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.8 }),
      foliage: foliageMat,
      stone: new THREE.MeshStandardMaterial({ color: 0x78716c, roughness: 0.9 }),
      leather: leatherMat,
      fabric: fabricMat,
      marble: new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.1 }),
      pot: potMat,
      soil: new THREE.MeshStandardMaterial({ color: 0x451a03, roughness: 0.9 })
    };

    obj.primitives.forEach(prim => {
      const pshape = (prim.shape || 'cube').toLowerCase();
      const psize = prim.size || [0.2, 0.2, 0.2];
      const ppos = prim.pos || [0, 0, 0];
      const prot = prim.rot || [0, 0, 0];
      const pmatName = (prim.mat || 'generic').toLowerCase();
      const pmat = matMap[pmatName] || new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.5 });

      let geom;
      if (pshape === 'cube' || pshape === 'box') {
        geom = new THREE.BoxGeometry(psize[0] * 100, psize[2] * 100, psize[1] * 100);
      } else if (pshape === 'cylinder') {
        geom = new THREE.CylinderGeometry(psize[0] * 100, psize[0] * 100, psize[1] * 100, 16);
      } else if (pshape === 'sphere') {
        geom = new THREE.SphereGeometry(psize[0] * 100, 16, 16);
      } else {
        geom = new THREE.BoxGeometry(psize[0] * 100, psize[2] * 100, psize[1] * 100);
      }

      const mesh = new THREE.Mesh(geom, pmat);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.position.set(ppos[0] * 100, ppos[2] * 100, ppos[1] * 100);
      mesh.rotation.set(
        prot[0] * Math.PI / 180,
        prot[2] * Math.PI / 180,
        prot[1] * Math.PI / 180
      );

      group.add(mesh);
    });

    if (isSelected) {
      const frameGeom = new THREE.BoxGeometry(w + 2, height + 2, h + 2);
      const edges = new THREE.EdgesGeometry(frameGeom);
      const lineMat = new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 3 });
      const line = new THREE.LineSegments(edges, lineMat);
      line.position.y = height / 2;
      group.add(line);
    }

    return group;
  }
  if (otype === 'dining_table' || otype === 'table') {
    // Tabletop
    const topGeom = new THREE.BoxGeometry(w, 4, h);
    const topMesh = new THREE.Mesh(topGeom, woodMat);
    topMesh.position.y = height - 2;
    topMesh.castShadow = topMesh.receiveShadow = true;
    group.add(topMesh);

    // 4 legs
    const legRadius = 2;
    const legHeight = height - 4;
    const legGeom = new THREE.CylinderGeometry(legRadius, legRadius, legHeight, 8);
    const legPositions = [
      { x: -w/2 + 4, z: -h/2 + 4 },
      { x: w/2 - 4, z: -h/2 + 4 },
      { x: -w/2 + 4, z: h/2 - 4 },
      { x: w/2 - 4, z: h/2 - 4 }
    ];
    legPositions.forEach(pos => {
      const legMesh = new THREE.Mesh(legGeom, metalMat);
      legMesh.position.set(pos.x, legHeight / 2, pos.z);
      legMesh.castShadow = true;
      group.add(legMesh);
    });
  } 
  else if (otype === 'chair') {
    // Seat
    const seatGeom = new THREE.BoxGeometry(w * 0.8, 3, h * 0.8);
    const seatMesh = new THREE.Mesh(seatGeom, fabricMat);
    const seatH = height * 0.6;
    seatMesh.position.y = seatH;
    seatMesh.castShadow = seatMesh.receiveShadow = true;
    group.add(seatMesh);

    // Backrest
    const backGeom = new THREE.BoxGeometry(w * 0.8, height * 0.5, 3);
    const backMesh = new THREE.Mesh(backGeom, fabricMat);
    backMesh.position.set(0, seatH + height * 0.25, -h * 0.4 + 1.5);
    backMesh.castShadow = true;
    group.add(backMesh);

    // 4 legs
    const legRadius = 1.5;
    const legGeom = new THREE.CylinderGeometry(legRadius, legRadius, seatH, 8);
    const legPositions = [
      { x: -w*0.35, z: -h*0.35 },
      { x: w*0.35,  z: -h*0.35 },
      { x: -w*0.35, z: h*0.35 },
      { x: w*0.35,  z: h*0.35 }
    ];
    legPositions.forEach(pos => {
      const legMesh = new THREE.Mesh(legGeom, metalMat);
      legMesh.position.set(pos.x, seatH / 2, pos.z);
      legMesh.castShadow = true;
      group.add(legMesh);
    });
  }
  else if (otype === 'bar_stool') {
    // Seat
    const seatH = height * 0.8;
    const seatGeom = new THREE.CylinderGeometry(w * 0.4, w * 0.4, 4, 16);
    const seatMesh = new THREE.Mesh(seatGeom, leatherMat);
    seatMesh.position.y = seatH;
    seatMesh.castShadow = seatMesh.receiveShadow = true;
    group.add(seatMesh);

    // Base column
    const colGeom = new THREE.CylinderGeometry(2, 2, seatH, 8);
    const colMesh = new THREE.Mesh(colGeom, metalMat);
    colMesh.position.y = seatH / 2;
    colMesh.castShadow = true;
    group.add(colMesh);

    // Base foot
    const footGeom = new THREE.CylinderGeometry(w * 0.4, w * 0.4, 2, 16);
    const footMesh = new THREE.Mesh(footGeom, metalMat);
    footMesh.position.y = 1;
    footMesh.receiveShadow = true;
    group.add(footMesh);
  }
  else if (otype === 'sofa') {
    // Base seat
    const baseGeom = new THREE.BoxGeometry(w, height * 0.4, h);
    const baseMesh = new THREE.Mesh(baseGeom, fabricMat);
    baseMesh.position.y = height * 0.2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Backrest
    const backGeom = new THREE.BoxGeometry(w, height * 0.6, h * 0.2);
    const backMesh = new THREE.Mesh(backGeom, fabricMat);
    backMesh.position.set(0, height * 0.7, -h * 0.4);
    backMesh.castShadow = true;
    group.add(backMesh);

    // Left Armrest
    const leftArmGeom = new THREE.BoxGeometry(w * 0.15, height * 0.35, h * 0.8);
    const leftArmMesh = new THREE.Mesh(leftArmGeom, fabricMat);
    leftArmMesh.position.set(-w * 0.425, height * 0.575, h * 0.1);
    leftArmMesh.castShadow = true;
    group.add(leftArmMesh);

    // Right Armrest
    const rightArmGeom = new THREE.BoxGeometry(w * 0.15, height * 0.35, h * 0.8);
    const rightArmMesh = new THREE.Mesh(rightArmGeom, fabricMat);
    rightArmMesh.position.set(w * 0.425, height * 0.575, h * 0.1);
    rightArmMesh.castShadow = true;
    group.add(rightArmMesh);
  }
  else if (otype === 'plant') {
    // Pot
    const potH = height * 0.4;
    const potGeom = new THREE.CylinderGeometry(w * 0.4, w * 0.3, potH, 12);
    const potMesh = new THREE.Mesh(potGeom, potMat);
    potMesh.position.y = potH / 2;
    potMesh.castShadow = potMesh.receiveShadow = true;
    group.add(potMesh);

    // Stem
    const stemH = height * 0.6;
    const stemGeom = new THREE.CylinderGeometry(1.5, 1.5, stemH, 8);
    const stemMesh = new THREE.Mesh(stemGeom, woodMat);
    stemMesh.position.y = potH + stemH / 2 - 2;
    stemMesh.castShadow = true;
    group.add(stemMesh);

    // Foliage (Spheres)
    const folGeom = new THREE.SphereGeometry(w * 0.45, 12, 12);
    const folMesh1 = new THREE.Mesh(folGeom, foliageMat);
    folMesh1.position.set(0, potH + stemH - 5, 0);
    folMesh1.castShadow = true;
    group.add(folMesh1);

    const folMesh2 = new THREE.Mesh(folGeom, foliageMat);
    folMesh2.position.set(-w*0.15, potH + stemH + 5, w*0.1);
    folMesh2.scale.set(0.8, 0.8, 0.8);
    folMesh2.castShadow = true;
    group.add(folMesh2);
  }
  else if (otype === 'sink') {
    // Cabinet Base
    const baseGeom = new THREE.BoxGeometry(w, height, h);
    const baseMesh = new THREE.Mesh(baseGeom, woodMat);
    baseMesh.position.y = height / 2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Sink top (marble)
    const marbleMat = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.1 });
    const topGeom = new THREE.BoxGeometry(w + 1, 3, h + 1);
    const topMesh = new THREE.Mesh(topGeom, marbleMat);
    topMesh.position.y = height + 1.5;
    topMesh.castShadow = topMesh.receiveShadow = true;
    group.add(topMesh);

    // Faucet
    const faucetGeom = new THREE.CylinderGeometry(1, 1, 10, 8);
    const faucetMesh = new THREE.Mesh(faucetGeom, metalMat);
    faucetMesh.position.set(0, height + 8, -h * 0.35);
    faucetMesh.rotation.x = Math.PI / 4;
    faucetMesh.castShadow = true;
    group.add(faucetMesh);
  }
  else if (otype === 'counter' || otype === 'kitchen_counter' || otype === 'bar') {
    // Main base
    const baseGeom = new THREE.BoxGeometry(w, height, h);
    const baseMesh = new THREE.Mesh(baseGeom, woodMat);
    baseMesh.position.y = height / 2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Counter top
    const counterTopMat = (otype === 'bar') ? woodMat : new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.1 }); // marble/white top
    const topGeom = new THREE.BoxGeometry(w + 2, 4, h + 2);
    const topMesh = new THREE.Mesh(topGeom, counterTopMat);
    topMesh.position.y = height + 2;
    topMesh.castShadow = topMesh.receiveShadow = true;
    group.add(topMesh);
  }
  else if (otype === 'display_case') {
    // Wooden base
    const baseH = height * 0.3;
    const baseGeom = new THREE.BoxGeometry(w, baseH, h);
    const baseMesh = new THREE.Mesh(baseGeom, woodMat);
    baseMesh.position.y = baseH / 2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Glass display top
    const glassH = height * 0.7;
    const glassGeom = new THREE.BoxGeometry(w - 2, glassH, h - 2);
    const glassMesh = new THREE.Mesh(glassGeom, glassMat);
    glassMesh.position.y = baseH + glassH / 2;
    glassMesh.castShadow = true;
    group.add(glassMesh);

    // Metal frame borders
    const frameGeom = new THREE.BoxGeometry(w, glassH + 1, h);
    const edges = new THREE.EdgesGeometry(frameGeom);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x475569, linewidth: 2 });
    const line = new THREE.LineSegments(edges, lineMat);
    line.position.y = baseH + glassH / 2;
    group.add(line);
  }
  else if (otype === 'refrigerator') {
    // Tall metal cabinet
    const fridgeH = height * 2.2;
    const baseGeom = new THREE.BoxGeometry(w, fridgeH, h);
    const baseMesh = new THREE.Mesh(baseGeom, metalMat);
    baseMesh.position.y = fridgeH / 2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Handle vertical strip
    const handleGeom = new THREE.BoxGeometry(2, fridgeH * 0.4, 2);
    const handleMesh = new THREE.Mesh(handleGeom, woodMat);
    handleMesh.position.set(w * 0.4, fridgeH * 0.5, h * 0.5 + 1);
    handleMesh.castShadow = true;
    group.add(handleMesh);
  }
  else if (otype === 'stove' || otype === 'oven') {
    // Metallic stove body
    const baseGeom = new THREE.BoxGeometry(w, height, h);
    const baseMesh = new THREE.Mesh(baseGeom, metalMat);
    baseMesh.position.y = height / 2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Cooktop burners (black cylinders)
    const burnerMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.9 });
    const burnerGeom = new THREE.CylinderGeometry(w * 0.15, w * 0.15, 1, 12);
    const burnerPositions = [
      { x: -w * 0.22, z: -h * 0.22 },
      { x: w * 0.22,  z: -h * 0.22 },
      { x: -w * 0.22, z: h * 0.22 },
      { x: w * 0.22,  z: h * 0.22 }
    ];
    burnerPositions.forEach(pos => {
      const burnerMesh = new THREE.Mesh(burnerGeom, burnerMat);
      burnerMesh.position.set(pos.x, height + 0.5, pos.z);
      group.add(burnerMesh);
    });
  }
  else if (otype.includes('oven') || otype.includes('بلدي') || otype.includes('فرن')) {
    // Custom Traditional Oven
    // Brick dome base
    const baseGeom = new THREE.CylinderGeometry(w * 0.5, w * 0.55, height, 16);
    const baseMesh = new THREE.Mesh(baseGeom, potMat);
    baseMesh.position.y = height / 2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Glowing fire opening
    const fireMat = new THREE.MeshBasicMaterial({ color: 0xf97316 }); // orange glow
    const fireOpeningGeom = new THREE.BoxGeometry(w * 0.4, height * 0.35, 4);
    const fireMesh = new THREE.Mesh(fireOpeningGeom, fireMat);
    fireMesh.position.set(0, height * 0.45, h * 0.5);
    group.add(fireMesh);
  }
  else if (otype.includes('shawarma') || otype.includes('شاورما') || otype.includes('سيخ')) {
    // Custom Shawarma Machine
    // Metallic base counter
    const baseH = height * 0.4;
    const baseGeom = new THREE.BoxGeometry(w, baseH, h);
    const baseMesh = new THREE.Mesh(baseGeom, metalMat);
    baseMesh.position.y = baseH / 2;
    baseMesh.castShadow = baseMesh.receiveShadow = true;
    group.add(baseMesh);

    // Shawarma vertical spit rods
    const rodH = height * 1.5;
    const rodGeom = new THREE.CylinderGeometry(1, 1, rodH, 8);
    const meatGeom = new THREE.CylinderGeometry(w * 0.2, w * 0.15, rodH * 0.6, 12);
    const spitPositions = [
      { x: -w * 0.25, z: 0 },
      { x: w * 0.25,  z: 0 }
    ];
    spitPositions.forEach(pos => {
      const rodMesh = new THREE.Mesh(rodGeom, metalMat);
      rodMesh.position.set(pos.x, baseH + rodH / 2, pos.z);
      rodMesh.castShadow = true;
      group.add(rodMesh);

      const meatMesh = new THREE.Mesh(meatGeom, leatherMat);
      meatMesh.position.set(pos.x, baseH + rodH * 0.5, pos.z);
      meatMesh.castShadow = true;
      group.add(meatMesh);
    });
  }
  else if (otype === 'staircase' || otype === 'stairs') {
    const steps = 14;
    const stepD = h / steps;
    const stepH = height / steps;
    const overhang = 2;
    const treadMat = new THREE.MeshStandardMaterial({ color: 0xa8a29e, roughness: 0.8 });
    
    for (let s = 0; s < steps; s++) {
      const treadGeom = new THREE.BoxGeometry(w, 3, stepD + overhang);
      const treadMesh = new THREE.Mesh(treadGeom, treadMat);
      treadMesh.position.set(0, stepH * (s + 1) - 1.5, -h / 2 + stepD * (s + 0.5));
      treadMesh.castShadow = treadMesh.receiveShadow = true;
      group.add(treadMesh);
      
      const riserGeom = new THREE.BoxGeometry(w, stepH, 2);
      const riserMesh = new THREE.Mesh(riserGeom, treadMat);
      riserMesh.position.set(0, stepH * (s + 0.5), -h / 2 + stepD * s);
      riserMesh.castShadow = true;
      group.add(riserMesh);
    }
  }
  else if (otype === 'door') {
    const frameT = 4;
    const leftGeom = new THREE.BoxGeometry(frameT, height, h + 1);
    const leftMesh = new THREE.Mesh(leftGeom, woodMat);
    leftMesh.position.set(-w / 2 + frameT / 2, height / 2, 0);
    group.add(leftMesh);
    
    const rightGeom = new THREE.BoxGeometry(frameT, height, h + 1);
    const rightMesh = new THREE.Mesh(rightGeom, woodMat);
    rightMesh.position.set(w / 2 - frameT / 2, height / 2, 0);
    group.add(rightMesh);
    
    const topGeom = new THREE.BoxGeometry(w, frameT, h + 1);
    const topMesh = new THREE.Mesh(topGeom, woodMat);
    topMesh.position.set(0, height - frameT / 2, 0);
    group.add(topMesh);
    
    const panelGeom = new THREE.BoxGeometry(w - frameT * 2, height - frameT, 3);
    const panelMesh = new THREE.Mesh(panelGeom, new THREE.MeshStandardMaterial({ color: 0xdddddd, roughness: 0.9 }));
    panelMesh.position.set(0, (height - frameT) / 2, 0);
    group.add(panelMesh);
  }
  else if (otype === 'window') {
    const frameT = 4;
    const sillH = 90;
    const leftGeom = new THREE.BoxGeometry(frameT, height, h + 1);
    const leftMesh = new THREE.Mesh(leftGeom, metalMat);
    leftMesh.position.set(-w / 2 + frameT / 2, sillH + height / 2, 0);
    group.add(leftMesh);

    const rightGeom = new THREE.BoxGeometry(frameT, height, h + 1);
    const rightMesh = new THREE.Mesh(rightGeom, metalMat);
    rightMesh.position.set(w / 2 - frameT / 2, sillH + height / 2, 0);
    group.add(rightMesh);

    const topGeom = new THREE.BoxGeometry(w, frameT, h + 1);
    const topMesh = new THREE.Mesh(topGeom, metalMat);
    topMesh.position.set(0, sillH + height - frameT / 2, 0);
    group.add(topMesh);

    const bottomGeom = new THREE.BoxGeometry(w, frameT, h + 1);
    const bottomMesh = new THREE.Mesh(bottomGeom, metalMat);
    bottomMesh.position.set(0, sillH + frameT / 2, 0);
    group.add(bottomMesh);
    
    const glassGeom = new THREE.BoxGeometry(w - frameT * 2, height - frameT * 2, 1.5);
    const glassMesh = new THREE.Mesh(glassGeom, glassMat);
    glassMesh.position.set(0, sillH + height / 2, 0);
    group.add(glassMesh);
  }
  else {
    // Fallback Box
    const geom = new THREE.BoxGeometry(w, height, h);
    geom.translate(0, height / 2, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: isSelected ? 0xef4444 : 0xf97316,
      roughness: 0.5,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Draw outline selection box
  if (isSelected) {
    const frameGeom = new THREE.BoxGeometry(w + 2, height + 2, h + 2);
    const edges = new THREE.EdgesGeometry(frameGeom);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 3 });
    const line = new THREE.LineSegments(edges, lineMat);
    line.position.y = height / 2;
    group.add(line);
  }

  return group;
}

function clearLoadedGLB() {
  if (loadedBlenderGLB) {
    scene.remove(loadedBlenderGLB);
    loadedBlenderGLB.traverse(child => {
      if (child.isMesh) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      }
    });
    loadedBlenderGLB = null;
    if (wallGroup) wallGroup.visible = true;
    if (objectGroup) objectGroup.visible = true;
  }
}

function loadBlenderGLB(glbDataUrl) {
  if (!glbDataUrl) return;
  const base64Data = glbDataUrl.split(',')[1];
  if (!base64Data) return;
  
  const binaryString = window.atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const arrayBuffer = bytes.buffer;
  
  const loader = new GLTFLoader();
  loader.parse(arrayBuffer, '', (gltf) => {
    clearLoadedGLB();
    loadedBlenderGLB = gltf.scene;
    
    // Scale and translate the GLB model from Blender meters to Three.js centimeters
    loadedBlenderGLB.scale.set(100, 100, 100);
    const centerOffsetX = (calibrateWidth * 100) / 2;
    const centerOffsetZ = (calibrateHeight * 100) / 2;
    loadedBlenderGLB.position.set(-centerOffsetX, 0, centerOffsetZ);
    
    // Traverese model to disable redundant light sources and enable shadows
    loadedBlenderGLB.traverse(child => {
      if (child.isLight) {
        child.visible = false;
      }
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    
    scene.add(loadedBlenderGLB);
    rebuild3D(true); // Rebuild scene while preserving the loaded Blender model
  }, (error) => {
    console.error('Error parsing GLB model from Blender:', error);
  });
}

function rebuild3D(keepGLB = false) {
  if (!scene) return;

  if (loadedBlenderGLB && (isDragging || isDraggingObject || isDraggingWall)) {
    clearLoadedGLB();
  }

  if (!keepGLB) {
    clearLoadedGLB();
  }

  if (loadedBlenderGLB) {
    if (wallGroup) wallGroup.visible = false;
    if (objectGroup) objectGroup.visible = false;
    return;
  }

  if (wallGroup) wallGroup.visible = true;
  if (objectGroup) objectGroup.visible = true;

  while (wallGroup.children.length > 0) {
    const obj = wallGroup.children[0];
    obj.geometry.dispose();
    if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
    else obj.material.dispose();
    wallGroup.remove(obj);
  }

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(wallColor), roughness: 0.8, metalness: 0.1
  });

  walls.forEach(wall => {
    const c1 = corners[wall.corner1];
    const c2 = corners[wall.corner2];
    if (!c1 || !c2) return;
    const x1 = c1.x, z1 = c1.y, x2 = c2.x, z2 = c2.y;
    const dx = x2 - x1, dz = z2 - z1;
    const length = Math.hypot(dx, dz);
    const angle  = Math.atan2(dz, dx);

    // Find openings (doors/windows) on this wall segment
    const openings = [];
    identifiedObjects.forEach(obj => {
      const otype = (obj.label || obj.typeGuess || '').toLowerCase();
      if (otype !== 'door' && otype !== 'window') return;

      const vx = dx, vz = dz;
      const wallLenSq = vx*vx + vz*vz;
      if (wallLenSq < 1) return;

      const wx = obj.x - x1, wz = obj.y - z1;
      const t = (wx*vx + wz*vz) / wallLenSq;

      if (t >= 0 && t <= 1) {
        const projX = x1 + t * vx;
        const projZ = z1 + t * vz;
        const dist = Math.hypot(obj.x - projX, obj.y - projZ);
        if (dist < (wallThickness / 2 + 25)) {
          const opW = obj.w || 80;
          const opCenterDist = t * length;
          openings.push({
            type: otype,
            start: Math.max(0, opCenterDist - opW / 2),
            end: Math.min(length, opCenterDist + opW / 2)
          });
        }
      }
    });

    // Sort and merge openings
    openings.sort((a, b) => a.start - b.start);
    const mergedOpenings = [];
    openings.forEach(op => {
      if (mergedOpenings.length === 0) {
        mergedOpenings.push(op);
      } else {
        const last = mergedOpenings[mergedOpenings.length - 1];
        if (op.start <= last.end) {
          last.end = Math.max(last.end, op.end);
        } else {
          mergedOpenings.push(op);
        }
      }
    });

    const centerOffsetX = (calibrateWidth * 100) / 2;
    const centerOffsetZ = (calibrateHeight * 100) / 2;

    let currentDist = 0;
    mergedOpenings.forEach(op => {
      // Solid segment before opening
      const segLen = op.start - currentDist;
      if (segLen > 1) {
        const segCenterDist = currentDist + segLen / 2;
        const smx = x1 + (segCenterDist / length) * dx - centerOffsetX;
        const smz = z1 + (segCenterDist / length) * dz - centerOffsetZ;

        const wallGeom = new THREE.BoxGeometry(segLen, wallHeight, wallThickness);
        const wallMesh = new THREE.Mesh(wallGeom, material);
        wallMesh.castShadow = wallMesh.receiveShadow = true;
        wallMesh.position.set(smx, wallHeight / 2, smz);
        wallMesh.rotation.y = -angle;
        wallGroup.add(wallMesh);
      }

      // Window sill/header fill
      if (op.type === 'window') {
        const opLen = op.end - op.start;
        const opCenterDist = op.start + opLen / 2;
        const omx = x1 + (opCenterDist / length) * dx - centerOffsetX;
        const omz = z1 + (opCenterDist / length) * dz - centerOffsetZ;

        // lower (sill)
        const sillH = 90;
        const lowGeom = new THREE.BoxGeometry(opLen, sillH, wallThickness);
        const lowMesh = new THREE.Mesh(lowGeom, material);
        lowMesh.castShadow = lowMesh.receiveShadow = true;
        lowMesh.position.set(omx, sillH / 2, omz);
        lowMesh.rotation.y = -angle;
        wallGroup.add(lowMesh);

        // upper (header)
        const headH = 200;
        if (wallHeight > headH) {
          const topH = wallHeight - headH;
          const topGeom = new THREE.BoxGeometry(opLen, topH, wallThickness);
          const topMesh = new THREE.Mesh(topGeom, material);
          topMesh.castShadow = topMesh.receiveShadow = true;
          topMesh.position.set(omx, headH + topH / 2, omz);
          topMesh.rotation.y = -angle;
          wallGroup.add(topMesh);
        }
      }

      currentDist = op.end;
    });

    // Final segment
    const segLen = length - currentDist;
    if (segLen > 1) {
      const segCenterDist = currentDist + segLen / 2;
      const smx = x1 + (segCenterDist / length) * dx - centerOffsetX;
      const smz = z1 + (segCenterDist / length) * dz - centerOffsetZ;

      const wallGeom = new THREE.BoxGeometry(segLen, wallHeight, wallThickness);
      const wallMesh = new THREE.Mesh(wallGeom, material);
      wallMesh.castShadow = wallMesh.receiveShadow = true;
      wallMesh.position.set(smx, wallHeight / 2, smz);
      wallMesh.rotation.y = -angle;
      wallGroup.add(wallMesh);
    }
  });

  // 3D Objects Visualization
  if (!objectGroup) {
    objectGroup = new THREE.Group();
    scene.add(objectGroup);
  }

  while (objectGroup.children.length > 0) {
    const obj = objectGroup.children[0];
    obj.traverse(child => {
      if (child.isMesh) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
          else child.material.dispose();
        }
      }
    });
    objectGroup.remove(obj);
  }

  const centerOffsetX = (calibrateWidth * 100) / 2;
  const centerOffsetZ = (calibrateHeight * 100) / 2;

  identifiedObjects.forEach((obj, idx) => {
    const w = obj.w || 60;
    const h = obj.h || 60;
    const height = 75;
    const isSelected = (idx === selectedObjectIndex);

    let objMesh;

    if (obj.shape === 'polygon' && obj.points && obj.points.length >= 3) {
      // Deduplicate points and remove closing duplicate point
      const pts = [];
      obj.points.forEach(p => {
        if (pts.length === 0) {
          pts.push(p);
        } else {
          const last = pts[pts.length - 1];
          if (Math.hypot(p.x - last.x, p.y - last.y) > 0.1) {
            pts.push(p);
          }
        }
      });
      if (pts.length > 2) {
        const first = pts[0];
        const last = pts[pts.length - 1];
        if (Math.hypot(last.x - first.x, last.y - first.y) < 0.1) {
          pts.pop();
        }
      }

      if (pts.length >= 3) {
        const shape3d = new THREE.Shape();
        const p0 = pts[0];
        shape3d.moveTo(p0.x - obj.x, -(p0.y - obj.y));
        for (let i = 1; i < pts.length; i++) {
          const pt = pts[i];
          shape3d.lineTo(pt.x - obj.x, -(pt.y - obj.y));
        }
        shape3d.closePath();

        const extrudeSettings = {
          depth: height,
          bevelEnabled: false
        };
        const objGeom = new THREE.ExtrudeGeometry(shape3d, extrudeSettings);
        objGeom.rotateX(-Math.PI / 2);

        const objMat = new THREE.MeshStandardMaterial({
          color: isSelected ? 0xef4444 : 0xf97316,
          roughness: 0.5,
          metalness: 0.1,
          transparent: true,
          opacity: 0.85
        });
        objMesh = new THREE.Mesh(objGeom, objMat);
        objMesh.castShadow = objMesh.receiveShadow = true;
      } else {
        objMesh = buildProceduralObjectMesh(obj, w, h, height, isSelected);
      }
    } else if (obj.shape === 'l-shape') {
      const t = obj.legThickness || 40;
      const shape3d = new THREE.Shape();
      shape3d.moveTo(-w / 2, h / 2);
      shape3d.lineTo(w / 2, h / 2);
      shape3d.lineTo(w / 2, h / 2 - t);
      shape3d.lineTo(-w / 2 + t, h / 2 - t);
      shape3d.lineTo(-w / 2 + t, -h / 2);
      shape3d.lineTo(-w / 2, -h / 2);
      shape3d.closePath();

      const extrudeSettings = {
        depth: height,
        bevelEnabled: false
      };
      const objGeom = new THREE.ExtrudeGeometry(shape3d, extrudeSettings);
      objGeom.rotateX(-Math.PI / 2);

      const objMat = new THREE.MeshStandardMaterial({
        color: isSelected ? 0xef4444 : 0xf97316,
        roughness: 0.5,
        metalness: 0.1,
        transparent: true,
        opacity: 0.85
      });
      objMesh = new THREE.Mesh(objGeom, objMat);
      objMesh.castShadow = objMesh.receiveShadow = true;
    } else {
      // Standard rectangular/custom objects
      objMesh = buildProceduralObjectMesh(obj, w, h, height, isSelected);
    }

    objMesh.position.set(obj.x - centerOffsetX, 0, obj.y - centerOffsetZ);
    objMesh.rotation.y = -(obj.rotation || 0) * Math.PI / 180;
    objMesh.scale.set(obj.flipH ? -1 : 1, 1, obj.flipV ? -1 : 1);
    objectGroup.add(objMesh);
  });

  if (floorMesh) { scene.remove(floorMesh); floorMesh.geometry.dispose(); floorMesh.material.dispose(); }
  floorMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(calibrateWidth * 100, calibrateHeight * 100),
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 })
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  if (ceilingMesh) { scene.remove(ceilingMesh); ceilingMesh.geometry.dispose(); ceilingMesh.material.dispose(); }
  if (showCeiling) {
    ceilingMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(calibrateWidth * 100, calibrateHeight * 100),
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.9 })
    );
    ceilingMesh.rotation.x = Math.PI / 2;
    ceilingMesh.position.y = wallHeight;
    scene.add(ceilingMesh);
  }

  updatePipelineState();
}

// ─── Pipeline State Manager ───────────────────────────────────────────────────
function updatePipelineState() {
  const hasFile    = !!uploadedFile;
  const hasWalls   = Object.keys(corners).length > 0;
  const hasObjects = identifiedObjects.length > 0;
  const hasCameras = cameraPositions.length > 0;
  const skipTrace  = skipTraceCheckbox && skipTraceCheckbox.checked;

  if (autoScanBtn) autoScanBtn.disabled = !hasFile;
  aiBtn.disabled          = !hasFile || skipTrace;
  identifyBtn.disabled    = !hasFile;
  aiBlenderPreviewBtn.disabled = !hasWalls;
  setCameraBtn.disabled   = !hasWalls;
  blenderRenderBtn.disabled = !(hasWalls && hasCameras);
  if (blindRenderBtn) {
    blindRenderBtn.disabled = !(hasWalls && hasCameras);
  }

  // Toggle button styling based on skipTrace toggle
  if (skipTrace) {
    aiBtn.classList.remove('btn-primary');
    aiBtn.classList.add('btn-secondary');
    identifyBtn.classList.remove('btn-secondary');
    identifyBtn.classList.add('btn-primary');
  } else {
    aiBtn.classList.remove('btn-secondary');
    aiBtn.classList.add('btn-primary');
    identifyBtn.classList.remove('btn-primary');
    identifyBtn.classList.add('btn-secondary');
  }
  if (viewObjects) {
    viewObjects.disabled = !(hasWalls || hasObjects);
  }
}

function showPipelineStatus(text) {
  pipelineStatus.style.display = 'flex';
  pipelineStatusText.textContent = text;
}
function hidePipelineStatus() {
  pipelineStatus.style.display = 'none';
}

// Quota / rate-limit warning banner
function showQuotaWarning(msg) {
  let banner = document.getElementById('quotaWarningBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'quotaWarningBanner';
    banner.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:linear-gradient(135deg,#ff6b35,#f7931e);color:#fff;padding:16px 28px;border-radius:12px;font-size:15px;font-weight:600;box-shadow:0 8px 32px rgba(255,107,53,0.4);display:flex;align-items:center;gap:12px;max-width:600px;animation:slideDown 0.4s ease;';
    const style = document.createElement('style');
    style.textContent = '@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-30px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
    document.head.appendChild(style);
    document.body.appendChild(banner);
  }
  banner.innerHTML = `<span style="font-size:22px">⚠️</span><span>${msg || 'AI quota or rate limit reached. Please wait a few minutes and try again.'}</span><button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,0.25);border:none;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer;font-weight:700;margin-left:auto">✕</button>`;
  banner.style.display = 'flex';
  // Auto-dismiss after 15 seconds
  setTimeout(() => { if (banner && banner.parentElement) banner.remove(); }, 15000);
}

// Helper to handle fetch responses with quota error detection
async function handleAIResponse(response, context) {
  if (response.status === 429) {
    let errorMsg = 'AI quota or rate limit reached. Please wait a few minutes and try again.';
    try {
      const errData = await response.json();
      if (errData.error) errorMsg = errData.error;
    } catch(e) {}
    showQuotaWarning(errorMsg);
    throw new Error(errorMsg);
  }
  if (!response.ok) {
    let errorMsg = response.statusText;
    try {
      const errData = await response.json();
      if (errData.error) errorMsg = errData.error;
    } catch(e) {}
    throw new Error(errorMsg);
  }
  return response.json();
}

// ─── Camera List UI ───────────────────────────────────────────────────────────
function updateCameraList() {
  const hasWalls = Object.keys(corners).length > 0;
  cameraPositionsSection.style.display = (cameraPositions.length > 0 || hasWalls) ? '' : 'none';
  cameraList.innerHTML = '';

  if (cameraPositions.length === 0) {
    cameraList.innerHTML = '<p class="empty-hint">Click "Camera Pin" tool then click on the 2D plan to place a camera.</p>';
    return;
  }

  cameraPositions.forEach((cam, idx) => {
    const item = document.createElement('div');
    item.className = 'camera-item' + (selectedCamera === cam.id ? ' selected' : '');
    item.innerHTML = `
      <div class="camera-item-info">
        <span class="camera-dot"></span>
        <span>Camera ${idx + 1}</span>
        <span class="camera-angle">${cam.angle}°</span>
      </div>
      <div class="camera-item-actions">
        <button class="cam-select-btn btn btn-mini" data-id="${cam.id}">Focus</button>
        <button class="cam-delete-btn btn btn-mini btn-danger" data-id="${cam.id}">✕</button>
      </div>`;
    cameraList.appendChild(item);
  });

  cameraList.querySelectorAll('.cam-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedCamera = btn.dataset.id;
      draw2D();
      updateCameraList();
    });
  });
  cameraList.querySelectorAll('.cam-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      cameraPositions = cameraPositions.filter(c => c.id !== btn.dataset.id);
      if (selectedCamera === btn.dataset.id) selectedCamera = null;
      draw2D();
      updateCameraList();
      updatePipelineState();
    });
  });
}

// ─── Object Library UI ────────────────────────────────────────────────────────
function renderObjectLibrary() {
  objectLibrary.innerHTML = '';

  if (identifiedObjects.length === 0) {
    objectLibrary.innerHTML = '<p class="empty-hint">Run "Step 2 — Identify Objects" or click "+ Add Object" above to manually place objects.</p>';
    return;
  }

  identifiedObjects.forEach((obj, idx) => {
    const isSelected = (idx === selectedObjectIndex);
    const card = document.createElement('div');
    card.className = `object-card${isSelected ? ' active' : ''}`;
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <div class="object-card-header">
        <span class="object-number">${idx + 1}</span>
        <div class="object-card-fields">
          <input class="object-label-input" data-idx="${idx}" type="text"
            value="${obj.label || obj.typeGuess || ''}"
            placeholder="Object type (e.g. dining table)">
          <div class="object-desc">${obj.referenceDescription
            ? `<em>${obj.referenceDescription}</em>`
            : '<span class="muted">No reference photo yet</span>'
          }</div>
        </div>
        <label class="ref-photo-label" title="Attach reference photo">
          <i data-lucide="image-plus"></i>
          <input type="file" class="ref-photo-input" data-idx="${idx}" accept="image/*" style="display:none">
        </label>
        <button class="object-edit-btn" data-idx="${idx}" title="Edit Details" style="background:none; border:none; color:#60a5fa; cursor:pointer; padding:4px; margin-top:2px; margin-right:4px;">
          <i data-lucide="settings" style="width:16px; height:16px;"></i>
        </button>
        <button class="object-delete-btn" data-idx="${idx}" title="Delete Object" style="background:none; border:none; color:#ef4444; cursor:pointer; padding:4px; margin-top:2px;">
          <i data-lucide="trash-2" style="width:16px; height:16px;"></i>
        </button>
      </div>
      <div class="object-card-dims" style="display: flex; gap: 8px; margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 8px;">
        <div class="object-dim-field" style="flex: 1; display: flex; flex-direction: column; gap: 2px;">
          <label style="font-size: 9px; color: #94a3b8; text-transform: uppercase;">Width (cm)</label>
          <input type="number" class="object-dim-input object-width-input" data-idx="${idx}" value="${obj.w || 60}" style="width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #fff; font-size: 11px; padding: 3px 5px;">
        </div>
        <div class="object-dim-field" style="flex: 1; display: flex; flex-direction: column; gap: 2px;">
          <label style="font-size: 9px; color: #94a3b8; text-transform: uppercase;">Depth (cm)</label>
          <input type="number" class="object-dim-input object-depth-input" data-idx="${idx}" value="${obj.h || 60}" style="width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #fff; font-size: 11px; padding: 3px 5px;">
        </div>
        <div class="object-dim-field" style="flex: 1; display: flex; flex-direction: column; gap: 2px;">
          <label style="font-size: 9px; color: #94a3b8; text-transform: uppercase;">Rotation (°)</label>
          <input type="number" class="object-dim-input object-rotation-input" data-idx="${idx}" value="${obj.rotation || 0}" style="width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #fff; font-size: 11px; padding: 3px 5px;">
        </div>
      </div>`;
    objectLibrary.appendChild(card);
  });

  // Bind card clicks for selection
  objectLibrary.querySelectorAll('.object-card').forEach((card, idx) => {
    card.addEventListener('click', e => {
      if (e.target.closest('input') || e.target.closest('button') || e.target.closest('label')) return;
      selectedObjectIndex = idx;
      renderObjectLibrary();
      draw2D();
      rebuild3D();
      openObjectEditModal(idx); // Open the side panel modal immediately on selection
    });
  });

  // Bind label inputs
  objectLibrary.querySelectorAll('.object-label-input').forEach(inp => {
    inp.addEventListener('input', () => {
      identifiedObjects[parseInt(inp.dataset.idx)].label = inp.value.trim();
    });
  });

  // Bind dimension inputs
  objectLibrary.querySelectorAll('.object-width-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(inp.dataset.idx);
      identifiedObjects[idx].w = parseFloat(e.target.value) || 60;
      draw2D();
      rebuild3D();
    });
  });

  objectLibrary.querySelectorAll('.object-depth-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(inp.dataset.idx);
      identifiedObjects[idx].h = parseFloat(e.target.value) || 60;
      draw2D();
      rebuild3D();
    });
  });

  objectLibrary.querySelectorAll('.object-rotation-input').forEach(inp => {
    inp.addEventListener('input', e => {
      const idx = parseInt(inp.dataset.idx);
      identifiedObjects[idx].rotation = parseFloat(e.target.value) || 0;
      draw2D();
      rebuild3D();
    });
  });

  // Bind edit buttons
  objectLibrary.querySelectorAll('.object-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openObjectEditModal(parseInt(btn.dataset.idx));
    });
  });

  // Bind delete buttons
  objectLibrary.querySelectorAll('.object-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      identifiedObjects = identifiedObjects.filter((_, i) => i !== idx);
      if (selectedObjectIndex === idx) selectedObjectIndex = -1;
      else if (selectedObjectIndex > idx) selectedObjectIndex--;
      renderObjectLibrary();
      draw2D();
      rebuild3D();
    });
  });

  // Bind reference photo uploads
  objectLibrary.querySelectorAll('.ref-photo-input').forEach(inp => {
    inp.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const idx = parseInt(inp.dataset.idx);
      showPipelineStatus(`Analyzing reference photo for object ${idx + 1}...`);
      try {
        const desc = await describeObject(file);
        identifiedObjects[idx].referenceDescription = desc;
        renderObjectLibrary();
        lucide.createIcons();
      } catch (err) {
        console.error('describe-object failed:', err);
      } finally {
        hidePipelineStatus();
      }
    });
  });

  lucide.createIcons();
}

function openObjectEditModal(idx) {
  const obj = identifiedObjects[idx];
  if (!obj) return;
  
  selectedObjectIndex = idx;
  draw2D();
  rebuild3D();
  
  const modal = document.getElementById('object-edit-modal');
  const modalNumber = document.getElementById('modal-obj-number');
  const modalLabel = document.getElementById('modal-obj-label');
  const modalWidth = document.getElementById('modal-obj-width');
  const modalDepth = document.getElementById('modal-obj-depth');
  const modalRotation = document.getElementById('modal-obj-rotation');
  const modalShape = document.getElementById('modal-obj-shape');
  const modalLegThickness = document.getElementById('modal-obj-leg-thickness');
  const modalLegThicknessGroup = document.getElementById('modal-leg-thickness-group');
  const drawShapeBtn = document.getElementById('modal-draw-shape-btn');
  const modalFlipH = document.getElementById('modal-obj-flip-h');
  const modalFlipV = document.getElementById('modal-obj-flip-v');
  
  modalNumber.textContent = `#${idx + 1}`;
  modalLabel.value = obj.label || obj.typeGuess || '';
  modalWidth.value = obj.w || 60;
  modalDepth.value = obj.h || 60;
  modalRotation.value = obj.rotation || 0;
  modalShape.value = obj.shape || 'rectangle';
  modalLegThickness.value = obj.legThickness || 40;
  modalFlipH.checked = !!obj.flipH;
  modalFlipV.checked = !!obj.flipV;
  
  // Toggle visibility of conditional settings
  modalLegThicknessGroup.style.display = (modalShape.value === 'l-shape') ? 'flex' : 'none';
  drawShapeBtn.style.display = (modalShape.value === 'polygon') ? 'flex' : 'none';
  
  modalShape.onchange = () => {
    modalLegThicknessGroup.style.display = (modalShape.value === 'l-shape') ? 'flex' : 'none';
    drawShapeBtn.style.display = (modalShape.value === 'polygon') ? 'flex' : 'none';
  };

  modalFlipH.onchange = () => {
    obj.flipH = modalFlipH.checked;
    draw2D();
    rebuild3D();
  };

  modalFlipV.onchange = () => {
    obj.flipV = modalFlipV.checked;
    draw2D();
    rebuild3D();
  };
  
  modal.style.display = 'flex';
  
  // Draw custom shape button
  drawShapeBtn.onclick = () => {
    activeTool = 'draw-object-shape';
    drawingObjectPoints = [];
    modal.style.display = 'none';
    document.getElementById('custom-shape-instructions').style.display = 'flex';
    draw2D();
  };
  
  // Save button
  const saveBtn = document.getElementById('save-modal-btn');
  saveBtn.onclick = () => {
    obj.label = modalLabel.value.trim();
    obj.w = parseFloat(modalWidth.value) || 60;
    obj.h = parseFloat(modalDepth.value) || 60;
    obj.rotation = parseFloat(modalRotation.value) || 0;
    obj.shape = modalShape.value;
    obj.legThickness = parseFloat(modalLegThickness.value) || 40;
    obj.flipH = modalFlipH.checked;
    obj.flipV = modalFlipV.checked;
    
    modal.style.display = 'none';
    renderObjectLibrary();
    draw2D();
    rebuild3D();
  };
  
  // Delete button
  const deleteBtn = document.getElementById('delete-modal-btn');
  deleteBtn.onclick = () => {
    identifiedObjects = identifiedObjects.filter((_, i) => i !== idx);
    if (selectedObjectIndex === idx) selectedObjectIndex = -1;
    else if (selectedObjectIndex > idx) selectedObjectIndex--;
    
    modal.style.display = 'none';
    renderObjectLibrary();
    draw2D();
    rebuild3D();
  };
  
  // Close button
  const closeBtn = modal.querySelector('#close-modal-btn');
  closeBtn.onclick = () => {
    modal.style.display = 'none';
  };
}

function finishDrawingCustomShape() {
  if (drawingObjectPoints.length < 3) {
    alert("Please draw at least 3 points to define a custom polygon.");
    return;
  }
  
  // Remove duplicates/accidental extra clicks from double click
  const pts = [...drawingObjectPoints];
  if (pts.length > 3) {
    const last = pts[pts.length - 1];
    const secondLast = pts[pts.length - 2];
    if (Math.hypot(last.x - secondLast.x, last.y - secondLast.y) < 5) {
      pts.pop();
    }
  }

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  pts.forEach(p => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });

  const widthVal = maxX - minX;
  const depthVal = maxY - minY;
  const centerX = minX + widthVal / 2;
  const centerY = minY + depthVal / 2;

  const obj = identifiedObjects[selectedObjectIndex];
  if (obj) {
    obj.shape = 'polygon';
    obj.points = pts;
    obj.x = Math.round(centerX);
    obj.y = Math.round(centerY);
    obj.w = Math.round(widthVal);
    obj.h = Math.round(depthVal);
  }

  activeTool = 'select';
  drawingObjectPoints = [];
  document.getElementById('custom-shape-instructions').style.display = 'none';
  
  renderObjectLibrary();
  draw2D();
  rebuild3D();
  openObjectEditModal(selectedObjectIndex);
}

// Double click to finish drawing custom shape if in draw-object-shape mode
canvas2D.addEventListener('dblclick', e => {
  if (activeTool === 'draw-object-shape') {
    finishDrawingCustomShape();
  }
});

// ─── API Key Helper ───────────────────────────────────────────────────────────
function getApiHeaders(includeJson = false) {
  const headers = {};
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}

// ─── File Upload & Template ───────────────────────────────────────────────────
function handleFileSelect(file) {
  if (!file) return;
  uploadedFile = file;
  fileNameSpan.innerText = file.name;
  fileInfo.style.display = 'flex';

  const reader = new FileReader();
  reader.onload = function(e) {
    templateImageBase64 = e.target.result;
    const img = new Image();
    img.onload = function() {
      templateImage = img;
      resetViewOffset();
      draw2D();
      updatePipelineState();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removeFile() {
  templateImage = null;
  uploadedFile  = null;
  templateImageBase64 = null;
  fileInput.value = '';
  fileInfo.style.display = 'none';
  draw2D();
  updatePipelineState();
}

// ─── Auto Scan: one-shot full floor plan analysis ───────────────────────────
async function runAutoScan() {
  const file = uploadedFile;
  if (!file) return;

  scannerOverlay.querySelector('.scanner-text').textContent = 'Auto Scanning Floor Plan...';
  scannerOverlay.style.display = 'flex';
  if (autoScanBtn) autoScanBtn.disabled = true;
  showPipelineStatus('🔍 Auto Scanning: extracting walls, doors, objects and cameras in one shot...');

  await initSession();

  const formData = new FormData();
  formData.append('image', file);
  if (sessionId) formData.append('sessionId', sessionId);
  if (cadDesignBrief && cadDesignBrief.value.trim()) {
    formData.append('designBrief', cadDesignBrief.value.trim());
  }

  try {
    const response = await fetch('/api/cad/auto-scan', {
      method: 'POST', headers: getApiHeaders(), body: formData
    });
    const result = await handleAIResponse(response, 'Auto Scan');

    // ── 1. Walls & corners ──
    corners = result.corners || {};
    walls   = result.walls   || [];

    // ── 2. Scale calibration ──
    if (result.imageWidth && result.imageHeight) {
      calibrateWidth  = result.imageWidth  / 100;
      calibrateHeight = result.imageHeight / 100;
      widthInput.value  = calibrateWidth.toFixed(2);
      heightInput.value = calibrateHeight.toFixed(2);
    } else {
      // Fallback: derive from max corner coordinates
      let maxX = 0, maxY = 0;
      Object.values(corners).forEach(c => {
        if (c.x > maxX) maxX = c.x;
        if (c.y > maxY) maxY = c.y;
      });
      if (maxX > calibrateWidth  * 100) { calibrateWidth  = Math.ceil(maxX / 100); widthInput.value  = calibrateWidth; }
      if (maxY > calibrateHeight * 100) { calibrateHeight = Math.ceil(maxY / 100); heightInput.value = calibrateHeight; }
    }

    // ── 3. Objects (furniture) ──
    const furniture = (result.objects || []).map(o => ({
      ...o,
      label: o.typeGuess,
      referenceDescription: null,
      rotation: o.rotation || 0
    }));

    // ── 4. Doors → identifiedObjects with type 'door' (rebuild3D cuts wall openings automatically) ──
    const doors = (result.doors || []).map(d => ({
      id: d.id,
      x: d.x, y: d.y,
      w: d.w || 90, h: d.h || 200,
      typeGuess: 'door', label: 'door',
      referenceDescription: d.label || null,
      rotation: 0
    }));

    // ── 5. Windows → identifiedObjects with type 'window' (rebuild3D cuts wall openings automatically) ──
    const windows = (result.windows || []).map(w => ({
      id: w.id,
      x: w.x, y: w.y,
      w: w.w || 120, h: w.h || 120,
      typeGuess: 'window', label: 'window',
      referenceDescription: null,
      rotation: 0,
      sillHeight: w.sillHeight || 90
    }));

    identifiedObjects = [...furniture, ...doors, ...windows];

    // ── 6. Pre-seed AI-suggested cameras ──
    if (result.suggestedCameras && result.suggestedCameras.length > 0) {
      cameraPositions = result.suggestedCameras.map(cam => ({
        id:    cam.id,
        x:     cam.x,
        y:     cam.y,
        angle: cam.angle,
        label: cam.label || 'AI Camera',
        fov:   60
      }));
      selectedCamera = cameraPositions[0].id;
    }

    // ── 7. Store rooms data for context (used in blind render prompts) ──
    window._autoScanRooms = result.rooms || [];

    // ── 8. Render everything ──
    resetViewOffset();
    draw2D();
    renderObjectLibrary();
    updateCameraList();
    rebuild3D();
    updatePipelineState();

    // Show object panel
    cardObjects.style.display = '';
    if (viewObjects) viewObjects.disabled = false;
    setViewMode('split');
    setTool('select');

    const wallCount   = walls.length;
    const doorCount   = doors.length;
    const winCount    = windows.length;
    const objCount    = furniture.length;
    const camCount    = cameraPositions.length;
    showPipelineStatus(`✓ Auto Scan complete — ${wallCount} walls, ${doorCount} doors, ${winCount} windows, ${objCount} objects, ${camCount} camera${camCount !== 1 ? 's' : ''} pre-seeded. Ready for Blind AI Render!`);
    setTimeout(hidePipelineStatus, 6000);
  } catch (error) {
    alert(`Auto Scan failed: ${error.message}`);
    hidePipelineStatus();
  } finally {
    scannerOverlay.style.display = 'none';
    if (autoScanBtn) autoScanBtn.disabled = !uploadedFile;
  }
}

// ─── Step 1: AI Wall Trace ───────────────────────────────────────────────────
async function runAITrace() {
  const file = uploadedFile;
  if (!file) return;

  scannerOverlay.querySelector('.scanner-text').textContent = 'AI Tracing Walls...';
  scannerOverlay.style.display = 'flex';
  aiBtn.disabled = true;
  showPipelineStatus('Tracing walls with AI...');

  // Ensure session is initialized before AI call
  await initSession();

  const formData = new FormData();
  formData.append('image', file);
  if (sessionId) formData.append('sessionId', sessionId);
  if (cadDesignBrief && cadDesignBrief.value.trim()) {
    formData.append('designBrief', cadDesignBrief.value.trim());
  }

  try {
    const response = await fetch('/api/cad/trace', {
      method: 'POST', headers: getApiHeaders(), body: formData
    });
    const result = await handleAIResponse(response, 'Wall tracing');

    corners = result.corners || {};
    walls   = result.walls   || [];

    if (result.imageWidth && result.imageHeight) {
      calibrateWidth = result.imageWidth / 100;
      calibrateHeight = result.imageHeight / 100;
      widthInput.value = calibrateWidth.toFixed(2);
      heightInput.value = calibrateHeight.toFixed(2);
    } else {
      let maxX = 0, maxY = 0;
      Object.keys(corners).forEach(id => {
        if (corners[id].x > maxX) maxX = corners[id].x;
        if (corners[id].y > maxY) maxY = corners[id].y;
      });
      if (maxX > calibrateWidth * 100)  { calibrateWidth  = Math.ceil(maxX / 100); widthInput.value  = calibrateWidth; }
      if (maxY > calibrateHeight * 100) { calibrateHeight = Math.ceil(maxY / 100); heightInput.value = calibrateHeight; }
    }

    resetViewOffset();
    draw2D();
    rebuild3D();
    showPipelineStatus('✓ Walls traced. Run Step 2 to identify objects.');
    setTimeout(hidePipelineStatus, 3000);
  } catch (error) {
    alert(`Wall tracing failed: ${error.message}`);
    hidePipelineStatus();
  } finally {
    scannerOverlay.style.display = 'none';
    aiBtn.disabled = false;
  }
}

// ─── Step 2: AI Object Identification ────────────────────────────────────────
async function runIdentifyObjects() {
  const file = uploadedFile;
  if (!file) { alert('Upload a floor plan first.'); return; }

  scannerOverlay.querySelector('.scanner-text').textContent = 'AI Identifying Objects...';
  scannerOverlay.style.display = 'flex';
  identifyBtn.disabled = true;
  showPipelineStatus('Identifying furniture & fixtures...');

  await initSession();

  const formData = new FormData();
  formData.append('image', file);
  if (sessionId) formData.append('sessionId', sessionId);
  if (cadDesignBrief && cadDesignBrief.value.trim()) {
    formData.append('designBrief', cadDesignBrief.value.trim());
  }
  formData.append('calibrateWidth', calibrateWidth);
  formData.append('calibrateHeight', calibrateHeight);

  try {
    const response = await fetch('/api/cad/identify', {
      method: 'POST', headers: getApiHeaders(), body: formData
    });
    const result = await handleAIResponse(response, 'Object identification');

    identifiedObjects = (result.objects || []).map(obj => ({
      ...obj,
      label: obj.typeGuess,
      referenceDescription: null,
      rotation: 0
    }));

    // Fetch simplified 3D shapes (primitives) for custom/non-standard objects
    const standardTypes = [
      'dining_table', 'table', 'chair', 'bar_stool', 'sofa', 'counter',
      'kitchen_counter', 'bar', 'sink', 'stove', 'oven', 'refrigerator',
      'display_case', 'shelves', 'staircase', 'stairs', 'plant'
    ];
    const customObjs = identifiedObjects.filter(o => !standardTypes.includes((o.label || o.typeGuess || '').toLowerCase()));
    if (customObjs.length > 0) {
      showPipelineStatus('AI generating 3D shape breakdowns for custom objects...');
      try {
        const primsRes = await fetch('/api/cad/generate-primitives', {
          method: 'POST',
          headers: getApiHeaders(true),
          body: JSON.stringify({
            objects: customObjs,
            designBrief: cadDesignBrief ? cadDesignBrief.value.trim() : '',
            sessionId: sessionId
          })
        });
        if (primsRes.ok) {
          const primsData = await primsRes.json();
          const primitives = primsData.primitives || {};
          identifiedObjects.forEach(o => {
            if (primitives[o.id]) {
              o.primitives = primitives[o.id];
            }
          });
        }
      } catch (e) {
        console.error("Failed to generate primitives for custom objects:", e);
      }
    }

    draw2D();
    renderObjectLibrary();
    rebuild3D();

    // Switch to show object library + 2D split
    cardObjects.style.display = '';
    if (viewObjects) viewObjects.disabled = false;
    setViewMode('split-obj');
    setTool('select');

    showPipelineStatus(`✓ Found ${identifiedObjects.length} objects. Label them in the Object Library panel.`);
    setTimeout(hidePipelineStatus, 4000);
  } catch (error) {
    alert(`Object identification failed: ${error.message}`);
    hidePipelineStatus();
  } finally {
    scannerOverlay.style.display = 'none';
    identifyBtn.disabled = false;
  }
}

// ─── Step 2.5: AI Blender 3D Layout Preview ─────────────────────────────────
async function runBlenderAIPreview() {
  if (Object.keys(corners).length === 0) {
    alert('Draw or trace walls first.');
    return;
  }

  showPipelineStatus('AI generating customized Blender script...');
  aiBlenderPreviewBtn.disabled = true;

  setViewMode('split');
  if (tabBlender) tabBlender.click();

  if (blenderPreviewPlaceholder) {
    blenderPreviewPlaceholder.innerHTML = `
      <div class="render-spinner" style="border-top-color: hsl(var(--color-primary)); width: 40px; height: 40px;"></div>
      <p style="margin-top: 12px; font-weight: 500;">AI writing Blender code...</p>
      <span style="font-size: 11px; color: #64748b;">This takes 20-30 seconds</span>
    `;
    blenderPreviewPlaceholder.style.display = 'flex';
    blenderPreviewImg.style.display = 'none';
  }

  await initSession();

  const cam = cameraPositions.find(c => c.id === selectedCamera) || cameraPositions[0];
  const cameraPayload = cam ? {
    x: cam.x,
    y: cam.y,
    angle: cam.angle - 180,
    fov: cam.fov || 60,
    is3d: !!cam.is3d,
    px: cam.px,
    py: cam.py,
    pz: cam.pz,
    dx: cam.dx,
    dy: cam.dy,
    dz: cam.dz,
    aspect: cam.aspect || (1280 / 720)
  } : null;

  try {
    const payload = {
      walls:       walls,
      corners:     corners,
      objects:     identifiedObjects.map(obj => ({
        id:    obj.id,
        type:  obj.label || obj.typeGuess || 'generic',
        x:     obj.x, y: obj.y, w: obj.w || 60, h: obj.h || 60,
        rotation: obj.rotation || 0,
        shape: obj.shape || 'rectangle',
        points: obj.points || null,
        flipH: !!obj.flipH,
        flipV: !!obj.flipV,
      })),
      camera:      cameraPayload,
      floor_w:     calibrateWidth * 100,
      floor_h:     calibrateHeight * 100,
      wall_height: wallHeight,
      wall_thick:  wallThickness,
      designBrief: cadDesignBrief ? cadDesignBrief.value.trim() : '',
      sessionId:   sessionId
    };

    const response = await fetch('/api/cad/blender-ai-render', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify(payload)
    });

    const data = await handleAIResponse(response, 'blender-ai-render');
    if (data.imageUrl) {
      blenderPreviewImg.src = data.imageUrl;
      blenderPreviewImg.style.display = 'block';
      if (blenderPreviewPlaceholder) blenderPreviewPlaceholder.style.display = 'none';
      clearLoadedGLB(); // Ensure native Three.js 3D viewport remains pristine
      showPipelineStatus('✓ 3D Preview layout generated successfully!');
      setTimeout(hidePipelineStatus, 4000);
    } else {
      throw new Error('No image was returned from server.');
    }
  } catch (error) {
    alert(`Blender AI Preview failed: ${error.message}`);
    showPipelineStatus('Error generating 3D Preview.');
    setTimeout(hidePipelineStatus, 4000);
    if (blenderPreviewPlaceholder) {
      blenderPreviewPlaceholder.innerHTML = `
        <i data-lucide="alert-triangle" class="placeholder-icon" style="color: #ef4444;"></i>
        <p>Preview generation failed: ${error.message}</p>
        <button id="retry-blender-preview-btn" class="btn btn-mini" style="margin-top: 10px; padding: 4px 12px;">Retry</button>
      `;
      const retryBtn = document.getElementById('retry-blender-preview-btn');
      if (retryBtn) retryBtn.addEventListener('click', runBlenderAIPreview);
    }
  } finally {
    aiBlenderPreviewBtn.disabled = false;
    updatePipelineState();
  }
}

// Tab Switching for 3D Viewport (Three.js vs Blender Render)
function initPreviewTabs() {
  if (tabThree && tabBlender) {
    tabThree.addEventListener('click', () => {
      tabThree.classList.add('active');
      tabThree.style.background = 'hsl(var(--color-primary))';
      tabThree.style.color = 'white';
      
      tabBlender.classList.remove('active');
      tabBlender.style.background = 'transparent';
      tabBlender.style.color = '#94a3b8';
      
      viewer3dContainer.style.display = 'block';
      blenderPreviewContainer.style.display = 'none';
      setTimeout(() => onWindowResize(), 50);
    });

    tabBlender.addEventListener('click', () => {
      tabBlender.classList.add('active');
      tabBlender.style.background = 'hsl(var(--color-primary))';
      tabBlender.style.color = 'white';
      
      tabThree.classList.remove('active');
      tabThree.style.background = 'transparent';
      tabThree.style.color = '#94a3b8';
      
      viewer3dContainer.style.display = 'none';
      blenderPreviewContainer.style.display = 'block';
    });
  }
}

// ─── Step 2b: Describe Reference Photo ───────────────────────────────────────
async function describeObject(file) {
  const formData = new FormData();
  formData.append('image', file);
  const response = await fetch('/api/cad/describe-object', {
    method: 'POST', headers: getApiHeaders(), body: formData
  });
  const data = await handleAIResponse(response, 'Object description');
  return data.description || '';
}

// ─── Step 3: Camera Set (handled via 2D canvas tool + sidebar) ───────────────
function activateCameraMode() {
  setTool('camera');
  cameraPositionsSection.style.display = '';
  showPipelineStatus('Click on the 2D plan to place camera pin. Drag to set look direction.');
  setTimeout(hidePipelineStatus, 4000);
}

// ─── Step 4: Blender Render → Imagen ─────────────────────────────────────────
async function runBlenderRender() {
  if (cameraPositions.length === 0) { alert('Place at least one camera position first (Step 3).'); return; }
  if (Object.keys(corners).length === 0) { alert('Trace walls first (Step 1).'); return; }

  // Temporarily force render to make sure the 3D viewport is up-to-date
  renderer.render(scene, camera);
  const screenshot3d = renderer.domElement.toDataURL('image/jpeg', 0.95);

  // Open confirmation modal
  const confirmModal = document.getElementById('render-confirm-modal');
  const previewImg = document.getElementById('render-confirm-preview');
  const placeholder = document.getElementById('render-confirm-placeholder');
  
  previewImg.src = screenshot3d;
  previewImg.style.display = 'block';
  placeholder.style.display = 'none';
  confirmModal.style.display = 'flex';

  // Bind confirmation modal buttons
  const closeBtn = document.getElementById('close-render-confirm-btn');
  const adjustBtn = document.getElementById('adjust-render-btn');
  const proceedBtn = document.getElementById('proceed-render-btn');

  const closeModal = () => {
    confirmModal.style.display = 'none';
  };

  closeBtn.onclick = closeModal;
  adjustBtn.onclick = closeModal;
  confirmModal.onclick = (e) => {
    if (e.target === confirmModal) closeModal();
  };

  proceedBtn.onclick = () => {
    closeModal();
    executeBlenderRender();
  };
}

async function executeBlenderRender() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const liveAngle = Math.round(Math.atan2(dir.x, -dir.z) * 180 / Math.PI);
  const centerOffsetX = (calibrateWidth * 100) / 2;
  const centerOffsetZ = (calibrateHeight * 100) / 2;

  const liveCam = {
    id: 'live_viewport',
    x: Math.round(camera.position.x + centerOffsetX),
    y: Math.round(camera.position.z + centerOffsetZ),
    angle: liveAngle,
    is3d: true,
    px: camera.position.x,
    py: camera.position.y,
    pz: camera.position.z,
    dx: dir.x,
    dy: dir.y,
    dz: dir.z,
    fov: camera.fov,
    aspect: camera.aspect || (1280 / 720)
  };

  const userSelectedPin = selectedCamera ? cameraPositions.find(c => c.id === selectedCamera) : null;
  const cam = userSelectedPin || liveCam;

  // Switch to AI Render view
  setViewMode('ai');

  // Show loading with progress
  renderLoading.style.display = 'flex';
  renderProgressFill.style.width = '0%';
  regenerateBtn.style.display = 'none';
  aiRenderImg.style.display = 'none';
  aiRenderPlaceholder.style.display = 'none';
  blenderRenderBtn.disabled = true;

  const stages = [
    { text: 'Building 3D scene in Blender...', pct: 15 },
    { text: 'Extruding walls and placing furniture...', pct: 40 },
    { text: 'Rendering camera view...', pct: 70 },
    { text: 'Sending to Imagen AI...', pct: 85 },
    { text: 'Generating photorealistic image...', pct: 95 },
  ];
  let stageIdx = 0;
  function nextStage() {
    if (stageIdx < stages.length) {
      renderLoadingText.textContent = stages[stageIdx].text;
      renderProgressFill.style.width = stages[stageIdx].pct + '%';
      stageIdx++;
    }
  }
  nextStage();
  const stageTimer = setInterval(nextStage, 4000);

  try {
    // ── Phase A: Blender render ──
    const blenderPayload = {
      walls:       walls,
      corners:     corners,
      objects:     identifiedObjects.map((obj, i) => {
        let pts = obj.points;
        if (obj.shape === 'polygon' && pts && pts.length >= 3) {
          const cleanPts = [];
          pts.forEach(p => {
            if (cleanPts.length === 0) {
              cleanPts.push(p);
            } else {
              const last = cleanPts[cleanPts.length - 1];
              if (Math.hypot(p.x - last.x, p.y - last.y) > 0.1) {
                cleanPts.push(p);
              }
            }
          });
          if (cleanPts.length > 2) {
            const first = cleanPts[0];
            const last = cleanPts[cleanPts.length - 1];
            if (Math.hypot(last.x - first.x, last.y - first.y) < 0.1) {
              cleanPts.pop();
            }
          }
          pts = cleanPts;
        }
        return {
          id:    obj.id,
          type:  obj.label || obj.typeGuess || 'generic',
          x:     obj.x, y: obj.y, w: obj.w || 60, h: obj.h || 60,
          rotation: obj.rotation || 0,
          referenceDescription: obj.referenceDescription || '',
          flipH: !!obj.flipH,
          flipV: !!obj.flipV,
          shape: obj.shape || 'rectangle',
          legThickness: obj.legThickness || 40,
          points: pts || null
        };
      }),
      camera:      cam ? {
        x: cam.x,
        y: cam.y,
        angle: cam.angle - 180,
        fov: cam.fov || 60,
        is3d: !!cam.is3d,
        px: cam.px,
        py: cam.py,
        pz: cam.pz,
        dx: cam.dx,
        dy: cam.dy,
        dz: cam.dz,
        aspect: cam.aspect || (1280 / 720)
      } : { x: (calibrateWidth * 100) / 2, y: (calibrateHeight * 100) / 3, angle: 0, fov: 60, aspect: 1280 / 720 },
      floor_w:     calibrateWidth * 100,
      floor_h:     calibrateHeight * 100,
      wall_height: wallHeight,
      wall_thick:  wallThickness
    };

    const blenderRes = await fetch('/api/cad/blender-render', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify(blenderPayload)
    });

    if (!blenderRes.ok) {
      const errData = await blenderRes.json();
      throw new Error(`Blender render failed: ${errData.error || blenderRes.statusText}`);
    }

    const blenderData = await blenderRes.json();
    lastBlenderRender = blenderData.imageUrl;
    lastDepthMap = blenderData.depthUrl || null; // Store depth map from Blender
    clearLoadedGLB(); // Ensure Three.js 3D viewport remains 100% intact with pristine native walls

    nextStage(); // move to Imagen stage

    // ── Capture the 2D floor plan with object numbers as reference ──
    draw2D(); // Make sure the 2D floor plan is fully updated with numbers
    const screenshot2d = canvas2D.toDataURL('image/png');

    // ── Use previous AI render for cross-view style consistency (replaces Three.js screenshot) ──
    const screenshot3d = lastAIRender || renderer.domElement.toDataURL('image/png');

    // ── Phase B: Imagen render via /chat ──
    const objDescriptions = identifiedObjects
      .map((o, i) => {
        let shapePrefix = '';
        if (o.shape === 'l-shape') {
          shapePrefix = 'L-shaped ';
        } else if (o.shape === 'polygon') {
          shapePrefix = 'custom-drawn polygon shape (refer to its exact shape outline in the 2D plan and 3D view) ';
        }

        let positionText = '';
        if (cam) {
          const angleRad = (cam.angle || 0) * Math.PI / 180;
          const dx = o.x - cam.x;
          const dy = o.y - cam.y;
          const cartesianDy = -dy;
          const localX = dx * Math.cos(angleRad) - cartesianDy * Math.sin(angleRad);
          if (localX < -30) {
            positionText = ' (located on the screen-space LEFT side of the 3D screenshot)';
          } else if (localX > 30) {
            positionText = ' (located on the screen-space RIGHT side of the 3D screenshot)';
          } else {
            positionText = ' (located in the screen-space CENTER of the 3D screenshot)';
          }
        }

        return `- Object #${i + 1}: ${shapePrefix}${o.label || o.typeGuess || 'furniture'}${positionText}${o.referenceDescription ? ` (${o.referenceDescription})` : ''}`;
      })
      .join('\n');

    const designBrief = cadDesignBrief ? cadDesignBrief.value.trim() : '';

    const imagenMessage = `[CRITICAL REQUIREMENT]
You MUST vision and analyze the provided reference images (the Blender render, the 2D floor plan layout${lastAIRender ? ', and the previous AI render' : ''}) before generating your response. If you cannot access, load, or vision all of these images, you must immediately respond with an error message explaining that the reference images could not be loaded.

Generate a photorealistic 3D render of this space.
Floor plan dimensions: ${calibrateWidth}m × ${calibrateHeight}m.

For your reference, you are provided with images:
1. A Blender perspective render (used as the primary layout structure, depth, and spatial guide).
2. A 2D floor plan layout containing numbered circles that correspond to the identified objects listed below.
${lastAIRender ? '3. A PREVIOUS AI render of the SAME room (possibly from a different camera angle). You MUST maintain identical furniture styles, materials, colors, and lighting mood as shown in this previous render. This is critical for multi-view consistency.' : '3. A Three.js interactive 3D viewport screenshot showing the overall layout context.'}

${styleAnchor ? `MANDATORY STYLE LOCK — The following style was established in the first render and MUST be maintained in ALL subsequent renders from any camera angle. Any deviation from these materials, colors, and lighting is UNACCEPTABLE:\n"${styleAnchor}"\n` : ''}
Here is the exact mapping and location of the numbered objects as shown in the 2D floor plan:
${objDescriptions || 'No specific furniture or features identified.'}

${designBrief ? `Design style, mood, and space description: ${designBrief}\n` : ''}
Preserve the exact positions, spatial bounds, and shapes of all walls, boundaries, and the numbered objects exactly as shown in the references. Place each object exactly where its numbered circle is located. Note that objects located behind or next to the active camera position (refer to the camera pin in the 2D plan and the 3D viewport) will NOT be visible in the Blender perspective render. You must NOT draw or force them into the image frame if they are out of the camera's view frustum. Bring this space to life with realistic materials, textures, lighting, and appropriate surroundings.

CRITICAL POSITIONING RULE: You must map all descriptions of objects and furniture directly to the screen-space coordinates of the provided images. If an object appears on the left side, describe it as being on the left side of the image, and if it appears on the right side, describe it as being on the right side. Do NOT swap or invert the positions.`;

    const chatRes = await fetch('/api/cad/chat', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify({
        message:     imagenMessage,
        floorplan:   { corners, walls },
        objects:     identifiedObjects.map((o, idx) => ({
          number: idx + 1,
          type: o.label || o.typeGuess || 'generic',
          x: o.x,
          y: o.y,
          w: o.w || 60,
          h: o.h || 60,
          rotation: o.rotation || 0,
          shape: o.shape || 'rectangle'
        })),
        chatHistory: [],
        screenshot:   lastBlenderRender, // Blender render
        depthImage:   lastDepthMap,      // 3D Depth Map from Blender
        chatImage:    screenshot2d,      // 2D floor plan with numbers
        screenshot3d: screenshot3d,      // 3D interactive viewport screenshot
        sessionId:    sessionId
      })
    });

    const chatData = await handleAIResponse(chatRes, 'Imagen generation');

    clearInterval(stageTimer);
    renderProgressFill.style.width = '100%';
    renderLoadingText.textContent  = 'Done!';
    await new Promise(r => setTimeout(r, 500));

    if (chatData.imageUrl) {
      aiRenderImg.src           = chatData.imageUrl;
      aiRenderImg.style.display = 'block';
      regenerateBtn.style.display = '';
      lastAIRender = chatData.imageUrl; // Store AI render separately

      // Extract style anchor from the FIRST successful AI render for cross-view consistency
      if (!styleAnchor && chatData.reply) {
        styleAnchor = chatData.reply;
      }

      // Add chat message
      addChatMessage('model', chatData.reply || 'Photorealistic render generated from Blender scene!');
    } else {
      aiRenderPlaceholder.style.display = '';
      addChatMessage('model', chatData.reply || 'Render completed but no image was returned.');
    }

  } catch (error) {
    clearInterval(stageTimer);
    alert(`Render failed: ${error.message}`);
    aiRenderPlaceholder.style.display = '';
    hidePipelineStatus();
  } finally {
    renderLoading.style.display = 'none';
    blenderRenderBtn.disabled   = false;
  }
}

async function runBlindAIRender() {
  if (cameraPositions.length === 0) { alert('Place at least one camera position first (Step 3).'); return; }
  if (Object.keys(corners).length === 0) { alert('Trace walls first (Step 1).'); return; }

  renderer.render(scene, camera);
  const screenshot3d = renderer.domElement.toDataURL('image/png');
  
  draw2D();
  const screenshot2d = canvas2D.toDataURL('image/png');

  setViewMode('ai');

  renderLoading.style.display = 'flex';
  renderProgressFill.style.width = '0%';
  renderLoadingText.textContent = 'Stage 1: AI visioning 2D plan...';

  if (blindRenderBtn) blindRenderBtn.disabled = true;
  blenderRenderBtn.disabled = true;

  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const liveAngle = Math.round(Math.atan2(dir.x, -dir.z) * 180 / Math.PI);
  const centerOffsetX = (calibrateWidth * 100) / 2;
  const centerOffsetZ = (calibrateHeight * 100) / 2;

  const liveCam = {
    id: 'live_viewport',
    x: Math.round(camera.position.x + centerOffsetX),
    y: Math.round(camera.position.z + centerOffsetZ),
    angle: liveAngle,
    is3d: true,
    px: camera.position.x,
    py: camera.position.y,
    pz: camera.position.z,
    dx: dir.x,
    dy: dir.y,
    dz: dir.z,
    fov: camera.fov,
    aspect: camera.aspect || (1280 / 720)
  };

  const cam = (viewMode === '3d' || viewMode === 'split') ? liveCam : (cameraPositions.find(c => c.id === selectedCamera) || cameraPositions[0] || liveCam);
  const designBrief = cadDesignBrief ? cadDesignBrief.value.trim() : '';

  try {
    // ─── Stage 1 Request ───
    renderProgressFill.style.width = '15%';
    renderLoadingText.textContent = 'Stage 1: AI visioning 2D plan...';
    
    const stage1Res = await fetch('/api/cad/blind-render/stage1', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify({
        chatImage: screenshot2d,
        floorplan: { corners, walls },
        objects: identifiedObjects.map((obj, i) => ({
          number: i + 1,
          type: obj.label || obj.typeGuess || 'generic',
          x: obj.x,
          y: obj.y,
          w: obj.w || 60,
          h: obj.h || 60,
          rotation: obj.rotation || 0,
          shape: obj.shape || 'rectangle'
        })),
        camera: cam ? {
          x: cam.x,
          y: cam.y,
          angle: cam.angle - 180,
          fov: cam.fov || 60,
          is3d: !!cam.is3d,
          px: cam.px,
          py: cam.py,
          pz: cam.pz,
          dx: cam.dx,
          dy: cam.dy,
          dz: cam.dz
        } : null,
        designBrief: designBrief,
        sessionId: sessionId
      })
    });

    if (!stage1Res.ok) {
      const errData = await stage1Res.json();
      throw new Error(`Stage 1 failed: ${errData.error || stage1Res.statusText}`);
    }
    const { stage1Json } = await stage1Res.json();

    // ─── Stage 2 Request ───
    renderProgressFill.style.width = '50%';
    renderLoadingText.textContent = 'Stage 2: Verifying and refining layout description with 3D view...';

    const stage2Res = await fetch('/api/cad/blind-render/stage2', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify({
        screenshot3d: screenshot3d,
        stage1Json,
        designBrief,
        sessionId
      })
    });

    if (!stage2Res.ok) {
      const errData = await stage2Res.json();
      throw new Error(`Stage 2 failed: ${errData.error || stage2Res.statusText}`);
    }
    const { stage2Json } = await stage2Res.json();

    // ─── Stage 3 Request ───
    renderProgressFill.style.width = '80%';
    renderLoadingText.textContent = 'Stage 3: Generating image blindly without any visual reference...';

    const stage3Res = await fetch('/api/cad/blind-render/stage3', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify({
        stage2Json,
        sessionId
      })
    });

    if (!stage3Res.ok) {
      const errData = await stage3Res.json();
      throw new Error(`Stage 3 failed: ${errData.error || stage3Res.statusText}`);
    }
    const { imageUrl } = await stage3Res.json();

    renderProgressFill.style.width = '100%';
    renderLoadingText.textContent  = 'Done!';
    await new Promise(r => setTimeout(r, 500));

    if (imageUrl) {
      aiRenderImg.src = imageUrl;
      aiRenderImg.style.display = 'block';
      aiRenderPlaceholder.style.display = 'none';
      lastAIRender = imageUrl;
      regenerateBtn.style.display = '';

      addChatMessage('system', '🤖 Blind AI Render Complete!');
      if (stage1Json) {
        addChatMessage('model', `Stage 1 Plan Description:\n${JSON.stringify(stage1Json, null, 2)}`);
      }
      if (stage2Json) {
        addChatMessage('model', `Stage 2 Corrections & Prompt:\nCorrections: ${stage2Json.correctionsMade}\nPrompt: ${stage2Json.imagenPrompt}`);
      }
    } else {
      aiRenderPlaceholder.style.display = '';
      addChatMessage('model', 'Blind render completed but no image was returned.');
    }

  } catch (error) {
    alert(`Blind Render failed: ${error.message}`);
    aiRenderPlaceholder.style.display = '';
  } finally {
    renderLoading.style.display = 'none';
    if (blindRenderBtn) blindRenderBtn.disabled = false;
    blenderRenderBtn.disabled = false;
  }
}

// ─── Session Management ───────────────────────────────────────────────────────
function logToChat(type, text) {
  // Only show meaningful lines, skip debug noise
  if (type === 'debug') return;
  if (!text || text.length < 3) return;
  // Deduplicate consecutive identical messages
  const msgs = chatMessages.querySelectorAll('.chat-message.system');
  if (msgs.length > 0 && msgs[msgs.length - 1].querySelector('p')?.textContent === text) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-message system';
  const p = document.createElement('p');
  p.textContent = text;
  msgDiv.appendChild(p);
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function initSession() {
  if (sessionId || sessionInitializing) return;
  sessionInitializing = true;
  logToChat('system', '🔄 Initializing AI session...');
  try {
    const res = await fetch('/api/cad/session/init', { method: 'POST' });
    if (!res.ok) throw new Error('Session init failed');
    const data = await res.json();
    sessionId = data.sessionId;
    logToChat('system', `✅ Session ready: ${sessionId}`);
    startSessionLogs(sessionId);
    if (wipeSessionBtn) {
      wipeSessionBtn.disabled = false;
      wipeSessionBtn.title = `Wipe session: ${sessionId}`;
    }
    if (saveSessionBtn) {
      saveSessionBtn.disabled = false;
    }
    // Show session badge in chat header
    const badge = document.getElementById('chat-session-badge');
    const badgeLabel = document.getElementById('chat-session-id-label');
    if (badge) { badge.style.display = ''; }
    if (badgeLabel) { badgeLabel.textContent = sessionId; }
  } catch (err) {
    console.error('[initSession] Failed:', err);
    logToChat('system', `⚠️ Could not initialize session: ${err.message}. Proceeding without persistence.`);
  } finally {
    sessionInitializing = false;
  }
}

function startSessionLogs(sid) {
  if (sseEventSource) sseEventSource.close();
  sseEventSource = new EventSource(`/api/cad/session/logs/${sid}`);
  sseEventSource.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      logToChat(msg.type, msg.text);
    } catch (ex) {}
  };
  sseEventSource.onerror = () => {
    // SSE connection dropped, OK
  };
}

async function wipeSession() {
  if (!sessionId) { alert('No active session to wipe.'); return; }
  const confirmWipe = confirm(`Wipe session history for ${sessionId}?\nThis will clear conversation JSONL logs but keep rendered images.`);
  if (!confirmWipe) return;
  try {
    const res = await fetch(`/api/cad/session/${sessionId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      logToChat('system', `🗑️ Session ${sessionId} wiped. ${data.deleted.length} file(s) deleted.`);
      sessionId = null;
      if (sseEventSource) { sseEventSource.close(); sseEventSource = null; }
      if (wipeSessionBtn) wipeSessionBtn.disabled = true;
      if (saveSessionBtn) saveSessionBtn.disabled = true;
    } else {
      logToChat('system', `⚠️ Wipe errors: ${JSON.stringify(data.errors)}`);
    }
  } catch (err) {
    alert(`Wipe failed: ${err.message}`);
  }
}

// ─── Saved Sessions Persistence ───────────────────────────────────────────────
function base64ToFile(base64Data, filename) {
  const arr = base64Data.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new File([u8arr], filename, { type: mime });
}

async function saveActiveSession() {
  if (!sessionId) {
    alert('No active session initialized yet. Try uploading a template or running a step first.');
    return;
  }

  const state = {
    calibrateWidth,
    calibrateHeight,
    wallHeight,
    wallThickness,
    wallColor,
    corners,
    walls,
    identifiedObjects,
    cameraPositions,
    templateImageBase64,
    pipelineMode,
    chatHistory,
    lastBlenderRender,
    lastAIRender,
    styleAnchor,
    designBrief: cadDesignBrief ? cadDesignBrief.value.trim() : ''
  };

  try {
    const res = await fetch('/api/cad/session/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, state })
    });
    if (!res.ok) throw new Error('Save response was not OK');
    const data = await res.json();
    if (data.ok) {
      alert(`Session ${sessionId} successfully saved!`);
      logToChat('system', `💾 Saved session ${sessionId} to server`);
    } else {
      alert('Save failed: ' + (data.error || 'unknown error'));
    }
  } catch (err) {
    alert('Error saving session: ' + err.message);
  }
}

async function fetchSavedSessionsList() {
  if (!sessionsList) return;
  sessionsList.innerHTML = '<p class="empty-hint">Loading saved sessions...</p>';
  try {
    const res = await fetch('/api/cad/session/saved-list');
    if (!res.ok) throw new Error('Failed to fetch sessions list');
    const data = await res.json();
    const list = data.sessions || [];
    if (list.length === 0) {
      sessionsList.innerHTML = '<p class="empty-hint">No saved sessions found.</p>';
      return;
    }
    
    sessionsList.innerHTML = '';
    list.forEach(sess => {
      const item = document.createElement('div');
      item.className = 'session-item';
      item.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.06); gap:12px;';
      
      const dateStr = new Date(sess.updatedAt).toLocaleString();
      
      const infoSpan = document.createElement('span');
      infoSpan.style.cssText = 'color: #e2e8f0; font-size:13px; font-weight:500; display:flex; flex-direction:column; gap:2px;';
      infoSpan.innerHTML = `<strong>${sess.sessionId}</strong><span style="font-size:11px; color:#64748b;">${dateStr}</span>`;
      
      const actionsDiv = document.createElement('div');
      actionsDiv.style.cssText = 'display:flex; gap:6px;';
      
      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn btn-mini btn-primary';
      loadBtn.style.cssText = 'padding: 4px 10px; font-size:11px;';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => loadSavedSession(sess.sessionId));
      
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-mini btn-danger';
      delBtn.style.cssText = 'padding: 4px 10px; font-size:11px; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #f87171;';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteSavedSession(sess.sessionId));
      
      actionsDiv.appendChild(loadBtn);
      actionsDiv.appendChild(delBtn);
      
      item.appendChild(infoSpan);
      item.appendChild(actionsDiv);
      sessionsList.appendChild(item);
    });
  } catch (err) {
    sessionsList.innerHTML = `<p class="empty-hint" style="color:#ef4444;">Error: ${err.message}</p>`;
  }
}

async function loadSavedSession(sid) {
  try {
    logToChat('system', `📂 Loading session ${sid}... (initializing AI context)`);
    const res = await fetch(`/api/cad/session/load/${sid}`);
    if (!res.ok) throw new Error('Load response was not OK');
    const data = await res.json();
    
    sessionId = sid;
    
    // SSE logs will work now because the server re-registered the session in memory
    startSessionLogs(sessionId);
    
    if (wipeSessionBtn) {
      wipeSessionBtn.disabled = false;
      wipeSessionBtn.title = `Wipe session: ${sessionId}`;
    }
    if (saveSessionBtn) {
      saveSessionBtn.disabled = false;
    }
    const badge = document.getElementById('chat-session-badge');
    const badgeLabel = document.getElementById('chat-session-id-label');
    if (badge) { badge.style.display = ''; }
    if (badgeLabel) { badgeLabel.textContent = sessionId; }
    
    const state = data.state || {};
    calibrateWidth = state.calibrateWidth || 4.80;
    calibrateHeight = state.calibrateHeight || 11.60;
    wallHeight = state.wallHeight || 250;
    wallThickness = state.wallThickness || 15;
    wallColor = state.wallColor || '#e2e8f0';
    corners = state.corners || {};
    walls = state.walls || [];
    identifiedObjects = state.identifiedObjects || [];
    cameraPositions = state.cameraPositions || [];
    pipelineMode = state.pipelineMode || 'cad';
    chatHistory = state.chatHistory || [];
    lastBlenderRender = state.lastBlenderRender || null;
    lastAIRender = state.lastAIRender || null;
    styleAnchor = state.styleAnchor || null;
    
    widthInput.value = calibrateWidth;
    heightInput.value = calibrateHeight;
    wallHeightInput.value = wallHeight;
    wallThicknessInput.value = wallThickness;
    wallColorInput.value = wallColor;
    colorHex.innerText = wallColor;
    if (cadDesignBrief) {
      cadDesignBrief.value = state.designBrief || '';
    }
    
    if (viewObjects) {
      viewObjects.disabled = (identifiedObjects.length === 0);
    }
    
    chatMessages.innerHTML = '';
    if (chatHistory.length === 0) {
      const msgDiv = document.createElement('div');
      msgDiv.className = 'chat-message model';
      msgDiv.innerHTML = '<p>Hello! I\'m your AI Design Assistant. After generating a render, chat with me to refine it — change materials, lighting style, add decorations, or adjust the mood.</p>';
      chatMessages.appendChild(msgDiv);
    } else {
      chatHistory.forEach(msg => {
        const msgDiv = document.createElement('div');
        msgDiv.className = `chat-message ${msg.role}`;
        const p = document.createElement('p');
        p.textContent = msg.text;
        msgDiv.appendChild(p);
        chatMessages.appendChild(msgDiv);
      });
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    const displayRender = lastAIRender || lastBlenderRender;
    if (displayRender) {
      aiRenderImg.src = displayRender;
      aiRenderImg.style.display = 'block';
      aiRenderPlaceholder.style.display = 'none';
      if (regenerateBtn) regenerateBtn.style.display = '';
    } else {
      aiRenderImg.src = '';
      aiRenderImg.style.display = 'none';
      aiRenderPlaceholder.style.display = '';
      if (regenerateBtn) regenerateBtn.style.display = 'none';
    }
    
    templateImageBase64 = state.templateImageBase64 || null;
    if (templateImageBase64) {
      try {
        uploadedFile = base64ToFile(templateImageBase64, 'blueprint.png');
        fileNameSpan.innerText = 'blueprint.png';
        fileInfo.style.display = 'flex';
      } catch (fErr) {
        console.error('Failed to parse templateImageBase64 into File:', fErr);
        uploadedFile = null;
        fileInfo.style.display = 'none';
      }
      
      const img = new Image();
      img.onload = function() {
        templateImage = img;
        resetViewOffset();
        draw2D();
        rebuild3D();
        renderObjectLibrary();
        updateCameraList();
        updatePipelineState();
      };
      img.src = templateImageBase64;
    } else {
      templateImage = null;
      uploadedFile = null;
      fileInput.value = '';
      fileInfo.style.display = 'none';
      
      resetViewOffset();
      draw2D();
      rebuild3D();
      renderObjectLibrary();
      updateCameraList();
      updatePipelineState();
    }
    
    changePipelineMode(pipelineMode);
    
    logToChat('system', `📂 Restored session ${sessionId}`);
    alert(`Session ${sessionId} restored successfully!`);
    
    if (sessionsModal) sessionsModal.style.display = 'none';
    
  } catch (err) {
    alert('Error loading session: ' + err.message);
  }
}

async function deleteSavedSession(sid) {
  const confirmDel = confirm(`Are you sure you want to permanently delete saved session ${sid}?`);
  if (!confirmDel) return;
  try {
    const res = await fetch(`/api/cad/session/saved/${sid}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete response was not OK');
    const data = await res.json();
    if (data.ok) {
      logToChat('system', `🗑️ Deleted saved session ${sid} from server`);
      fetchSavedSessionsList();
    } else {
      alert('Delete failed: ' + (data.error || 'unknown error'));
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

// ─── Chat Assistant ───────────────────────────────────────────────────────────
function handleChatImageSelect(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    chatAttachedImageBase64 = e.target.result;
    if (chatPreviewThumbnail) chatPreviewThumbnail.src = e.target.result;
    if (chatPreviewFilename) chatPreviewFilename.textContent = file.name;
    if (chatAttachmentPreview) chatAttachmentPreview.style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

function removeChatAttachment() {
  chatAttachedImageBase64 = null;
  if (chatImageInput) chatImageInput.value = '';
  if (chatAttachmentPreview) chatAttachmentPreview.style.display = 'none';
}

function addChatMessage(role, text, imageBase64 = null) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role}`;
  
  if (imageBase64) {
    const img = document.createElement('img');
    img.src = imageBase64;
    img.style.cssText = 'max-width: 100%; max-height: 180px; border-radius: 8px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.1); object-fit: contain; display: block;';
    msgDiv.appendChild(img);
  }
  
  const p = document.createElement('p');
  p.textContent = text;
  msgDiv.appendChild(p);
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (role === 'user' || role === 'model') chatHistory.push({ role, text });
}

async function sendAssistantMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  
  const attachedImg = chatAttachedImageBase64;
  
  addChatMessage('user', text, attachedImg);

  if (pipelineMode === 'photo') {
    await runDirectDecorate(text);
    removeChatAttachment();
    return;
  }

  // In CAD mode, auto-switch to AI view so user sees render + chat
  if (pipelineMode === 'cad' && viewMode !== 'ai') {
    setViewMode('ai');
  }

  // Ensure session is initialized
  await initSession();

  chatSendBtn.disabled = true;
  const tempMsg = document.createElement('div');
  tempMsg.className = 'chat-message model';
  tempMsg.innerHTML = '<span class="typing-dots">Thinking...</span>';
  chatMessages.appendChild(tempMsg);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const response = await fetch('/api/cad/chat', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify({
        message:      text,
        floorplan:    { corners, walls },
        chatHistory:  chatHistory.slice(0, -1).map(h => ({ role: h.role, text: h.text })),
        screenshot:   lastBlenderRender,      // Always the ACTUAL Blender render
        screenshot3d: lastAIRender || null,    // Previous AI render for style consistency
        sessionId:    sessionId,
        designBrief:  cadDesignBrief ? cadDesignBrief.value.trim() : '',
        chatImage:    attachedImg
      })
    });

    if (chatMessages.contains(tempMsg)) chatMessages.removeChild(tempMsg);
    const result = await handleAIResponse(response, 'Chat Assistant');

    if (result.reply) addChatMessage('model', result.reply);
    if (result.floorplan) updateFloorplan(result.floorplan);
    if (result.imageUrl) {
      aiRenderImg.src = result.imageUrl;
      aiRenderImg.style.display = 'block';
      aiRenderPlaceholder.style.display = 'none';
      lastAIRender = result.imageUrl; // Store AI render separately — DO NOT overwrite lastBlenderRender
      regenerateBtn.style.display = '';
      addChatMessage('model', 'Render updated!');
    }
  } catch (error) {
    if (chatMessages.contains(tempMsg)) chatMessages.removeChild(tempMsg);
    addChatMessage('system', `Error: ${error.message}`);
  } finally {
    chatSendBtn.disabled = false;
    removeChatAttachment();
  }
}

// ─── Direct Photo Mode Logic (Option B) ──────────────────────────────────────
function changePipelineMode(mode) {

  pipelineMode = mode;
  
  modeCadBtn.classList.toggle('active', mode === 'cad');
  modePhotoBtn.classList.toggle('active', mode === 'photo');

  const cadUploadSection = document.getElementById('cad-upload-section');
  const photoUploadSection = document.getElementById('photo-upload-section');
  const markupToolsSection = document.getElementById('markup-tools-section');
  const photoPipelineSection = document.getElementById('photo-pipeline-section');
  const cadPipelineSection = document.getElementById('cad-pipeline-section');
  const cadEditorToolsSection = document.getElementById('cad-editor-tools-section');
  const cadDimensionsSection = document.getElementById('cad-dimensions-section');
  const cadCustomizerSection = document.getElementById('cad-customizer-section');
  const cameraPositionsSection = document.getElementById('camera-positions-section');
  const cadFileOpsSection = document.getElementById('cad-file-ops-section');
  const placeholderText = document.getElementById('ai-render-placeholder-text');

  if (mode === 'photo') {
    cadUploadSection.style.display = 'none';
    cadPipelineSection.style.display = 'none';
    cadEditorToolsSection.style.display = 'none';
    cadDimensionsSection.style.display = 'none';
    cadCustomizerSection.style.display = 'none';
    cameraPositionsSection.style.display = 'none';
    cadFileOpsSection.style.display = 'none';

    photoUploadSection.style.display = '';
    markupToolsSection.style.display = '';
    photoPipelineSection.style.display = '';

    viewSplit.style.display = 'none';
    view2d.style.display = 'none';
    view3d.style.display = 'none';
    viewAi.style.display = 'none';
    fpsBtn.style.display = 'none';

    if (placeholderText) {
      placeholderText.innerHTML = 'Upload a photograph of your empty space in the sidebar, then draw/shade on the photo and write a description to generate decorated renders.';
    }

    setViewMode('ai');
    
    annotationStrokes = [];
    redrawAnnotationStrokes();
    
    initialPromptInput.value = '';
    initialPromptGroup.style.display = (chatHistory.length === 0) ? '' : 'none';
    
    if (photoImage) {
      aiRenderImg.src = aiRenderImg.dataset.photoSrc || photoImage.src;
      aiRenderImg.style.display = 'block';
      aiRenderPlaceholder.style.display = 'none';
      downloadRenderBtn.style.display = '';
      regenerateBtn.style.display = '';
      setTimeout(() => resizeAnnotationCanvas(), 100);
    } else {
      aiRenderImg.style.display = 'none';
      aiRenderPlaceholder.style.display = 'flex';
      downloadRenderBtn.style.display = 'none';
      regenerateBtn.style.display = 'none';
      annotationCanvas.style.display = 'none';
    }
  } else {
    cadUploadSection.style.display = '';
    cadPipelineSection.style.display = '';
    cadEditorToolsSection.style.display = '';
    cadDimensionsSection.style.display = '';
    cadCustomizerSection.style.display = '';
    cadFileOpsSection.style.display = '';
    if (cameraPositions.length > 0 || hasWalls) {
      cameraPositionsSection.style.display = '';
    }

    photoUploadSection.style.display = 'none';
    markupToolsSection.style.display = 'none';
    photoPipelineSection.style.display = 'none';

    viewSplit.style.display = '';
    view2d.style.display = '';
    view3d.style.display = '';
    viewAi.style.display = '';
    fpsBtn.style.display = '';

    if (placeholderText) {
      placeholderText.innerHTML = 'Complete Steps 1–3 in the sidebar, then click <strong>Step 4 — Render Scene</strong> to generate a photorealistic 3D render via Blender + Imagen.';
    }

    annotationCanvas.style.display = 'none';
    setViewMode('split');
    updatePipelineState();
  }
  
  setTimeout(() => {
    lucide.createIcons();
  }, 50);
}

function handlePhotoSelect(file) {
  if (!file) return;
  photoFile = file;
  photoFileName.innerText = file.name;
  photoFileInfo.style.display = 'flex';
  photoGenerateBtn.disabled = false;

  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      photoImage = img;
      aiRenderImg.dataset.photoSrc = e.target.result;
      aiRenderImg.src = e.target.result;
      aiRenderImg.style.display = 'block';
      aiRenderPlaceholder.style.display = 'none';
      downloadRenderBtn.style.display = '';
      regenerateBtn.style.display = '';
      annotationStrokes = [];
      setTimeout(() => resizeAnnotationCanvas(), 100);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function removePhoto() {
  photoImage = null;
  photoFile = null;
  photoFileInput.value = '';
  photoFileInfo.style.display = 'none';
  photoGenerateBtn.disabled = true;
  
  aiRenderImg.style.display = 'none';
  aiRenderPlaceholder.style.display = 'flex';
  downloadRenderBtn.style.display = 'none';
  regenerateBtn.style.display = 'none';
  annotationCanvas.style.display = 'none';
  annotationStrokes = [];
  
  initialPromptInput.value = '';
  initialPromptGroup.style.display = '';
}

function resizeAnnotationCanvas() {
  const img = document.getElementById('ai-render-img');
  const canvas = document.getElementById('annotation-canvas');
  if (!img || !canvas || img.style.display === 'none' || pipelineMode !== 'photo') {
    canvas.style.display = 'none';
    return;
  }

  const imgRect = img.getBoundingClientRect();
  const container = document.getElementById('ai-render-container');
  const containerRectActual = container.getBoundingClientRect();

  canvas.style.left = (imgRect.left - containerRectActual.left) + 'px';
  canvas.style.top = (imgRect.top - containerRectActual.top) + 'px';
  canvas.style.width = imgRect.width + 'px';
  canvas.style.height = imgRect.height + 'px';
  
  canvas.width = imgRect.width;
  canvas.height = imgRect.height;
  canvas.style.display = 'block';

  redrawAnnotationStrokes();
}

function setupAnnotationDrawing() {
  const canvas = document.getElementById('annotation-canvas');
  const ctx = canvas.getContext('2d');

  canvas.addEventListener('mousedown', e => {
    if (pipelineMode !== 'photo') return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    isDrawingAnnotation = true;
    const normX = x / canvas.width;
    const normY = y / canvas.height;

    currentStroke = {
      type: activeMarkupTool,
      color: activeMarkupColor,
      size: activeMarkupSize,
      points: [{ x: normX, y: normY }]
    };
    
    if (activeMarkupTool === 'dashed' || activeMarkupTool === 'circle') {
      currentStroke.points.push({ x: normX, y: normY });
    }
    
    redrawAnnotationStrokes();
  });

  canvas.addEventListener('mousemove', e => {
    if (!isDrawingAnnotation || !currentStroke) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const normX = x / canvas.width;
    const normY = y / canvas.height;

    if (currentStroke.type === 'free' || currentStroke.type === 'shade') {
      currentStroke.points.push({ x: normX, y: normY });
    } else {
      currentStroke.points[1] = { x: normX, y: normY };
    }

    redrawAnnotationStrokes();
  });

  canvas.addEventListener('mouseup', () => {
    if (!isDrawingAnnotation) return;
    isDrawingAnnotation = false;
    if (currentStroke && currentStroke.points.length > 0) {
      annotationStrokes.push(currentStroke);
    }
    currentStroke = null;
    redrawAnnotationStrokes();
  });

  canvas.addEventListener('mouseleave', () => {
    if (isDrawingAnnotation) {
      isDrawingAnnotation = false;
      if (currentStroke && currentStroke.points.length > 0) {
        annotationStrokes.push(currentStroke);
      }
      currentStroke = null;
      redrawAnnotationStrokes();
    }
  });
}

function drawStroke(ctx, stroke, width, height) {
  if (stroke.points.length === 0) return;

  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  if (stroke.type === 'shade') {
    ctx.strokeStyle = stroke.color + '55';
  }

  if (stroke.type === 'free' || stroke.type === 'shade') {
    ctx.beginPath();
    const startX = stroke.points[0].x * width;
    const startY = stroke.points[0].y * height;
    ctx.moveTo(startX, startY);
    
    for (let i = 1; i < stroke.points.length; i++) {
      const px = stroke.points[i].x * width;
      const py = stroke.points[i].y * height;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  } else if (stroke.type === 'dashed') {
    ctx.save();
    ctx.setLineDash([10, 6]);
    ctx.beginPath();
    const startX = stroke.points[0].x * width;
    const startY = stroke.points[0].y * height;
    const endX = stroke.points[1].x * width;
    const endY = stroke.points[1].y * height;
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.restore();
  } else if (stroke.type === 'circle') {
    ctx.beginPath();
    const startX = stroke.points[0].x * width;
    const startY = stroke.points[0].y * height;
    const endX = stroke.points[1].x * width;
    const endY = stroke.points[1].y * height;
    const radius = Math.hypot(endX - startX, endY - startY);
    
    ctx.arc(startX, startY, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function redrawAnnotationStrokes() {
  const canvas = document.getElementById('annotation-canvas');
  if (!canvas || canvas.style.display === 'none') return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  annotationStrokes.forEach(stroke => {
    drawStroke(ctx, stroke, canvas.width, canvas.height);
  });
  
  if (currentStroke) {
    drawStroke(ctx, currentStroke, canvas.width, canvas.height);
  }
}

function getCleanImageBase64() {
  return new Promise((resolve) => {
    const imgElement = document.getElementById('ai-render-img');
    if (!imgElement || imgElement.style.display === 'none') {
      resolve(null);
      return;
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const tempImg = new Image();
    tempImg.crossOrigin = 'anonymous';
    tempImg.onload = function() {
      canvas.width = tempImg.naturalWidth;
      canvas.height = tempImg.naturalHeight;
      ctx.drawImage(tempImg, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    tempImg.onerror = function() {
      console.error('Failed to load image for clean export');
      resolve(null);
    };
    tempImg.src = imgElement.src;
  });
}

function getAnnotatedImageBase64() {
  return new Promise((resolve) => {
    const imgElement = document.getElementById('ai-render-img');
    if (!imgElement || imgElement.style.display === 'none') {
      resolve(null);
      return;
    }
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const tempImg = new Image();
    tempImg.crossOrigin = 'anonymous';
    tempImg.onload = function() {
      canvas.width = tempImg.naturalWidth;
      canvas.height = tempImg.naturalHeight;
      ctx.drawImage(tempImg, 0, 0);
      
      annotationStrokes.forEach(stroke => {
        if (stroke.points.length === 0) return;
        
        ctx.strokeStyle = stroke.color;
        const displayWidth = document.getElementById('annotation-canvas').width || 1;
        const scaleFactor = tempImg.naturalWidth / displayWidth;
        ctx.lineWidth = stroke.size * scaleFactor;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        if (stroke.type === 'shade') {
          ctx.strokeStyle = stroke.color + '55';
        }

        if (stroke.type === 'free' || stroke.type === 'shade') {
          ctx.beginPath();
          const startX = stroke.points[0].x * canvas.width;
          const startY = stroke.points[0].y * canvas.height;
          ctx.moveTo(startX, startY);
          
          for (let i = 1; i < stroke.points.length; i++) {
            const px = stroke.points[i].x * canvas.width;
            const py = stroke.points[i].y * canvas.height;
            ctx.lineTo(px, py);
          }
          ctx.stroke();
        } else if (stroke.type === 'dashed') {
          ctx.save();
          ctx.setLineDash([10 * scaleFactor, 6 * scaleFactor]);
          ctx.beginPath();
          const startX = stroke.points[0].x * canvas.width;
          const startY = stroke.points[0].y * canvas.height;
          const endX = stroke.points[1].x * canvas.width;
          const endY = stroke.points[1].y * canvas.height;
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
          ctx.restore();
        } else if (stroke.type === 'circle') {
          ctx.beginPath();
          const startX = stroke.points[0].x * canvas.width;
          const startY = stroke.points[0].y * canvas.height;
          const endX = stroke.points[1].x * canvas.width;
          const endY = stroke.points[1].y * canvas.height;
          const radius = Math.hypot(endX - startX, endY - startY);
          
          ctx.arc(startX, startY, radius, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
      
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    tempImg.onerror = function() {
      console.error('Failed to load image for annotation merge');
      resolve(null);
    };
    tempImg.src = imgElement.src;
  });
}

async function runDirectDecorate(message) {
  if (pipelineMode !== 'photo') return;
  if (!photoFile) { alert('Upload a room photograph first.'); return; }

  setViewMode('ai');

  renderLoading.style.display = 'flex';
  renderProgressFill.style.width = '20%';
  renderLoadingText.textContent = 'Analyzing marked areas...';
  downloadRenderBtn.style.display = 'none';
  regenerateBtn.style.display = 'none';
  photoGenerateBtn.disabled = true;

  try {
    renderProgressFill.style.width = '40%';
    renderLoadingText.textContent = 'Generating annotated overlay...';
    
    const baseImageBase64 = await getCleanImageBase64();
    const annotatedImageBase64 = await getAnnotatedImageBase64();
    
    renderProgressFill.style.width = '60%';
    renderLoadingText.textContent = 'Refining design with Vision AI...';

    const response = await fetch('/api/cad/direct-decorate', {
      method: 'POST',
      headers: getApiHeaders(true),
      body: JSON.stringify({
        message: message,
        baseImage: baseImageBase64,
        annotatedImage: annotatedImageBase64,
        chatHistory: chatHistory,
        sessionId: sessionId
      })
    });

    renderProgressFill.style.width = '80%';
    renderLoadingText.textContent = 'Generating photorealistic textures...';

    const result = await handleAIResponse(response, 'Direct decoration');

    renderProgressFill.style.width = '100%';
    renderLoadingText.textContent = 'Done!';
    await new Promise(r => setTimeout(r, 500));

    if (result.imageUrl) {
      annotationStrokes = [];
      redrawAnnotationStrokes();

      aiRenderImg.src = result.imageUrl;
      aiRenderImg.style.display = 'block';
      
      downloadRenderBtn.style.display = '';
      regenerateBtn.style.display = '';
      aiRenderPlaceholder.style.display = 'none';

      aiRenderImg.onload = function() {
        resizeAnnotationCanvas();
        aiRenderImg.onload = null;
      };

      if (result.reply) {
        addChatMessage('model', result.reply);
      }
    } else {
      if (result.reply) {
        addChatMessage('model', result.reply);
      }
      alert('Render completed but no image was returned.');
    }

  } catch (error) {
    alert(`Design generation failed: ${error.message}`);
    hidePipelineStatus();
  } finally {
    renderLoading.style.display = 'none';
    photoGenerateBtn.disabled = false;
  }
}


// ─── Import / Export ─────────────────────────────────────────────────────────
function exportLayout() {
  const data = { calibrateWidth, calibrateHeight, wallHeight, wallThickness, wallColor,
    corners, walls, identifiedObjects, cameraPositions, templateImageBase64 };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `floorplan_${Math.round(Date.now() / 1000)}.json`;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function importLayout(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const data = JSON.parse(evt.target.result);
      calibrateWidth  = data.calibrateWidth  || 4.80;
      calibrateHeight = data.calibrateHeight || 11.60;
      wallHeight      = data.wallHeight      || 250;
      wallThickness   = data.wallThickness   || 15;
      wallColor       = data.wallColor       || '#e2e8f0';
      widthInput.value  = calibrateWidth;
      heightInput.value = calibrateHeight;
      wallHeightInput.value    = wallHeight;
      wallThicknessInput.value = wallThickness;
      wallColorInput.value     = wallColor;
      colorHex.innerText       = wallColor;
      corners           = data.corners           || {};
      walls             = data.walls             || [];
      identifiedObjects = data.identifiedObjects || [];
      if (viewObjects) {
        viewObjects.disabled = (identifiedObjects.length === 0);
      }
      cameraPositions   = data.cameraPositions   || [];

      templateImageBase64 = data.templateImageBase64 || null;
      if (templateImageBase64) {
        try {
          uploadedFile = base64ToFile(templateImageBase64, 'blueprint.png');
          fileNameSpan.innerText = 'blueprint.png';
          fileInfo.style.display = 'flex';
        } catch (fErr) {
          console.error('Failed to parse templateImageBase64 into File:', fErr);
          uploadedFile = null;
          fileInfo.style.display = 'none';
        }

        const img = new Image();
        img.onload = function() {
          templateImage = img;
          resetViewOffset(); draw2D(); rebuild3D();
          renderObjectLibrary(); updateCameraList();
          updatePipelineState();
        };
        img.src = templateImageBase64;
      } else {
        templateImage = null;
        uploadedFile = null;
        fileInput.value = '';
        fileInfo.style.display = 'none';

        resetViewOffset(); draw2D(); rebuild3D();
        renderObjectLibrary(); updateCameraList();
        updatePipelineState();
      }
    } catch (err) { alert('Error parsing JSON: ' + err.message); }
  };
  reader.readAsText(file);
}

function updateFloorplan(newFloorplan) {
  if (!newFloorplan) return;
  corners = newFloorplan.corners || {};
  walls   = newFloorplan.walls   || [];
  let maxX = 0, maxY = 0;
  Object.keys(corners).forEach(id => {
    if (corners[id].x > maxX) maxX = corners[id].x;
    if (corners[id].y > maxY) maxY = corners[id].y;
  });
  if (maxX > calibrateWidth * 100)  { calibrateWidth  = Math.ceil(maxX / 100); widthInput.value  = calibrateWidth; }
  if (maxY > calibrateHeight * 100) { calibrateHeight = Math.ceil(maxY / 100); heightInput.value = calibrateHeight; }
  resetViewOffset(); draw2D(); rebuild3D();
}

// ─── Walk Mode ───────────────────────────────────────────────────────────────
function setupFPSControls() {
  document.addEventListener('keydown', e => {
    switch (e.code) {
      case 'ArrowUp':    case 'KeyW': moveForward  = true; break;
      case 'ArrowLeft':  case 'KeyA': moveLeft     = true; break;
      case 'ArrowDown':  case 'KeyS': moveBackward = true; break;
      case 'ArrowRight': case 'KeyD': moveRight    = true; break;
    }
  });
  document.addEventListener('keyup', e => {
    switch (e.code) {
      case 'ArrowUp':    case 'KeyW': moveForward  = false; break;
      case 'ArrowLeft':  case 'KeyA': moveLeft     = false; break;
      case 'ArrowDown':  case 'KeyS': moveBackward = false; break;
      case 'ArrowRight': case 'KeyD': moveRight    = false; break;
    }
  });
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement !== renderer.domElement) exitWalkMode();
  });
}

function enterWalkMode() {
  if (walls.length === 0) { alert('Draw walls before entering walk mode!'); return; }
  renderer.domElement.requestPointerLock();
  fpsActive = true;
  walkInstructions.style.display = 'block';
  fpsBtn.innerHTML = '<i data-lucide="x"></i> Exit Walk';
  lucide.createIcons();
  controls.enabled = false;
  camera.position.set(0, playerHeight, 0);
  camera.lookAt(0, playerHeight, -100);
}

function exitWalkMode() {
  fpsActive = false;
  walkInstructions.style.display = 'none';
  fpsBtn.innerHTML = '<i data-lucide="footprints"></i> Walk Mode';
  lucide.createIcons();
  controls.enabled = true;
  camera.position.set(0, 400, 600);
  controls.target.set(0, 0, 0);
}

function handleWalkMode() {
  const time  = performance.now();
  const delta = (time - prevTime) / 1000;
  velocity.x -= velocity.x * 10.0 * delta;
  velocity.z -= velocity.z * 10.0 * delta;
  direction.z = Number(moveForward) - Number(moveBackward);
  direction.x = Number(moveRight) - Number(moveLeft);
  direction.normalize();
  const speed = 2500.0;
  if (moveForward  || moveBackward) velocity.z -= direction.z * speed * delta;
  if (moveLeft     || moveRight)    velocity.x -= direction.x * speed * delta;
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir); camDir.y = 0; camDir.normalize();
  const camRight = new THREE.Vector3();
  camRight.crossVectors(camDir, camera.up).normalize();
  camera.position.addScaledVector(camDir,   -velocity.z * delta * 0.05);
  camera.position.addScaledVector(camRight,  velocity.x * delta * 0.05);
  prevTime = time;
}

document.addEventListener('mousemove', e => {
  if (!fpsActive || document.pointerLockElement !== renderer.domElement) return;
  camera.rotation.y -= (e.movementX || 0) * 0.002;
  camera.rotation.x -= (e.movementY || 0) * 0.002;
  camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, camera.rotation.x));
});

// ─── View Modes ──────────────────────────────────────────────────────────────
function setTool(tool) {
  activeTool = tool;
  toolSelect.classList.toggle('active', tool === 'select');
  toolDraw.classList.toggle('active',   tool === 'draw');
  toolDelete.classList.toggle('active', tool === 'delete');
  toolCamera.classList.toggle('active', tool === 'camera');
  drawingStartCorner = null;
  
  // Clean up custom shape banner if switching away
  document.getElementById('custom-shape-instructions').style.display = 'none';
  drawingObjectPoints = [];
  
  draw2D();
}

function setViewMode(mode) {
  viewMode = mode;

  // Update toggle buttons
  viewSplit.classList.toggle('active', mode === 'split');
  view2d.classList.toggle('active',    mode === '2d');
  view3d.classList.toggle('active',    mode === '3d');
  if (viewObjects) viewObjects.classList.toggle('active', mode === 'split-obj');
  viewAi.classList.toggle('active',    mode === 'ai');

  // Control viewport cards visibility
  const card2d  = document.getElementById('card-2d');
  const card3d  = document.getElementById('card-3d');

  // Reset grid classes
  viewportsGrid.className = 'viewports-grid';

  if (mode === 'split') {
    card2d.style.display    = '';
    card3d.style.display    = '';
    cardAi.style.display    = 'none';
    cardObjects.style.display = 'none';
    cardChat.style.display  = 'none';
  } else if (mode === 'split-obj') {
    card2d.style.display    = '';
    card3d.style.display    = 'none';
    cardAi.style.display    = 'none';
    cardObjects.style.display = '';
    cardChat.style.display  = 'none';
    viewportsGrid.classList.add('single-2d');
  } else if (mode === '2d') {
    card2d.style.display    = '';
    card3d.style.display    = 'none';
    cardAi.style.display    = 'none';
    cardObjects.style.display = 'none';
    cardChat.style.display  = 'none';
    viewportsGrid.classList.add('single-2d');
  } else if (mode === '3d') {
    card2d.style.display    = 'none';
    card3d.style.display    = '';
    cardAi.style.display    = 'none';
    cardObjects.style.display = 'none';
    cardChat.style.display  = 'none';
    viewportsGrid.classList.add('single-3d');
  } else if (mode === 'ai') {
    card2d.style.display    = 'none';
    card3d.style.display    = 'none';
    cardAi.style.display    = '';
    cardObjects.style.display = 'none';
    cardChat.style.display  = '';
    viewportsGrid.classList.add('single-ai');
  }

  setTimeout(() => onWindowResize(), 50);
}

// ─── Bind All UI Events ───────────────────────────────────────────────────────
function bindUIEvents() {
  // Mode selection
  modeCadBtn.addEventListener('click', () => changePipelineMode('cad'));
  modePhotoBtn.addEventListener('click', () => changePipelineMode('photo'));

  // Drag & Drop for CAD blueprint
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleFileSelect(e.target.files[0]));
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    handleFileSelect(e.dataTransfer.files[0]);
  });
  removeFileBtn.addEventListener('click', removeFile);

  // Drag & Drop for Direct Photo
  photoDropZone.addEventListener('click', () => photoFileInput.click());
  photoFileInput.addEventListener('change', e => handlePhotoSelect(e.target.files[0]));
  photoDropZone.addEventListener('dragover',  e => { e.preventDefault(); photoDropZone.classList.add('dragover'); });
  photoDropZone.addEventListener('dragleave', () => photoDropZone.classList.remove('dragover'));
  photoDropZone.addEventListener('drop', e => {
    e.preventDefault(); photoDropZone.classList.remove('dragover');
    handlePhotoSelect(e.dataTransfer.files[0]);
  });
  removePhotoBtn.addEventListener('click', removePhoto);

  // Photo Pipeline Generate
  photoGenerateBtn.addEventListener('click', () => {
    if (chatHistory.length === 0) {
      const initialPrompt = initialPromptInput.value.trim();
      if (!initialPrompt) {
        alert("Please describe your design style or theme first in the text area!");
        initialPromptInput.focus();
        return;
      }
      chatInput.value = initialPrompt;
      sendAssistantMessage();
      initialPromptGroup.style.display = 'none';
    } else {
      const text = chatInput.value.trim();
      if (text) {
        sendAssistantMessage();
      } else {
        const promptMsg = prompt("Describe what you want to place or modify in the marked areas:");
        if (promptMsg && promptMsg.trim()) {
          chatInput.value = promptMsg;
          sendAssistantMessage();
        }
      }
    }
  });

  // Markup & Shading Tools
  document.querySelectorAll('.markup-tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.markup-tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeMarkupTool = btn.id.replace('markup-brush-', '');
    });
  });

  document.querySelectorAll('.color-dot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.color-dot-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeMarkupColor = btn.dataset.color;
    });
  });

  brushSizeInput.addEventListener('input', e => {
    activeMarkupSize = parseInt(e.target.value);
  });

  document.getElementById('markup-undo').addEventListener('click', () => {
    annotationStrokes.pop();
    redrawAnnotationStrokes();
  });

  document.getElementById('markup-clear').addEventListener('click', () => {
    annotationStrokes = [];
    redrawAnnotationStrokes();
  });

  // Download render action
  downloadRenderBtn.addEventListener('click', async () => {
    const imgElement = document.getElementById('ai-render-img');
    if (!imgElement || !imgElement.src) return;
    
    try {
      showPipelineStatus('Preparing download...');
      const response = await fetch(imgElement.src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      let filename = 'decorated_render.jpg';
      const urlParts = imgElement.src.split('/');
      if (urlParts.length > 0) {
        filename = urlParts[urlParts.length - 1];
      }
      if (!filename.endsWith('.jpg') && !filename.endsWith('.png')) {
        filename += '.jpg';
      }
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      hidePipelineStatus();
    } catch (err) {
      console.error('Download failed:', err);
      window.open(imgElement.src, '_blank');
      hidePipelineStatus();
    }
  });

  // Image load auto-resizer for annotation canvas
  aiRenderImg.addEventListener('load', () => {
    if (pipelineMode === 'photo') {
      resizeAnnotationCanvas();
    }
  });

  // Pipeline steps
  if (autoScanBtn) autoScanBtn.addEventListener('click', runAutoScan);
  aiBtn.addEventListener('click', runAITrace);
  if (skipTraceCheckbox) {
    skipTraceCheckbox.addEventListener('change', () => {
      updatePipelineState();
    });
  }
  identifyBtn.addEventListener('click', runIdentifyObjects);
  aiBlenderPreviewBtn.addEventListener('click', runBlenderAIPreview);
  setCameraBtn.addEventListener('click', activateCameraMode);
  blenderRenderBtn.addEventListener('click', runBlenderRender);
  if (blindRenderBtn) {
    blindRenderBtn.addEventListener('click', runBlindAIRender);
  }
  regenerateBtn.addEventListener('click', runBlenderRender);

  // Confirm objects
  confirmObjectsBtn.addEventListener('click', () => {
    updatePipelineState();
    setViewMode('split');
    showPipelineStatus(`✓ ${identifiedObjects.length} objects confirmed. Now set camera position (Step 3).`);
    setTimeout(hidePipelineStatus, 4000);
  });

  // Add object manually
  const addObjectBtn = document.getElementById('add-object-btn');
  if (addObjectBtn) {
    addObjectBtn.addEventListener('click', () => {
      const newObj = {
        id: 'obj_' + Date.now(),
        x: Math.round((calibrateWidth * 100) / 2),
        y: Math.round((calibrateHeight * 100) / 2),
        w: 60,
        h: 60,
        typeGuess: 'furniture',
        label: 'New Object',
        referenceDescription: 'Manually added',
        rotation: 0
      };
      identifiedObjects.push(newObj);
      selectedObjectIndex = identifiedObjects.length - 1;
      if (viewObjects) viewObjects.disabled = false;
      if (viewMode !== 'split-obj') {
        setViewMode('split-obj');
      }
      setTool('select');
      renderObjectLibrary();
      draw2D();
      rebuild3D();
      openObjectEditModal(selectedObjectIndex);
    });
  }


  // Tools
  toolSelect.addEventListener('click', () => setTool('select'));
  toolDraw.addEventListener('click',   () => setTool('draw'));
  toolDelete.addEventListener('click', () => setTool('delete'));
  toolCamera.addEventListener('click', () => setTool('camera'));

  // Custom Shape Banner Buttons
  const doneCustomShapeBtn = document.getElementById('done-custom-shape-btn');
  if (doneCustomShapeBtn) {
    doneCustomShapeBtn.addEventListener('click', () => {
      finishDrawingCustomShape();
    });
  }

  const cancelCustomShapeBtn = document.getElementById('cancel-custom-shape-btn');
  if (cancelCustomShapeBtn) {
    cancelCustomShapeBtn.addEventListener('click', () => {
      activeTool = 'select';
      drawingObjectPoints = [];
      document.getElementById('custom-shape-instructions').style.display = 'none';
      openObjectEditModal(selectedObjectIndex);
      draw2D();
    });
  }

  // Scale
  scaleApplyBtn.addEventListener('click', () => {
    const newW = parseFloat(widthInput.value);
    const newH = parseFloat(heightInput.value);
    if (isNaN(newW) || isNaN(newH) || newW <= 0 || newH <= 0) {
      alert("Please enter valid positive dimensions.");
      return;
    }

    const oldW = calibrateWidth;
    const oldH = calibrateHeight;

    calibrateWidth  = newW;
    calibrateHeight = newH;

    if (oldW > 0 && oldH > 0) {
      const scaleX = newW / oldW;
      const scaleY = newH / oldH;

      // Rescale existing corners
      Object.keys(corners).forEach(id => {
        corners[id].x *= scaleX;
        corners[id].y *= scaleY;
      });

      // Rescale existing objects
      identifiedObjects.forEach(obj => {
        obj.x *= scaleX;
        obj.y *= scaleY;
        if (obj.w !== undefined) obj.w *= scaleX;
        if (obj.h !== undefined) obj.h *= scaleY;
        if (obj.points && obj.points.length > 0) {
          obj.points.forEach(p => {
            p.x *= scaleX;
            p.y *= scaleY;
          });
        }
      });

      // Rescale existing camera positions
      cameraPositions.forEach(cam => {
        cam.x *= scaleX;
        cam.y *= scaleY;
      });
    }

    resetViewOffset();
    draw2D();
    rebuild3D();
  });

  // 3D customization
  wallHeightInput.addEventListener('input',    () => { wallHeight    = parseFloat(wallHeightInput.value);    rebuild3D(); });
  wallThicknessInput.addEventListener('input', () => { wallThickness = parseFloat(wallThicknessInput.value); draw2D(); rebuild3D(); });
  wallColorInput.addEventListener('input',     () => { wallColor     = wallColorInput.value; colorHex.innerText = wallColor; rebuild3D(); });

  // View layout buttons
  viewSplit.addEventListener('click', () => setViewMode('split'));
  view2d.addEventListener('click',    () => setViewMode('2d'));
  view3d.addEventListener('click',    () => setViewMode('3d'));
  if (viewObjects) {
    viewObjects.addEventListener('click', () => setViewMode('split-obj'));
  }
  viewAi.addEventListener('click',    () => setViewMode('ai'));

  // Zoom controls
  if (zoomInBtn) {
    zoomInBtn.addEventListener('click', () => zoomAtCenter(1.2));
  }
  if (zoomOutBtn) {
    zoomOutBtn.addEventListener('click', () => zoomAtCenter(0.8));
  }
  if (zoomFitBtn) {
    zoomFitBtn.addEventListener('click', () => {
      resetViewOffset();
      draw2D();
    });
  }

  // Chat
  chatSendBtn.addEventListener('click', sendAssistantMessage);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendAssistantMessage(); });

  if (chatAttachBtn) {
    chatAttachBtn.addEventListener('click', () => {
      if (chatImageInput) chatImageInput.click();
    });
  }

  if (chatImageInput) {
    chatImageInput.addEventListener('change', e => {
      handleChatImageSelect(e.target.files[0]);
    });
  }

  if (chatRemoveAttachment) {
    chatRemoveAttachment.addEventListener('click', removeChatAttachment);
  }

  // Quick-action chips — pre-fill chat input and trigger send
  document.querySelectorAll('.chat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.prompt;
      if (!prompt) return;
      chatInput.value = prompt;
      // Auto-switch to AI view in CAD mode so render + chat are visible
      if (pipelineMode === 'cad' && viewMode !== 'ai') setViewMode('ai');
      sendAssistantMessage();
    });
  });

  // Import/Export
  exportBtn.addEventListener('click', exportLayout);
  importBtnTrigger.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', importLayout);

  const capture3dCamBtn = document.getElementById('capture-3d-cam-btn');
  if (capture3dCamBtn) {
    capture3dCamBtn.addEventListener('click', () => {
      if (!camera) {
        alert('3D viewer is not initialized.');
        return;
      }
      const centerOffsetX = (calibrateWidth * 100) / 2;
      const centerOffsetZ = (calibrateHeight * 100) / 2;
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const angle = Math.round(Math.atan2(dir.x, -dir.z) * 180 / Math.PI);
      const id = 'cam_' + Date.now();
      const newCam = {
        id,
        x: Math.round(camera.position.x + centerOffsetX),
        y: Math.round(camera.position.z + centerOffsetZ),
        angle: angle,
        label: `3D View Cam ${cameraPositions.length + 1}`,
        is3d: true,
        px: camera.position.x,
        py: camera.position.y,
        pz: camera.position.z,
        dx: dir.x,
        dy: dir.y,
        dz: dir.z,
        fov: camera.fov,
        aspect: camera.aspect
      };
      cameraPositions.push(newCam);
      selectedCamera = id;
      updateCameraList();
      updatePipelineState();
      draw2D();
    });
  }

  // Walk mode
  fpsBtn.addEventListener('click', () => { if (fpsActive) exitWalkMode(); else enterWalkMode(); });

  // Wipe Session
  if (wipeSessionBtn) {
    wipeSessionBtn.addEventListener('click', wipeSession);
    wipeSessionBtn.disabled = true; // enabled once session is initialized
  }

  // Save Session
  if (saveSessionBtn) {
    saveSessionBtn.addEventListener('click', saveActiveSession);
    saveSessionBtn.disabled = true; // enabled once session is initialized
  }

  // Load Session modal triggers
  if (loadSessionBtn) {
    loadSessionBtn.addEventListener('click', () => {
      if (sessionsModal) {
        sessionsModal.style.display = 'flex';
        fetchSavedSessionsList();
      }
    });
  }

  if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
      if (sessionsModal) sessionsModal.style.display = 'none';
    });
  }

  // Continuous wall drawing exit controls (Escape or Right-click)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (activeTool === 'draw' && drawingStartCorner) {
        drawingStartCorner = null;
        draw2D();
      }
    }
  });

  canvas2D.addEventListener('contextmenu', e => {
    if (activeTool === 'draw' && drawingStartCorner) {
      e.preventDefault();
      drawingStartCorner = null;
      draw2D();
    }
  });
}

// ─── App Init ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  bindUIEvents();
  initPreviewTabs();
  init3D();
  setupFPSControls();
  resize2DCanvas();
  rebuild3D();
  updatePipelineState();
  renderObjectLibrary();
  updateCameraList();
  setupAnnotationDrawing();
});
