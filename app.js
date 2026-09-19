const $ = (s) => document.querySelector(s);

const senderView = $("#senderView");
const receiverView = $("#receiverView");
const params = new URLSearchParams(location.search);
const receiverPeerId = params.get("peer");

let peer = null;
let connection = null;
let files = [];
let incomingFiles = [];
let incomingCurrent = null;
let incomingBlobs = [];
let qr = null;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
  return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

function fileIcon(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (["pdf"].includes(ext)) return "PDF";
  if (["doc","docx"].includes(ext)) return "DOC";
  if (["xls","xlsx"].includes(ext)) return "XLS";
  if (["png","jpg","jpeg","webp","gif"].includes(ext)) return "IMG";
  if (["zip","rar","7z"].includes(ext)) return "ZIP";
  return "FILE";
}

function updateFileUI() {
  $("#fileCount").textContent = `${files.length} fichier${files.length > 1 ? "s" : ""}`;
  $("#fileList").innerHTML = files.map((file, i) => `
    <div class="file-row">
      <div class="file-icon">${fileIcon(file.name)}</div>
      <div class="file-info">
        <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
        <div class="file-size">${formatSize(file.size)}</div>
      </div>
      <button class="remove-file" data-index="${i}" title="Supprimer" aria-label="Supprimer ${escapeHtml(file.name)}">×</button>
    </div>`).join("");

  document.querySelectorAll(".remove-file").forEach(btn => {
    btn.addEventListener("click", () => {
      files.splice(Number(btn.dataset.index), 1);
      updateFileUI();
      refreshQR();
    });
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}

function addFiles(newFiles) {
  const incoming = [...newFiles];
  for (const file of incoming) {
    if (!files.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) {
      files.push(file);
    }
  }
  updateFileUI();
  refreshQR();
}

$("#fileInput").addEventListener("change", e => addFiles(e.target.files));

const dropzone = $("#dropzone");
["dragenter","dragover"].forEach(type => dropzone.addEventListener(type, e => {
  e.preventDefault(); dropzone.classList.add("dragover");
}));
["dragleave","drop"].forEach(type => dropzone.addEventListener(type, e => {
  e.preventDefault(); dropzone.classList.remove("dragover");
}));
dropzone.addEventListener("drop", e => addFiles(e.dataTransfer.files));
dropzone.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#fileInput").click(); }
});

function createPeer() {
  peer = new Peer(undefined, {
    debug: 1
  });

  peer.on("open", id => {
    const link = `${location.origin}${location.pathname}?peer=${encodeURIComponent(id)}`;
    generateQR(link);
  });

  peer.on("connection", conn => {
    connection = conn;
    conn.on("open", () => {
      if (!files.length) return;
      $("#transferPanel").classList.remove("hidden");
      $("#transferStatus").textContent = "Mobile connecté";
      $("#progressText").textContent = "Envoi des informations…";
      conn.send({ type: "manifest", files: files.map(f => ({ name: f.name, size: f.size, type: f.type || "application/octet-stream" })) });
    });
    conn.on("data", handleSenderMessage);
    conn.on("close", () => {
      $("#transferStatus").textContent = "Connexion fermée";
    });
    conn.on("error", () => {
      $("#transferStatus").textContent = "Erreur de connexion";
    });
  });

  peer.on("error", err => {
    console.error(err);
    showToast("Impossible d'établir la connexion.");
  });
}

function generateQR(link) {
  $("#qrEmpty").classList.add("hidden");
  $("#qrReady").classList.remove("hidden");
  $("#readyBadge").textContent = "Prêt";
  $("#readyBadge").classList.add("ready");

  qr = new QRious({
    element: $("#qrCanvas"),
    value: link,
    size: 500,
    level: "H"
  });
}

function refreshQR() {
  if (!files.length) {
    $("#qrEmpty").classList.remove("hidden");
    $("#qrReady").classList.add("hidden");
    $("#readyBadge").textContent = "En attente";
    $("#readyBadge").classList.remove("ready");
    $("#transferPanel").classList.add("hidden");
    return;
  }
  if (peer?.id) {
    const link = `${location.origin}${location.pathname}?peer=${encodeURIComponent(peer.id)}`;
    generateQR(link);
  }
  $("#transferPanel").classList.remove("hidden");
}

async function sendFile(fileIndex) {
  const file = files[fileIndex];
  if (!connection || !connection.open) throw new Error("Connexion indisponible");

  const buffer = await file.arrayBuffer();
  const CHUNK_SIZE = 64 * 1024;

  connection.send({
    type: "file-start",
    index: fileIndex,
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    totalChunks: Math.ceil(buffer.byteLength / CHUNK_SIZE)
  });

  for (let offset = 0; offset < buffer.byteLength; offset += CHUNK_SIZE) {
    const chunk = buffer.slice(offset, Math.min(offset + CHUNK_SIZE, buffer.byteLength));
    connection.send({ type: "chunk", index: fileIndex, data: chunk });
    const overall = (fileIndex + Math.min(offset + CHUNK_SIZE, buffer.byteLength) / buffer.byteLength) / files.length * 100;
    setProgress(overall);
    await new Promise(r => setTimeout(r, 0));
  }

  connection.send({ type: "file-end", index: fileIndex });
}

