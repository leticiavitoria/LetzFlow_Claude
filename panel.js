// ============================================
// LETZFLOW SENDER - PANEL v2.1.0
// Uso pessoal - sem licenciamento
// TABS: Video / Imagem com estado independente
// ============================================

let activeTab = "video";
let autoDownload = true, backgroundMode = true, currentTabId = null;

// v2.0.1 FIX: Set de URLs ja baixadas - previne download duplicado do mesmo arquivo
const _downloadedVideoUrls = new Set();

const tabState = {
    video: { prompts: [], isRunning: false, timerInterval: null, countdownEndTime: null, statePollingTimer: null, detectedMedia: {}, resolution: "720", folder: "LetzVideos", outputCount: 1 },
    image: { prompts: [], isRunning: false, timerInterval: null, countdownEndTime: null, statePollingTimer: null, detectedMedia: {}, resolution: "1024", folder: "LetzImagens", outputCount: 1 }
};

const tabIds = {
    video: {
        promptsInput: "videoPromptsInput", settingsCard: "videoSettingsCard", inputSection: "videoInputSection",
        promptListCard: "videoPromptListCard", promptItems: "videoPromptItems", promptCount: "videoPromptCount",
        progressContainer: "videoProgressContainer", progressFill: "videoProgressFill", progressText: "videoProgressText",
        timer: "videoTimer", processBtn: "videoProcessBtn", startBtn: "videoStartBtn", stopBtn: "videoStopBtn",
        emergencyStopBtn: "videoEmergencyStopBtn", cancelAllBtn: "videoCancelAllBtn", resendBtn: "videoResendBtn",
        copyFailedBtn: "videoCopyFailedBtn", formatInfo: "videoFormatInfo", statusCard: "videoStatusCard",
        statSent: "videosSent", statGenerated: "videosGenerated", statFailed: "videosFailed", statDownloaded: "videosDownloaded",
        resolution: "videoResolution", resNotice: "videoResNotice", folder: "videoFolder", outputCount: "videoOutputCount",
        FolderReminder: "videoFolderReminder"
    },
    image: {
        promptsInput: "imagePromptsInput", settingsCard: "imageSettingsCard", inputSection: "imageInputSection",
        promptListCard: "imagePromptListCard", promptItems: "imagePromptItems", promptCount: "imagePromptCount",
        progressContainer: "imageProgressContainer", progressFill: "imageProgressFill", progressText: "imageProgressText",
        timer: "imageTimer", processBtn: "imageProcessBtn", startBtn: "imageStartBtn", stopBtn: "imageStopBtn",
        emergencyStopBtn: "imageEmergencyStopBtn", cancelAllBtn: "imageCancelAllBtn", resendBtn: "imageResendBtn",
        copyFailedBtn: "imageCopyFailedBtn", formatInfo: "imageFormatInfo", statusCard: "imageStatusCard",
        statSent: "imagesSent", statGenerated: "imagesGenerated", statFailed: "imagesFailed", statDownloaded: "imagesDownloaded",
        resolution: "imageResolution", folder: "imageFolder", outputCount: "imageOutputCount",
        FolderReminder: "imageFolderReminder"
    }
};

function el(tab, key) { return document.getElementById(tabIds[tab][key]); }
function getFolder(tab) { return tabState[tab].folder || (tab === "video" ? "LetzVideos" : "LetzImagens"); }

// v2.1.0: Atualizar log persistente quando media e detectada/baixada
function updateLog(promptNumber, mediaType, mediaStatus) {
    try {
        chrome.runtime.sendMessage({
            action: "UPDATE_PROMPT_LOG",
            promptNumber, mediaType, mediaStatus
        });
    } catch (e) {}
}

function buildLocalFilename(tab, prompt, resolution) {
    const folder = getFolder(tab);
    const num = prompt.number || 0;
    const ext = tab === "image" ? "png" : "mp4";
    let slug = (prompt.text || "").substring(0, 50)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/\s+/g, "_").trim();
    if (!slug) slug = "prompt";
    return folder + "/PROMPT_" + String(num).padStart(3, "0") + "_" + resolution + "_" + slug + "." + ext;
}

// ============================================
// INIT
// ============================================
async function init() {
    try {
        setupMessageListener();
        initApp();
    } catch (e) {
        console.error("[Panel] Init error:", e);
        document.body.innerHTML = '<div style="padding:20px;color:#fff;background:#111;font-family:sans-serif;">' +
            '<h3 style="color:#FF571C;">LetzFlow Sender v2.1.0</h3>' +
            '<p style="color:#888;">Erro ao inicializar. Recarregue a pagina.</p>' +
            '<p style="color:#666;font-size:12px;">' + (e.message || 'Erro desconhecido') + '</p></div>';
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
} else {
    init();
}

// ============================================
// TAB SWITCHING
// ============================================
function switchTab(tabName) {
    activeTab = tabName;
    document.getElementById("tabBtnVideo").classList.toggle("active", tabName === "video");
    document.getElementById("tabBtnImage").classList.toggle("active", tabName === "image");
    document.getElementById("tabContentVideo").classList.toggle("active", tabName === "video");
    document.getElementById("tabContentImage").classList.toggle("active", tabName === "image");
    // Intervalo entre lotes: 180s pra video, 90s pra imagem
    document.getElementById("batchInterval").value = tabName === "video" ? 180 : 90;
    updateBlockedOverlay();
}

function updateBlockedOverlay() {
    const imageBlocked = document.getElementById("imageBlockedOverlay");
    const videoBlocked = document.getElementById("videoBlockedOverlay");
    if (imageBlocked) imageBlocked.classList.toggle("hidden", !tabState.video.isRunning);
    if (videoBlocked) videoBlocked.classList.toggle("hidden", !tabState.image.isRunning);
}

// ============================================
// MESSAGE LISTENER
// ============================================
function setupMessageListener() {
    window.addEventListener("message", (e) => {
        const { type, data } = e.data || {};
        if (!type) return;
        switch (type) {
            case "VIDEO_DETECTED": handleVideoDetected(data); break;
            case "DETECTED_VIDEOS_LIST": tabState.video.detectedMedia = data; processDetectedMedia("video"); break;
            case "IMAGE_DETECTED": handleImageDetected(data); break;
            case "DETECTED_IMAGES_LIST": tabState.image.detectedMedia = data; processDetectedMedia("image"); break;
            case "UPSCALE_STARTED": handleUpscaleStarted(data); break;
            case "UPSCALE_FAILED": handleUpscaleFailed(data); break;
            case "IMAGE_GENERATION_STARTED": handleImageGenerationStarted(data); break;
            case "IMAGE_UPSCALE_STARTED": handleImageUpscaleStarted(data); break;
            case "IMAGE_UPSCALE_FAILED": handleImageUpscaleFailed(data); break;
            case "PROMPT_STARTING": handlePromptStarting(data); break;
            case "PROMPT_RESULT": handlePromptResult(data); break;
            case "BATCH_PAUSE": handleBatchPause(data); break;
            case "QUEUE_COMPLETE": handleQueueComplete(); break;
            case "QUEUE_ERROR": handleQueueError(data); break;
            case "DOWNLOAD_INTERCEPTED": handleDownloadIntercepted(data); break;
        }
    });
}

// ============================================
// HELPERS - FIND TAB
// ============================================
function findTabForPrompt(number) {
    for (const tab of ["video", "image"]) {
        if (tabState[tab].isRunning && tabState[tab].prompts.some(p => p.number === number)) return tab;
    }
    for (const tab of ["video", "image"]) {
        if (tabState[tab].prompts.some(p => p.number === number)) return tab;
    }
    return null;
}

function getRunningTab() {
    if (tabState.video.isRunning) return "video";
    if (tabState.image.isRunning) return "image";
    return null;
}

// ============================================
// PROMPT HANDLERS
// ============================================
function handlePromptStarting(prompt) {
    const tab = findTabForPrompt(prompt.number);
    if (!tab) return;
    const idx = tabState[tab].prompts.findIndex(p => p.number === prompt.number);
    if (idx !== -1) {
        tabState[tab].prompts[idx].status = "sending";
        displayPrompts(tab);
        const label = tab === "image" ? "Gerando imagem" : "Enviando";
        updateStatus("running", label + " PROMPT " + prompt.number + "...");
    }
}

function handlePromptResult(data) {
    const tab = findTabForPrompt(data.number);
    if (!tab) return;
    const st = tabState[tab];
    const idx = st.prompts.findIndex(p => p.number === data.number);
    if (idx !== -1) {
        st.prompts[idx].status = data.result.success ? "sent" : "error";
        if (!data.result.success) st.prompts[idx].errorReason = data.result.error;
        displayPrompts(tab);
        updateStatsDisplay(tab);
        const done = st.prompts.filter(p => p.status === "sent" || p.status === "error").length;
        updateProgress(Math.round((done / st.prompts.length) * 100), "Enviado " + done + "/" + st.prompts.length, tab);
    }
}

function handleBatchPause(data) {
    const tab = getRunningTab();
    if (!tab) return;
    stopAllTimers(tab);
    updateStatus("warning", "Aguardando proximo lote...");
    tabState[tab].countdownEndTime = Date.now() + data.interval;
    showCountdownTimer(tab);
}

function handleQueueError(data) {
    const tab = getRunningTab() || activeTab;
    tabState[tab].isRunning = false;
    stopStatePolling(tab);
    updateBlockedOverlay();
    updateStatus("error", data?.message || "Erro na fila");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "startBtn").classList.remove("hidden");
    el(tab, "startBtn").textContent = "Continuar";
    el(tab, "startBtn").onclick = () => continueSending(tab);
    el(tab, "cancelAllBtn").classList.remove("hidden");
}


// ============================================
// TIMERS
// ============================================
function stopAllTimers(tab) {
    const st = tabState[tab];
    if (st.timerInterval) { clearTimeout(st.timerInterval); st.timerInterval = null; }
    st.countdownEndTime = null;
}

function showCountdownTimer(tab) {
    const st = tabState[tab];
    // Limpar APENAS o timer interval, sem resetar o countdownEndTime
    if (st.timerInterval) { clearTimeout(st.timerInterval); st.timerInterval = null; }
    const timer = el(tab, "timer");
    timer.classList.remove("hidden");
    if (!st.countdownEndTime) st.countdownEndTime = Date.now() + 90000;

    function update() {
        if (!st.isRunning || !st.countdownEndTime) { timer.classList.add("hidden"); return; }
        const remaining = Math.max(0, Math.ceil((st.countdownEndTime - Date.now()) / 1000));
        if (remaining <= 0) { timer.classList.add("hidden"); st.countdownEndTime = null; return; }
        timer.textContent = String(Math.floor(remaining / 60)).padStart(2, "0") + ":" + String(remaining % 60).padStart(2, "0");
        st.timerInterval = setTimeout(update, 1000);
    }
    update();
}

// ============================================
// QUEUE COMPLETE - SIMPLIFICADO (sem duas fases)
// ============================================
async function handleQueueComplete() {
    const tab = getRunningTab() || activeTab;
    const st = tabState[tab];
    st.isRunning = false;
    const sentCount = st.prompts.filter(p => p.status === "sent").length;

    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "cancelAllBtn").classList.remove("hidden");

    // v2.0.1: Timer dinamico baseado no numero de prompts
    // Cada video leva ~3-5min para gerar, mas geram em paralelo (batches de ~8-10)
    // Minimo 120s, maximo 600s, ~8s por prompt
    const baseWait = tab === "video" ? Math.max(120, Math.min(600, sentCount * 8)) : 60;
    const mediaLabel = tab === "video" ? "dos videos" : "das imagens";
    updateStatus("success", "Envio concluido! " + sentCount + "/" + st.prompts.length + " enviados");

    await showWaitingCounter(baseWait, "Aguardando geracao " + mediaLabel + "...", tab);

    // v2.0.1 FIX: Bonus rounds - continuar polling ate capturar todos os videos
    // 20 rounds × 30s = 10 min extras (break automatico quando todos sao capturados)
    if (tab === "video") {
        for (let round = 1; round <= 20; round++) {
            const pending = st.prompts.filter(p => p.status === "sent" && p.mediaStatus === "pending" && !p._downloading).length;
            if (pending === 0) break;
            console.log("[Panel] Bonus round", round, "/20 - faltam", pending, "videos");
            await showWaitingCounter(30, "Aguardando " + pending + " videos restantes (tentativa " + round + "/20)...", tab);
        }
        // Restaurar zoom (1 zoom out)
        window.parent.postMessage({ type: "SET_PAGE_ZOOM", data: { zoom: 1.0 } }, "*");
    }

    // Se aba de imagem, voltar para modo de video
    if (tab === "image") {
        window.parent.postMessage({ type: "SWITCH_TO_VIDEO_MODE" }, "*");
    }

    finishSending(tab);
}

// ============================================
// MEDIA DETECTION
// ============================================
function handleVideoDetected(data) {
    const st = tabState.video;
    if (st.prompts.length === 0) return;

    let idx = -1;
    const match = data.prompt.match(/PROMPT\s*(\d+)/i);
    if (match) {
        const promptNum = parseInt(match[1]);
        idx = st.prompts.findIndex(p => p.number === promptNum);
    }

    // Fallback: primeiro prompt "sent" que ainda nao tem midia
    if (idx === -1) {
        idx = st.prompts.findIndex(p => p.status === "sent" &&
            p.mediaStatus === "pending" && !p._downloading);
    }

    if (idx === -1) {
        console.log("[Panel] handleVideoDetected - nenhum prompt encontrado para:", data.prompt);
        return;
    }
    const p = st.prompts[idx];

    // v2.0.1: Guard completo - so processar se status eh "pending" (nunca foi processado)
    if (p.mediaStatus !== "pending" || p._downloading) {
        console.log("[Panel] handleVideoDetected SKIP prompt", p.number, "status:", p.mediaStatus, "_downloading:", p._downloading);
        return;
    }

    console.log("[Panel] handleVideoDetected OK prompt", p.number, "autoDownload:", autoDownload);
    p.mediaStatus = "generated";
    p.mediaUrl = data.url;
    p.mediaUrls = data.urls || { default: data.url };
    displayPrompts("video");
    updateStatsDisplay("video");
    updateLog(p.number, "video", "generated");
    if (autoDownload) downloadMedia("video", idx);
}

function handleImageDetected(data) {
    const st = tabState.image;
    if (st.prompts.length === 0) return;

    let idx = -1;
    const match = data.prompt.match(/PROMPT\s*(\d+)/i);
    if (match) {
        const promptNum = parseInt(match[1]);
        idx = st.prompts.findIndex(p => p.number === promptNum);
    }

    if (idx === -1) {
        idx = st.prompts.findIndex(p => p.status === "sent" &&
            p.mediaStatus === "pending" && !p._downloading);
    }

    if (idx === -1) return;
    const p = st.prompts[idx];

    // v2.0.1: Guard completo
    if (p.mediaStatus !== "pending" || p._downloading) return;

    p.mediaUrl = data.url;
    p.mediaUrls = data.urls || { default: data.url };
    p.mediaStatus = "generated";
    displayPrompts("image");
    updateStatsDisplay("image");
    updateLog(p.number, "image", "generated");
    if (autoDownload) downloadMedia("image", idx);
}