async function sendAllFiles() {
  if (!connection || !connection.open) return;
  try {
    for (let i = 0; i < files.length; i++) {
      await sendFile(i);
    }
    connection.send({ type: "complete" });
    setProgress(100);
    $("#transferStatus").textContent = "Transfert terminé";
    $("#progressText").textContent = "Les fichiers ont été envoyés au mobile.";
  } catch (error) {
    console.error(error);
    $("#transferStatus").textContent = "Erreur";
    $("#progressText").textContent = "Le transfert a été interrompu.";
  }
}

function handleSenderMessage(message) {
  if (message?.type === "ready") {
    $("#transferStatus").textContent = "Transfert en cours";
    sendAllFiles();
  }
  if (message?.type === "received") {
    $("#progressText").textContent = `Fichier ${message.index + 1} reçu sur le mobile.`;
  }
}

function setProgress(percent) {
  const value = Math.max(0, Math.min(100, percent));
  $("#progressBar").style.width = `${value}%`;
  $("#progressPercent").textContent = `${Math.round(value)}%`;
}

$("#copyLink").addEventListener("click", async () => {
  if (!peer?.id) return;
  const link = `${location.origin}${location.pathname}?peer=${encodeURIComponent(peer.id)}`;
  try {
    await navigator.clipboard.writeText(link);
    showToast("Lien copié.");
  } catch {
    showToast("Copie non disponible sur ce navigateur.");
  }
});

function initReceiver() {
  senderView.classList.add("hidden");
  receiverView.classList.remove("hidden");

  peer = new Peer();
  peer.on("open", () => {
    connection = peer.connect(receiverPeerId, { reliable: true });
    connection.on("open", () => {
      $("#receiverConnectionText").textContent = "Appareil trouvé. Préparation des fichiers…";
      connection.send({ type: "ready" });
    });
    connection.on("data", handleReceiverMessage);
    connection.on("error", showReceiverError);
    connection.on("close", () => {
      if (incomingFiles.length === 0) showReceiverError();
    });
  });
  peer.on("error", showReceiverError);
}

function handleReceiverMessage(message) {
  if (message.type === "manifest") {
    incomingFiles = message.files.map(f => ({ ...f, chunks: [], receivedBytes: 0 }));
    $("#receiverCount").textContent = `${incomingFiles.length} fichier${incomingFiles.length > 1 ? "s" : ""}`;
    $("#receiverConnecting").classList.add("hidden");
    $("#receiverFiles").classList.remove("hidden");
    renderReceivedList();
    return;
  }

  if (message.type === "file-start") {
    incomingCurrent = incomingFiles[message.index];
    incomingCurrent.chunks = [];
    incomingCurrent.receivedBytes = 0;
    incomingCurrent.totalChunks = message.totalChunks;
    return;
  }

  if (message.type === "chunk") {
    if (!incomingCurrent) return;
    incomingCurrent.chunks.push(message.data);
    incomingCurrent.receivedBytes += message.data.byteLength || message.data.length || 0;
    updateIncomingProgress();
    return;
  }

  if (message.type === "file-end") {
    const file = incomingFiles[message.index];
    file.blob = new Blob(file.chunks, { type: file.type || "application/octet-stream" });
    file.url = URL.createObjectURL(file.blob);
    file.chunks = [];
    renderReceivedList();
    connection.send({ type: "received", index: message.index });
    incomingCurrent = null;
    return;
  }

  if (message.type === "complete") {
    renderReceivedList();
  }
}

function updateIncomingProgress() {
  const total = incomingFiles.reduce((sum, f) => sum + f.size, 0);
  const received = incomingFiles.reduce((sum, f) => sum + (f.receivedBytes || 0), 0);
  const pct = total ? Math.round(received / total * 100) : 0;
  $("#receiverTitle").textContent = pct >= 100 ? "Fichiers prêts" : `Réception… ${pct}%`;
}

function renderReceivedList() {
  $("#receivedList").innerHTML = incomingFiles.map((file, i) => `
    <div class="received-row">
      <div class="file-icon">${fileIcon(file.name)}</div>
      <div class="received-info">
        <div class="received-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
        <div class="received-size">${formatSize(file.size)}</div>
      </div>
      ${file.url ? `<a class="btn secondary download-one" href="${file.url}" download="${escapeHtml(file.name)}">Télécharger</a>` : `<span class="file-size">Réception…</span>`}
    </div>`).join("");
}

$("#downloadAll").addEventListener("click", () => {
  incomingFiles.filter(f => f.url).forEach((file, i) => {
    setTimeout(() => {
      const a = document.createElement("a");
      a.href = file.url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 250);
  });
});

function showReceiverError() {
  $("#receiverConnecting").classList.add("hidden");
  $("#receiverFiles").classList.add("hidden");
  $("#receiverError").classList.remove("hidden");
}

if (receiverPeerId) {
  initReceiver();
} else {
  createPeer();
}