// v2.0.1 FIX: Processa URLs de video vindas DIRETO do background.js
// Casa cada URL com o prompt correto pelo texto do card no DOM
function processInterceptedVideos(urls, matchedVideos) {
    const st = tabState.video;
    if (st.prompts.length === 0) return;
    let newCount = 0;

    // matchedVideos vem do DOM scan com { url, promptNum }
    // promptNum = numero do prompt extraido do texto "PROMPT N:" no card do Flow
    const items = (matchedVideos && matchedVideos.length > 0)
        ? matchedVideos
        : urls.map(u => ({ url: u, promptNum: null }));

    for (const item of items) {
        const url = item.url || item;
        if (_downloadedVideoUrls.has(url)) continue;
        if (st.prompts.some(p => p.mediaUrl === url)) continue;

        let idx = -1;

        // Matching direto: promptNum do DOM → prompt.number
        if (item.promptNum !== null && item.promptNum !== undefined) {
            const found = st.prompts.findIndex(p =>
                p.number === item.promptNum &&
                p.status === "sent" && p.mediaStatus === "pending" && !p._downloading);
            if (found !== -1) {
                idx = found;
                console.log("[Panel] PROMPT NUM MATCH:", item.promptNum, "-> prompt", st.prompts[idx].number);
            }
        }

        // Fallback: proximo prompt pendente (sequencial)
        if (idx === -1) {
            idx = st.prompts.findIndex(p => p.status === "sent" &&
                p.mediaStatus === "pending" && !p._downloading);
            if (idx !== -1) {
                console.log("[Panel] SEQUENTIAL FALLBACK -> prompt", st.prompts[idx].number);
            }
        }
        if (idx === -1) break;

        const p = st.prompts[idx];
        p.mediaStatus = "generated";
        p.mediaUrl = url;
        p.mediaUrls = { default: url, "720": url };
        newCount++;
        console.log("[Panel] processInterceptedVideos - prompt", p.number, "url:", url.substring(0, 80));
        updateLog(p.number, "video", "generated");
        if (autoDownload) downloadMedia("video", idx);
    }
    if (newCount > 0) {
        displayPrompts("video");
        updateStatsDisplay("video");
    }
}

function processDetectedMedia(tab) {
    const st = tabState[tab];
    if (st.prompts.length === 0) return;
    const toDownload = [];
    const alreadyQueued = new Set();
    const seenUrls = new Set(); // v2.0.1 FIX: dedup por URL real dentro deste batch
    Object.entries(st.detectedMedia).forEach(([key, info]) => {
        if (info.duplicate) return;
        // v2.0.1 FIX: a chave (key) pode ser "vdet_1" etc, NAO e URL.
        // A URL real esta em info.urls.default
        const realUrl = info.urls?.default || info.url;
        if (!realUrl || !realUrl.startsWith("http")) return; // ignorar chaves invalidas

        // Dedup: so processar cada URL real uma vez
        if (seenUrls.has(realUrl) || _downloadedVideoUrls.has(realUrl)) return;
        seenUrls.add(realUrl);

        // Tentar match por prompt number
        let idx = -1;
        const match = (info.prompt || "").match(/PROMPT\s*(\d+)/i);
        if (match) {
            idx = st.prompts.findIndex(p => p.number === parseInt(match[1]));
        }
        // Fallback: proximo prompt pendente
        if (idx === -1) {
            idx = st.prompts.findIndex(p => p.status === "sent" &&
                p.mediaStatus === "pending" && !p._downloading);
        }

        if (idx !== -1 && !alreadyQueued.has(idx) &&
            st.prompts[idx].mediaStatus === "pending" && !st.prompts[idx]._downloading) {
            console.log("[Panel] processDetectedMedia - novo:", tab, "prompt", st.prompts[idx].number, "url:", realUrl.substring(0, 80));
            st.prompts[idx].mediaStatus = "generated";
            st.prompts[idx].mediaUrl = realUrl;
            st.prompts[idx].mediaUrls = info.urls || { default: realUrl };
            toDownload.push(idx);
            alreadyQueued.add(idx);
        }
    });
    if (toDownload.length > 0) {
        console.log("[Panel] processDetectedMedia - total novas midias:", toDownload.length);
    }
    displayPrompts(tab);
    updateStatsDisplay(tab);
    if (autoDownload) {
        for (const idx of toDownload) downloadMedia(tab, idx);
    }
}

// ============================================
// UPSCALE HANDLERS
// ============================================
function handleUpscaleStarted(data) {
    const idx = tabState.video.prompts.findIndex(p => p.number === data.promptNumber);
    if (idx !== -1) {
        // v2.2.1: Marcar como "upscaling" (nao "downloaded") - download real vem depois
        tabState.video.prompts[idx].mediaStatus = "upscaling";
        displayPrompts("video");
        updateStatsDisplay("video");
    }
}

function handleUpscaleFailed(data) {
    const idx = tabState.video.prompts.findIndex(p => p.number === data.promptNumber);
    if (idx !== -1) {
        const p = tabState.video.prompts[idx];
        // v2.0.1: Fallback para 720p direto - limpar flags e re-download
        p.mediaStatus = "generated";
        p._downloading = false;
        const origRes = tabState.video.resolution;
        tabState.video.resolution = "720";
        downloadMedia("video", idx);
        tabState.video.resolution = origRes;
    }
}

function handleImageGenerationStarted(data) {
    const idx = tabState.image.prompts.findIndex(p => p.number === data.promptNumber);
    if (idx !== -1) {
        tabState.image.prompts[idx].mediaStatus = "generating";
        displayPrompts("image");
        updateStatsDisplay("image");
    }
}

function handleImageUpscaleStarted(data) {
    const idx = tabState.image.prompts.findIndex(p => p.number === data.promptNumber);
    if (idx !== -1) {
        // v2.2.1: Marcar como "upscaling" (nao "downloaded")
        tabState.image.prompts[idx].mediaStatus = "upscaling";
        displayPrompts("image");
        updateStatsDisplay("image");
    }
}

function handleImageUpscaleFailed(data) {
    const idx = tabState.image.prompts.findIndex(p => p.number === data.promptNumber);
    if (idx !== -1) {
        const p = tabState.image.prompts[idx];
        // v2.0.1: Fallback para 1K direto
        p.mediaStatus = "generated";
        p._downloading = false;
        const origRes = tabState.image.resolution;
        tabState.image.resolution = "1024";
        downloadMedia("image", idx);
        tabState.image.resolution = origRes;
    }
}

// ============================================
// DOWNLOAD INTERCEPTED
// ============================================
function handleDownloadIntercepted(data) {
    const tab = data.type === "image" ? "image" : "video";
    const st = tabState[tab];
    const idx = st.prompts.findIndex(p => p.number === data.promptNumber);
    if (idx === -1) return;
    // v2.0.1: So atualizar se ainda nao esta downloaded
    if (st.prompts[idx].mediaStatus === "downloaded") return;
    st.prompts[idx].mediaStatus = "downloaded";
    st.prompts[idx]._downloading = false;
    displayPrompts(tab);
    updateStatsDisplay(tab);
    updateLog(data.promptNumber, tab, "downloaded");
}

// ============================================
// DOWNLOAD MEDIA (unified for video/image)
// ============================================
async function downloadMedia(tab, idx) {
    const st = tabState[tab];
    const p = st.prompts[idx];
    // v2.0.1: Guard completo - nao baixar se ja baixado, em upscaling, ou em download
    if (!p.mediaUrl || p.mediaStatus === "downloaded" || p.mediaStatus === "upscaling" || p._downloading) {
        console.log("[Panel] downloadMedia SKIP prompt", p.number, "status:", p.mediaStatus, "_downloading:", p._downloading, "url:", !!p.mediaUrl);
        return;
    }
    // v2.0.1 FIX: Dedup por URL - se esse arquivo ja foi baixado para outro prompt, pular
    if (_downloadedVideoUrls.has(p.mediaUrl)) {
        console.log("[Panel] downloadMedia SKIP DUPLICATE URL prompt", p.number, "url:", p.mediaUrl.substring(0, 80));
        return;
    }
    console.log("[Panel] downloadMedia INICIANDO prompt", p.number, "tab:", tab, "resolution:", st.resolution, "url:", p.mediaUrl.substring(0, 80));
    p._downloading = true;
    // Registrar URL so apos download confirmado (nao antes)

    const resolution = st.resolution;

    if (tab === "video") {
        // Video 1080p: upscale via Flow UI
        if (resolution === "1080") {
            try {
                p.mediaStatus = "upscaling";
                displayPrompts(tab);
                try {
                    await chrome.runtime.sendMessage({
                        action: "REGISTER_UPSCALE_DOWNLOAD",
                        promptNumber: p.number, promptText: p.text,
                        folder: getFolder(tab),
                        resolution: "1080p", downloadType: "video"
                    });
                } catch (e) {}
                window.parent.postMessage({
                    type: "UPSCALE_AND_DOWNLOAD",
                    data: { videoUrl: p.mediaUrl, promptNumber: p.number, resolution: "1080" }
                }, "*");
                setTimeout(() => {
                    if (p.mediaStatus === "upscaling") {
                        // Timeout: reverter para "generated" para permitir retry
                        console.log("[Panel] Upscale timeout prompt", p.number, "- revertendo para generated");
                        p.mediaStatus = "generated";
                        p._downloading = false;
                        displayPrompts(tab);
                        updateStatsDisplay(tab);
                    }
                }, 120000);
                return;
            } catch (e) {}
        }

        // Video 720p: download direto com URL do webRequest
        let downloadUrl = p.mediaUrl;
        try {
            const r = await chrome.runtime.sendMessage({
                action: "DOWNLOAD_VIDEO",
                url: downloadUrl,
                filename: buildLocalFilename(tab, p, "720p")
            });
            if (r.success) {
                p.mediaStatus = "downloaded";
                p._downloading = false;
                _downloadedVideoUrls.add(p.mediaUrl);
                displayPrompts(tab);
                updateStatsDisplay(tab);
                updateLog(p.number, tab, "downloaded");
            } else {
                console.log("[Panel] DOWNLOAD_VIDEO falhou prompt", p.number, "erro:", r.error);
                p._downloading = false;
                displayPrompts(tab);
                updateStatsDisplay(tab);
            }
        } catch (e) {
            console.log("[Panel] DOWNLOAD_VIDEO exception prompt", p.number, e.message);
            p._downloading = false;
        }

    } else {
        // Image 2K: upscale via Flow UI
        if (resolution !== "1024") {
            try {
                p.mediaStatus = "upscaling";
                displayPrompts(tab);
                try {
                    await chrome.runtime.sendMessage({
                        action: "REGISTER_UPSCALE_DOWNLOAD",
                        promptNumber: p.number, promptText: p.text,
                        folder: getFolder(tab),
                        resolution: "2K", downloadType: "image"
                    });
                } catch (e) {}
                window.parent.postMessage({
                    type: "UPSCALE_AND_DOWNLOAD_IMAGE",
                    data: { imageUrl: p.mediaUrl, promptNumber: p.number, resolution: resolution }
                }, "*");
                setTimeout(() => {
                    if (p.mediaStatus === "upscaling") {
                        // Timeout: reverter para "generated" para permitir retry
                        console.log("[Panel] Image upscale timeout prompt", p.number, "- revertendo para generated");
                        p.mediaStatus = "generated";
                        p._downloading = false;
                        displayPrompts(tab);
                        updateStatsDisplay(tab);
                    }
                }, 120000); // 120s para imagem tambem (era 60s)
                return;
            } catch (e) {}
        }

        // Image 1K: direct download
        try {
            const r = await chrome.runtime.sendMessage({
                action: "DOWNLOAD_IMAGE",
                url: p.mediaUrl,
                filename: buildLocalFilename(tab, p, "1K")
            });
            if (r.success) {
                p.mediaStatus = "downloaded";
                p._downloading = false;
                _downloadedVideoUrls.add(p.mediaUrl);
                displayPrompts(tab);
                updateStatsDisplay(tab);
                updateLog(p.number, tab, "downloaded");
            } else {
                console.log("[Panel] DOWNLOAD_IMAGE falhou prompt", p.number, "erro:", r.error);
                p._downloading = false;
                displayPrompts(tab);
                updateStatsDisplay(tab);
            }
        } catch (e) {
            console.log("[Panel] DOWNLOAD_IMAGE exception prompt", p.number, e.message);
            p._downloading = false;
        }
    }
}


// ============================================
// APP INIT
// ============================================
async function initApp() {
    const tabInfo = await chrome.runtime.sendMessage({ action: "GET_ACTIVE_TAB" });
    currentTabId = tabInfo.tabId;

    if (!tabInfo.url || (!tabInfo.url.includes("labs.google/flow") && !tabInfo.url.includes("labs.google/fx"))) {
        updateStatus("error", "Abra o Veo 3 Flow primeiro!");
        el("video", "processBtn").disabled = true;
        el("image", "processBtn").disabled = true;
        return;
    }

    updateStatus("success", "Veo 3 Flow detectado!");
    window.parent.postMessage({ type: "START_VIDEO_DETECTION" }, "*");

    chrome.runtime.sendMessage({ action: "GET_SETTINGS" }, (s) => {
        if (s) {
            document.getElementById("batchSize").value = s.batchSize;
            document.getElementById("batchInterval").value = activeTab === "video" ? 180 : 90;
            document.getElementById("promptDelay").value = s.promptDelay;
            document.getElementById("autoDownload").checked = s.autoDownload;
            document.getElementById("backgroundMode").checked = s.backgroundMode !== false;
            el("video", "folder").value = s.videoFolder || "LetzVideos";
            el("image", "folder").value = s.imageFolder || "LetzImagens";
            autoDownload = s.autoDownload;
            backgroundMode = s.backgroundMode !== false;
            tabState.video.folder = s.videoFolder || "LetzVideos";
            tabState.image.folder = s.imageFolder || "LetzImagens";
        }
    });

    // Tab buttons
    document.getElementById("tabBtnVideo").addEventListener("click", () => switchTab("video"));
    document.getElementById("tabBtnImage").addEventListener("click", () => switchTab("image"));

    // Per-tab event listeners
    for (const tab of ["video", "image"]) {
        el(tab, "processBtn").addEventListener("click", () => processPrompts(tab));
        el(tab, "startBtn").addEventListener("click", () => startSending(tab));
        el(tab, "stopBtn").addEventListener("click", () => stopSending(tab));
        el(tab, "emergencyStopBtn").addEventListener("click", () => emergencyStop(tab));
        el(tab, "cancelAllBtn").addEventListener("click", () => cancelAll(tab));
        el(tab, "resendBtn").addEventListener("click", () => resendFailed(tab));
        el(tab, "copyFailedBtn").addEventListener("click", () => copyFailedNumbers(tab));
        el(tab, "folder").addEventListener("change", (e) => {
            tabState[tab].folder = e.target.value.trim() || (tab === "video" ? "LetzVideos" : "LetzImagens");
            saveSettings();
        });
    }

    // Shared listeners
    document.getElementById("autoDownload").addEventListener("change", (e) => {
        autoDownload = e.target.checked;
        saveSettings();
    });
    document.getElementById("backgroundMode").addEventListener("change", (e) => {
        backgroundMode = e.target.checked;
        saveSettings();
    });
    ["batchSize", "batchInterval", "promptDelay"].forEach(id => {
        document.getElementById(id).addEventListener("change", saveSettings);
    });
    await recoverBackgroundState();
}

function toggleVideoResNotice() {
    const notice = document.getElementById("videoResNotice");
    if (!notice) return;
    notice.classList.toggle("hidden", tabState.video.resolution !== "1080");
}

// ============================================
// STATE RECOVERY
// ============================================
async function recoverBackgroundState() {
    try {
        const state = await chrome.runtime.sendMessage({ action: "GET_FULL_STATE" });
        if (!state) return;

        const tab = state.mediaType || "video";

        if (state.isProcessing || state.isPaused) {
            const allPrompts = [...(state.processedPrompts || []), ...(state.promptQueue || [])];
            if (allPrompts.length > 0) {
                tabState[tab].prompts = allPrompts.map(p => ({
                    number: p.number, elements: p.elements || [], text: p.text,
                    status: p.status || "waiting",
                    mediaStatus: p.mediaStatus || p.videoStatus || "pending",
                    mediaUrl: p.mediaUrl || p.videoUrl || null,
                    errorReason: p.errorReason || null
                })).sort((a, b) => a.number - b.number);

                switchTab(tab);
                el(tab, "inputSection").classList.add("hidden");
                el(tab, "settingsCard").classList.add("hidden");
                el(tab, "formatInfo").classList.add("hidden");
                el(tab, "promptListCard").classList.remove("hidden");
                el(tab, "processBtn").classList.add("hidden");
                el(tab, "progressContainer").classList.remove("hidden");
                el(tab, "statusCard").classList.remove("hidden");
                document.getElementById("sharedSettingsCard").classList.add("hidden");

                displayPrompts(tab);
                updateStatsDisplay(tab);

                const done = tabState[tab].prompts.filter(p => p.status === "sent" || p.status === "error").length;
                updateProgress(Math.round((done / tabState[tab].prompts.length) * 100), "Enviado " + done + "/" + tabState[tab].prompts.length, tab);

                if (state.isProcessing) {
                    tabState[tab].isRunning = true;
                    updateBlockedOverlay();
                    el(tab, "startBtn").classList.add("hidden");
                    el(tab, "stopBtn").classList.remove("hidden");
                    el(tab, "emergencyStopBtn").classList.remove("hidden");
                    el(tab, "cancelAllBtn").classList.remove("hidden");
                    updateStatus("running", "Enviando em segundo plano... (" + done + "/" + tabState[tab].prompts.length + ")");
                    startStatePolling(tab);
                } else if (state.isPaused) {
                    el(tab, "startBtn").classList.remove("hidden");
                    el(tab, "startBtn").textContent = "Continuar";
                    el(tab, "startBtn").onclick = () => continueSending(tab);
                    el(tab, "stopBtn").classList.add("hidden");
                    el(tab, "emergencyStopBtn").classList.add("hidden");
                    el(tab, "cancelAllBtn").classList.remove("hidden");
                    updateStatus("warning", "Pausado - " + (state.promptQueue?.length || 0) + " restantes");
                }
            }
        } else if (state.processedPrompts?.length > 0 && state.promptQueue?.length === 0) {
            tabState[tab].prompts = state.processedPrompts.map(p => ({
                number: p.number, elements: p.elements || [], text: p.text,
                status: p.status || "sent",
                mediaStatus: p.mediaStatus || p.videoStatus || "pending",
                mediaUrl: p.mediaUrl || p.videoUrl || null,
                errorReason: p.errorReason || null
            })).sort((a, b) => a.number - b.number);

            switchTab(tab);
            el(tab, "inputSection").classList.add("hidden");
            el(tab, "settingsCard").classList.add("hidden");
            el(tab, "formatInfo").classList.add("hidden");
            el(tab, "promptListCard").classList.remove("hidden");
            el(tab, "processBtn").classList.add("hidden");
            el(tab, "progressContainer").classList.remove("hidden");
            el(tab, "statusCard").classList.remove("hidden");
            displayPrompts(tab);
            updateStatsDisplay(tab);
            finishSending(tab);
        }
    } catch (e) {
        console.error("[Panel] Error recovering state:", e);
    }
}

// ============================================
// STATE POLLING
// ============================================
function startStatePolling(tab) {
    stopStatePolling(tab);
    const st = tabState[tab];
    st.statePollingTimer = setInterval(async () => {
        try {
            const state = await chrome.runtime.sendMessage({ action: "GET_FULL_STATE" });
            if (!state) return;

            if (state.processedPrompts) {
                for (const pp of state.processedPrompts) {
                    const idx = st.prompts.findIndex(p => p.number === pp.number);
                    if (idx !== -1 && st.prompts[idx].status === "waiting") {
                        st.prompts[idx].status = pp.status;
                        if (pp.error) st.prompts[idx].errorReason = pp.error;
                        displayPrompts(tab);
                        updateStatsDisplay(tab);
                    }
                }
            }

            const done = st.prompts.filter(p => p.status === "sent" || p.status === "error").length;
            updateProgress(Math.round((done / st.prompts.length) * 100), "Enviado " + done + "/" + st.prompts.length, tab);

            if (!state.isProcessing && !state.isPaused && st.isRunning) {
                st.isRunning = false;
                stopStatePolling(tab);
                updateBlockedOverlay();
            }

            if (!state.isProcessing && state.isPaused && st.isRunning) {
                st.isRunning = false;
                updateBlockedOverlay();
                updateStatus("warning", "Pausado pelo sistema");
                el(tab, "stopBtn").classList.add("hidden");
                el(tab, "emergencyStopBtn").classList.add("hidden");
                el(tab, "startBtn").classList.remove("hidden");
                el(tab, "startBtn").textContent = "Continuar";
                el(tab, "startBtn").onclick = () => continueSending(tab);
                el(tab, "cancelAllBtn").classList.remove("hidden");
            }

            // v2.0.1: Polling de videos DURANTE o envio (nao so apos QUEUE_COMPLETE)
            if (tab === "video") {
                try {
                    const resp = await chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_VIDEOS" });
                    if (resp?.success && resp.videos?.length > 0) {
                        processInterceptedVideos(resp.videos, resp.matchedVideos);
                    }
                } catch (e2) {}
            }
        } catch (e) {}
    }, 5000);
}

function stopStatePolling(tab) {
    const st = tabState[tab];
    if (st.statePollingTimer) { clearInterval(st.statePollingTimer); st.statePollingTimer = null; }
}

// ============================================
// SETTINGS
// ============================================
function saveSettings() {
    chrome.runtime.sendMessage({
        action: "SAVE_SETTINGS",
        settings: {
            batchSize: parseInt(document.getElementById("batchSize").value),
            batchInterval: parseInt(document.getElementById("batchInterval").value),
            promptDelay: parseInt(document.getElementById("promptDelay").value),
            autoDownload: document.getElementById("autoDownload").checked,
            backgroundMode: document.getElementById("backgroundMode").checked,
            videoFolder: tabState.video.folder,
            imageFolder: tabState.image.folder
        }
    });
}


// ============================================
// UI UPDATES
// ============================================
function updateStatus(type, text) {
    document.getElementById("statusBar").className = "status-bar " + type;
    document.getElementById("statusText").textContent = text;
}

function updateProgress(percent, text, tab) {
    el(tab, "progressContainer").classList.remove("hidden");
    el(tab, "progressFill").style.width = percent + "%";
    el(tab, "progressText").textContent = text;
}

// ============================================
// PROCESS PROMPTS
// ============================================
function processPrompts(tab) {
    try {
    const st = tabState[tab];
    const inputEl = el(tab, "promptsInput");
    if (!inputEl) { console.error("[Panel] promptsInput nao encontrado para tab:", tab); return; }
    const input = inputEl.value.trim();
    if (!input) { updateStatus("error", "Cole seus prompts primeiro!"); return; }

    const parts = input.split(/(?=PROMPT\s*\d+)/i).filter(p => p.trim());
    st.prompts = [];
    st.detectedMedia = {};

    if (tab === "video") {
        window.parent.postMessage({ type: "CLEAR_DETECTED_VIDEOS" }, "*");
    } else {
        window.parent.postMessage({ type: "CLEAR_DETECTED_IMAGES" }, "*");
    }

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const numMatch = trimmed.match(/PROMPT\s*(\d+)/i);
        if (!numMatch) continue;
        const num = parseInt(numMatch[1]);
        const elemMatch = trimmed.match(/\[([0-9,\s]+)\]/);
        let elements = elemMatch ? elemMatch[1].split(",").map(e => parseInt(e.trim())).filter(e => !isNaN(e)) : [];
        let text = trimmed
            .replace(/PROMPT\s*\d+\s*/i, "")
            .replace(/\[[0-9,\s]+\]\s*/g, "")
            .replace(/\|\s*[\d:]+\s*-\s*[\d:]+\s*/g, "")
            .replace(/^:\s*/, "")
            .trim();
        if (text) {
            st.prompts.push({
                number: num, elements, text: "PROMPT " + num + ": " + text,
                status: "waiting", mediaStatus: "pending", mediaUrl: null
            });
        }
    }

    st.prompts.sort((a, b) => a.number - b.number);
    if (st.prompts.length === 0) { updateStatus("error", "Nenhum prompt encontrado!"); return; }

    saveSettings();
    displayPrompts(tab);

    el(tab, "inputSection").classList.add("hidden");
    el(tab, "settingsCard").classList.add("hidden");
    el(tab, "formatInfo").classList.add("hidden");
    el(tab, "promptListCard").classList.remove("hidden");
    el(tab, "processBtn").classList.add("hidden");
    el(tab, "startBtn").classList.remove("hidden");
    el(tab, "startBtn").textContent = "Iniciar Envio";
    el(tab, "startBtn").onclick = () => startSending(tab);
    document.getElementById("sharedSettingsCard").classList.add("hidden");

    const batchSize = parseInt(document.getElementById("batchSize").value);
    const batchCount = Math.ceil(st.prompts.length / batchSize);
    const elemCount = st.prompts.filter(p => p.elements.length > 0).length;
    updateStatus("success", st.prompts.length + " prompts (" + elemCount + " com elementos) | " + batchCount + " lotes");
    console.log("[Panel] processPrompts OK tab=" + tab + " prompts=" + st.prompts.length);
    } catch (err) {
        console.error("[Panel] processPrompts ERRO tab=" + tab, err);
        updateStatus("error", "Erro ao processar: " + err.message);
    }
}

// ============================================
// DISPLAY PROMPTS
// ============================================
function displayPrompts(tab) {
    const container = el(tab, "promptItems");
    const counter = el(tab, "promptCount");
    const st = tabState[tab];

    counter.textContent = st.prompts.filter(p => p.status === "sent").length + "/" + st.prompts.length;

    container.innerHTML = st.prompts.map((p) => {
        const elemStr = p.elements.length > 0 ? "[" + p.elements.join(",") + "]" : "";
        let icon = "&#9203;";
        if (p.status === "sending") icon = "&#128260;";
        else if (p.status === "sent") {
            if (p.mediaStatus === "downloaded") icon = "&#128190;";
            else if (p.mediaStatus === "upscaling") icon = "&#11014;";
            else if (p.mediaStatus === "generated") icon = "&#9989;";
            else icon = "&#9203;";
        } else if (p.status === "error") icon = "&#10060;";

        let statusClass = p.status;
        if (p.mediaStatus === "downloaded") statusClass += " downloaded";
        else if (p.mediaStatus === "upscaling") statusClass += " upscaling";
        else if (p.mediaStatus === "generated") statusClass += " generated";

        return '<div class="prompt-item ' + statusClass + '">' +
            '<span class="number">' + p.number + '</span>' +
            (elemStr ? '<span class="elements">' + elemStr + '</span>' : '') +
            '<span class="text" title="' + p.text.replace(/"/g, '&quot;') + '">' + p.text.substring(0, 32) + '...</span>' +
            '<span class="status-icon">' + icon + '</span>' +
            '</div>';
    }).join("");
}

// ============================================
// STATS DISPLAY
// ============================================
function updateStatsDisplay(tab) {
    const st = tabState[tab];
    const sentCount = st.prompts.filter(p => p.status === "sent").length;
    // v2.2.1: Contar upscaling como gerado (esta em progresso de download)
    const generatedCount = st.prompts.filter(p =>
        p.mediaStatus === "generated" || p.mediaStatus === "downloaded" || p.mediaStatus === "upscaling"
    ).length;
    const downloadedCount = st.prompts.filter(p => p.mediaStatus === "downloaded").length;
    const errorCount = st.prompts.filter(p => p.status === "error").length;
    const notGeneratedCount = errorCount + st.prompts.filter(p =>
        p.status === "sent" && p.mediaStatus === "pending" && !p._downloading
    ).length;

    el(tab, "statSent").textContent = sentCount;
    el(tab, "statGenerated").textContent = generatedCount;
    el(tab, "statFailed").textContent = notGeneratedCount;
    el(tab, "statDownloaded").textContent = downloadedCount;

    // Atualizar botao de reenvio dinamicamente (quando nao esta rodando)
    if (!st.isRunning && st.prompts.length > 0) {
        const totalProblems = errorCount + Math.max(0, sentCount - generatedCount);
        if (totalProblems > 0) {
            el(tab, "resendBtn").classList.remove("hidden");
            el(tab, "resendBtn").textContent = "Reenviar Nao Gerados (" + totalProblems + ")";
            el(tab, "copyFailedBtn").classList.remove("hidden");
        } else {
            el(tab, "resendBtn").classList.add("hidden");
            el(tab, "copyFailedBtn").classList.add("hidden");
            // Atualizar status se todos foram gerados
            const mediaLabel = tab === "video" ? "videos" : "imagens";
            if (downloadedCount === sentCount && sentCount > 0) {
                updateStatus("success", "Perfeito! Todos os " + sentCount + " " + mediaLabel + " foram baixados!");
            } else if (generatedCount === sentCount && sentCount > 0) {
                updateStatus("success", "Perfeito! Todos os " + sentCount + " " + mediaLabel + " foram gerados!");
            }
        }
    }
}

// ============================================
// SENDING
// ============================================
async function startSending(tab) {
    const st = tabState[tab];
    const otherTab = tab === "video" ? "image" : "video";

    if (tabState[otherTab].isRunning) {
        updateStatus("error", "Aguarde o processamento da outra aba terminar!");
        return;
    }

    try {
        const tabInfo = await chrome.runtime.sendMessage({ action: "GET_ACTIVE_TAB" });
        currentTabId = tabInfo?.tabId;
    } catch (e) {}

    if (!currentTabId) { updateStatus("error", "Tab nao encontrada!"); return; }
    if (st.isRunning) return;
    st.isRunning = true;
    updateBlockedOverlay();

    const waitingPrompts = st.prompts.filter(p => p.status === "waiting");
    if (waitingPrompts.length === 0) {
        updateStatus("success", "Todos enviados!");
        st.isRunning = false;
        updateBlockedOverlay();
        return;
    }

    // v2.0.1: Zoom out ANTES de enviar - mostra todos os cards de video
    if (tab === "video") {
        window.parent.postMessage({ type: "SET_PAGE_ZOOM", data: { zoom: 0.33 } }, "*");
    }

    // Iniciar deteccao de midia (image ou video)
    if (tab === "image") {
        window.parent.postMessage({ type: "START_IMAGE_DETECTION" }, "*");
    }
    updateStatus("running", "Preparando envio...");

    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.remove("hidden");
    el(tab, "emergencyStopBtn").classList.remove("hidden");
    el(tab, "cancelAllBtn").classList.remove("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "progressContainer").classList.remove("hidden");
    el(tab, "statusCard").classList.remove("hidden");
    // Mostrar lembrete da pasta de downloads
    const frDiv = el(tab, "FolderReminder");
    if (frDiv) {
        frDiv.innerHTML = "Pasta de downloads: <span>" + getFolder(tab) + "</span>";
        frDiv.classList.remove("hidden");
    }

    const settings = {
        batchSize: parseInt(document.getElementById("batchSize").value),
        batchInterval: parseInt(document.getElementById("batchInterval").value),
        promptDelay: parseInt(document.getElementById("promptDelay").value),
        outputCount: tabState[tab].outputCount || 1
    };

    updateStatus("running", "Iniciando envio de " + waitingPrompts.length + " prompts...");
    startStatePolling(tab);

    try {
        const result = await chrome.runtime.sendMessage({
            action: "START_QUEUE",
            prompts: waitingPrompts,
            settings: settings,
            tabId: currentTabId,
            mediaType: tab,
            backgroundMode: backgroundMode
        });
        if (result && !result.success) {
            st.isRunning = false;
            updateBlockedOverlay();
            stopStatePolling(tab);
            el(tab, "stopBtn").classList.add("hidden");
            el(tab, "startBtn").classList.remove("hidden");
            updateStatus("error", result.message || result.error || "Erro ao iniciar envio");
            return;
        }
    } catch (e) {
        window.parent.postMessage({
            type: "START_QUEUE",
            data: { prompts: waitingPrompts, settings: settings }
        }, "*");
    }
}

async function continueSending(tab) {
    const st = tabState[tab];
    st.isRunning = true;
    updateBlockedOverlay();
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.remove("hidden");
    el(tab, "emergencyStopBtn").classList.remove("hidden");
    el(tab, "cancelAllBtn").classList.remove("hidden");
    updateStatus("running", "Retomando envio...");
    startStatePolling(tab);

    try { await chrome.runtime.sendMessage({ action: "RESUME_QUEUE" }); }
    catch (e) { window.parent.postMessage({ type: "RESUME_QUEUE" }, "*"); }
}

async function stopSending(tab) {
    const st = tabState[tab];
    st.isRunning = false;
    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    // v2.0.1: Restaurar zoom ao parar (1 zoom out)
    window.parent.postMessage({ type: "SET_PAGE_ZOOM", data: { zoom: 1.0 } }, "*");

    try { await chrome.runtime.sendMessage({ action: "PAUSE_QUEUE" }); }
    catch (e) { window.parent.postMessage({ type: "PAUSE_QUEUE" }, "*"); }

    updateStatus("warning", "Parado pelo usuario");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "startBtn").classList.remove("hidden");
    el(tab, "startBtn").textContent = "Continuar";
    el(tab, "startBtn").onclick = () => continueSending(tab);
    el(tab, "cancelAllBtn").classList.remove("hidden");
    el(tab, "timer").classList.add("hidden");
}

async function emergencyStop(tab) {
    console.log("[Panel] EMERGENCY STOP -", tab);
    const st = tabState[tab];
    st.isRunning = false;
    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    // v2.0.1: Restaurar zoom (1 zoom out)
    window.parent.postMessage({ type: "SET_PAGE_ZOOM", data: { zoom: 1.0 } }, "*");

    try { await chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" }); } catch (e) {}
    try { window.parent.postMessage({ type: "CANCEL_QUEUE" }, "*"); } catch (e) {}

    updateStatus("warning", "PARADO - Fila cancelada");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "timer").classList.add("hidden");

    if (st.prompts.length > 0) {
        const failedPrompts = st.prompts.filter(p => p.status === "error" || p.status === "waiting" || p.status === "sending");
        if (failedPrompts.length > 0) {
            el(tab, "resendBtn").classList.remove("hidden");
            el(tab, "resendBtn").textContent = "Reenviar Faltantes (" + failedPrompts.length + ")";
        }
        el(tab, "copyFailedBtn").classList.remove("hidden");
        el(tab, "startBtn").classList.remove("hidden");
        el(tab, "startBtn").textContent = "Novo Envio";
        el(tab, "startBtn").onclick = () => resetAll(tab);
    } else {
        el(tab, "startBtn").classList.remove("hidden");
        el(tab, "startBtn").textContent = "Novo Envio";
        el(tab, "startBtn").onclick = () => resetAll(tab);
    }

    // Se aba de imagem, voltar para modo de video
    if (tab === "image") {
        window.parent.postMessage({ type: "SWITCH_TO_VIDEO_MODE" }, "*");
    }
}

// ============================================
// FINISH SENDING
// ============================================
function finishSending(tab) {
    const st = tabState[tab];
    st.isRunning = false;
    stopStatePolling(tab);
    updateBlockedOverlay();

    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "timer").classList.add("hidden");

    updateStatsDisplay(tab);

    const sentCount = st.prompts.filter(p => p.status === "sent").length;
    // v2.2.1: Contar upscaling como "em progresso" (nao como problema)
    const generatedCount = st.prompts.filter(p =>
        p.mediaStatus === "generated" || p.mediaStatus === "downloaded" || p.mediaStatus === "upscaling"
    ).length;
    const downloadedCount = st.prompts.filter(p => p.mediaStatus === "downloaded").length;
    const errorCount = st.prompts.filter(p => p.status === "error").length;
    // v2.2.1: So contar como "nao gerado" prompts enviados que ficaram pendentes (nao em progresso)
    const notGeneratedYet = st.prompts.filter(p =>
        p.status === "sent" && p.mediaStatus === "pending" && !p._downloading
    ).length;
    const totalProblems = errorCount + notGeneratedYet;

    if (totalProblems > 0) {
        el(tab, "resendBtn").classList.remove("hidden");
        el(tab, "resendBtn").textContent = "Reenviar Nao Gerados (" + totalProblems + ")";
        el(tab, "copyFailedBtn").classList.remove("hidden");
    } else {
        el(tab, "resendBtn").classList.add("hidden");
        el(tab, "copyFailedBtn").classList.add("hidden");
    }

    el(tab, "startBtn").classList.remove("hidden");
    el(tab, "startBtn").textContent = "Novo Envio";
    el(tab, "startBtn").onclick = () => resetAll(tab);
    el(tab, "cancelAllBtn").classList.remove("hidden");

    const mediaLabel = tab === "video" ? "videos" : "imagens";
    if (totalProblems === 0) {
        updateStatus("success", "Perfeito! Todos os " + sentCount + " " + mediaLabel + " foram gerados!");
    } else if (downloadedCount > 0) {
        updateStatus("success", "Concluido! " + downloadedCount + " " + mediaLabel + " baixados!");
    } else {
        updateStatus("warning", totalProblems + " prompt(s) precisam de atencao");
    }
}

// ============================================
// RESET / CANCEL
// ============================================
function resetAll(tab) {
    const st = tabState[tab];
    st.prompts = [];
    st.detectedMedia = {};
    stopStatePolling(tab);

    if (tab === "video") {
        window.parent.postMessage({ type: "CLEAR_DETECTED_VIDEOS" }, "*");
    } else {
        window.parent.postMessage({ type: "CLEAR_DETECTED_IMAGES" }, "*");
    }
    try { chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" }); } catch (e) {}

    el(tab, "inputSection").classList.remove("hidden");
    el(tab, "settingsCard").classList.remove("hidden");
    el(tab, "formatInfo").classList.remove("hidden");
    el(tab, "promptListCard").classList.add("hidden");
    el(tab, "progressContainer").classList.add("hidden");
    el(tab, "statusCard").classList.add("hidden");
    const frDiv = el(tab, "FolderReminder");
    if (frDiv) frDiv.classList.add("hidden");
    el(tab, "processBtn").classList.remove("hidden");
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "cancelAllBtn").classList.add("hidden");
    el(tab, "timer").classList.add("hidden");
    el(tab, "promptsInput").value = "";
    el(tab, "progressFill").style.width = "0%";
    el(tab, "progressText").textContent = "0%";
    document.getElementById("sharedSettingsCard").classList.remove("hidden");

    updateStatsDisplay(tab);
    updateStatus("success", "Pronto! Cole seus prompts para um novo envio");
}

async function cancelAll(tab) {
    if (!confirm("Cancelar tudo e resetar cache/log?")) return;
    const st = tabState[tab];
    st.isRunning = false;
    stopAllTimers(tab);
    stopStatePolling(tab);
    updateBlockedOverlay();

    // v2.0.1: Restaurar zoom (1 zoom out)
    window.parent.postMessage({ type: "SET_PAGE_ZOOM", data: { zoom: 1.0 } }, "*");

    // Reset completo: cancela fila E limpa todo cache/log do background
    try { await chrome.runtime.sendMessage({ action: "FULL_RESET" }); }
    catch (e) {
        try { await chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" }); } catch (e2) {}
        window.parent.postMessage({ type: "CANCEL_QUEUE" }, "*");
    }

    window.parent.postMessage({ type: "CLEAR_DETECTED_VIDEOS" }, "*");
    window.parent.postMessage({ type: "CLEAR_DETECTED_IMAGES" }, "*");

    st.prompts = [];
    st.detectedMedia = {};

    el(tab, "inputSection").classList.remove("hidden");
    el(tab, "settingsCard").classList.remove("hidden");
    el(tab, "formatInfo").classList.remove("hidden");
    el(tab, "promptListCard").classList.add("hidden");
    el(tab, "progressContainer").classList.add("hidden");
    el(tab, "statusCard").classList.add("hidden");
    el(tab, "processBtn").classList.remove("hidden");
    el(tab, "startBtn").classList.add("hidden");
    el(tab, "stopBtn").classList.add("hidden");
    el(tab, "emergencyStopBtn").classList.add("hidden");
    el(tab, "cancelAllBtn").classList.add("hidden");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");
    el(tab, "progressFill").style.width = "0%";
    el(tab, "progressText").textContent = "0%";
    el(tab, "timer").classList.add("hidden");
    el(tab, "promptsInput").value = "";
    document.getElementById("sharedSettingsCard").classList.remove("hidden");

    if (tab === "image") {
        window.parent.postMessage({ type: "SWITCH_TO_VIDEO_MODE" }, "*");
    }

    updateStatus("success", "Pronto! Cole seus prompts");
}

// ============================================
// RESEND / COPY FAILED
// ============================================
async function resendFailed(tab) {
    const st = tabState[tab];

    // v2.1.0: Consultar log persistente para precisao extra
    try {
        const logData = await chrome.runtime.sendMessage({ action: "GET_PROMPT_LOG" });
        if (logData?.log?.length > 0) {
            for (const prompt of st.prompts) {
                // Procurar no log o registro mais recente deste prompt
                for (let i = logData.log.length - 1; i >= 0; i--) {
                    const entry = logData.log[i];
                    if (entry.number === prompt.number && entry.mediaType === tab) {
                        // Se o log diz que foi gerado/baixado mas o panel nao sabe, atualizar
                        if (entry.mediaStatus === "generated" && prompt.mediaStatus === "pending") {
                            prompt.mediaStatus = "generated";
                        } else if (entry.mediaStatus === "downloaded" && prompt.mediaStatus !== "downloaded") {
                            prompt.mediaStatus = "downloaded";
                        }
                        break;
                    }
                }
            }
        }
    } catch (e) {}

    // SO reenviar prompts que realmente falharam (com dados do log ja aplicados)
    const failedPrompts = st.prompts.filter(p =>
        p.status === "error" ||
        (p.status === "sent" && p.mediaStatus === "pending" && !p._downloading)
    );

    if (failedPrompts.length === 0) {
        updateStatus("success", "Todos foram gerados!");
        el(tab, "resendBtn").classList.add("hidden");
        return;
    }

    failedPrompts.forEach(p => {
        p.status = "waiting";
        p.mediaStatus = "pending";
        p.mediaUrl = null;
        p._downloading = false;
        p.errorReason = null;
    });

    displayPrompts(tab);
    updateStatsDisplay(tab);
    updateStatus("warning", "Reenviando " + failedPrompts.length + " prompts...");
    el(tab, "resendBtn").classList.add("hidden");
    el(tab, "copyFailedBtn").classList.add("hidden");

    await startSending(tab);
}

function copyFailedNumbers(tab) {
    const st = tabState[tab];
    // v2.2.1: Mesma logica de resendFailed
    const failedPrompts = st.prompts.filter(p =>
        p.status === "error" ||
        (p.status === "sent" && p.mediaStatus === "pending" && !p._downloading)
    );

    if (failedPrompts.length === 0) { updateStatus("success", "Nenhum faltante!"); return; }

    const numbers = failedPrompts.map(p => p.number).join(", ");
    window.parent.postMessage({ type: "COPY_TEXT", data: numbers }, "*");

    const textarea = document.createElement("textarea");
    textarea.value = numbers;
    textarea.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;padding:0;border:none;outline:none;box-shadow:none;background:transparent;";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    let copied = false;
    try { copied = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(textarea);

    if (copied) updateStatus("success", "Copiado: " + numbers);
    else { updateStatus("warning", "Numeros: " + numbers); window.prompt("Copie manualmente:", numbers); }
}

// ============================================
// UTILITIES
// ============================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function showWaitingCounter(seconds, statusText, tab) {
    stopAllTimers(tab);
    const timer = el(tab, "timer");
    timer.classList.remove("hidden");
    updateStatus("warning", statusText);

    const st = tabState[tab];
    const totalPrompts = st.prompts.filter(p => p.status === "sent").length;

    for (let remaining = seconds; remaining >= 0; remaining--) {
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        timer.textContent = String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");

        if (remaining % 2 === 0) {
            if (tab === "video") {
                // v2.0.1 FIX: Pedir videos DIRETO ao background.js via chrome.runtime
                // Evita depender do postMessage panel↔content.js que pode falhar
                try {
                    const resp = await chrome.runtime.sendMessage({ action: "GET_INTERCEPTED_VIDEOS" });
                    if (resp?.success && resp.videos?.length > 0) {
                        processInterceptedVideos(resp.videos, resp.matchedVideos);
                    }
                } catch (e) {}
            } else {
                window.parent.postMessage({ type: "GET_DETECTED_IMAGES" }, "*");
            }
            updateStatsDisplay(tab);

            // Auto-scroll na pagina do Flow para forcar virtual scroll a renderizar mais cards
            if (remaining % 4 === 0) {
                window.parent.postMessage({ type: "SCROLL_TO_REVEAL_MEDIA" }, "*");
            }
        }

        // Early exit: se todos os prompts ja foram baixados, nao precisa esperar
        const downloadedCount = st.prompts.filter(p => p.mediaStatus === "downloaded").length;
        if (downloadedCount >= totalPrompts) {
            console.log("[Panel] Todos", totalPrompts, "baixados - encerrando espera");
            break;
        }

        if (remaining > 0) await sleep(1000);
    }

    timer.classList.add("hidden");
}
