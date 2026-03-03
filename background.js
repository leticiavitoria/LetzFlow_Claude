// ============================================
// LETZFLOW SENDER - BACKGROUND v2.1.0
// Uso pessoal - sem licenciamento
// ============================================

const WINDOW_SIZES = {
    mini: { width: 420, height: 320 },
    normal: { width: 1200, height: 800 }
};

let veoWindowId = null;
let isWindowMini = false;

// ============================================
// SISTEMA DE FILA - v2.0.0 COM ESTADO COMPLETO
// ============================================
let promptQueue = [];
let processedPrompts = []; // v2.0.0: historico de prompts processados
let queueSettings = { promptDelay: 3000, batchSize: 20, batchInterval: 90000 };
let currentBatchCount = 0;
let queuePaused = false;
let isProcessingQueue = false;
let targetTabId = null;
let totalProcessed = 0;
let lastActivityTime = 0; // v2.0.0: watchdog
let queueMediaType = "video"; // v2.0.0: tipo de media ativa (video/image)
let firstPromptOfBatch = true; // v2.1.0: setup completo so no primeiro prompt

// v2.0.0: Interceptor de downloads - controla pasta, nome e contabilizacao
// PERSISTIDO no storage para sobreviver ao service worker dormindo
let pendingUpscaleDownloads = {};
// Formato: { id: { promptNumber, promptText, folder, resolution, type, timestamp } }

function savePendingDownloads() {
    chrome.storage.local.set({ dottiPendingDownloads: pendingUpscaleDownloads });
}

async function loadPendingDownloads() {
    const data = await chrome.storage.local.get('dottiPendingDownloads');
    if (data.dottiPendingDownloads) {
        pendingUpscaleDownloads = data.dottiPendingDownloads;
    }
}


function setBadgeStatus(status) {
    if (status === "active") {
        chrome.action.setBadgeText({ text: "" });
        chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    } else if (status === "processing") {
        chrome.action.setBadgeText({ text: "▶" });
        chrome.action.setBadgeBackgroundColor({ color: "#3b82f6" });
    } else {
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    }
}

// ============================================
// WINDOW MANAGEMENT
// ============================================
async function openVeoWindow(mini = true) {
    let win;
    if (mini) {
        const size = WINDOW_SIZES.mini;
        const displays = await chrome.system.display.getInfo();
        const pd = displays[0];
        win = await chrome.windows.create({
            url: "https://labs.google/fx/tools/flow",
            type: "popup",
            width: size.width,
            height: size.height,
            left: pd.workArea.width - size.width - 20,
            top: pd.workArea.height - size.height - 20,
            focused: true
        });
    } else {
        win = await chrome.windows.create({
            url: "https://labs.google/fx/tools/flow",
            type: "popup",
            state: "maximized",
            focused: true
        });
    }
    veoWindowId = win.id;
    isWindowMini = mini;
    if (win.tabs?.[0]) {
        targetTabId = win.tabs[0].id;
        await chrome.storage.local.set({ veoWindowId, veoTabId: targetTabId, isWindowMini });
    }
    return win;
}

async function toggleWindowSize() {
    if (!veoWindowId) return { success: false, error: "no_window" };
    try {
        isWindowMini = !isWindowMini;
        const size = isWindowMini ? WINDOW_SIZES.mini : WINDOW_SIZES.normal;
        const displays = await chrome.system.display.getInfo();
        const pd = displays[0];
        if (isWindowMini) {
            await chrome.windows.update(veoWindowId, {
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            if (isProcessingQueue) {
                await injectStatusOverlay();
                await updateStatusOverlay("Processando...", totalProcessed, totalProcessed + promptQueue.length);
            }
        } else {
            // PRIMEIRO remover overlay (antes de redimensionar), para evitar
            // que o overlay em 100vw/100vh cubra a tela expandida
            await removeStatusOverlay();
            await chrome.windows.update(veoWindowId, {
                width: size.width,
                height: size.height,
                left: Math.round((pd.workArea.width - size.width) / 2),
                top: Math.round((pd.workArea.height - size.height) / 2)
            });
            // Garantir que overlay foi removido e pagina restaurada
            await restorePageAfterOverlay();
        }
        await chrome.storage.local.set({ isWindowMini });
        return { success: true, isMini: isWindowMini };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function focusVeoWindow() {
    if (!veoWindowId) return;
    try {
        if (isWindowMini && isProcessingQueue) {
            await chrome.windows.update(veoWindowId, { drawAttention: false });
        } else {
            await chrome.windows.update(veoWindowId, { focused: true });
        }
    } catch (e) {
        veoWindowId = null;
    }
}

chrome.windows.onRemoved.addListener((id) => {
    if (id === veoWindowId) {
        veoWindowId = null;
        targetTabId = null;
        chrome.storage.local.remove(['veoWindowId', 'veoTabId']);
    }
});

// ============================================
// QUEUE PERSISTENCE - v2.0.0 ESTADO COMPLETO
// ============================================
async function saveQueueState() {
    await chrome.storage.local.set({
        dottiQueue: promptQueue,
        dottiProcessedPrompts: processedPrompts,
        dottiSettings: queueSettings,
        dottiBatchCount: currentBatchCount,
        dottiPaused: queuePaused,
        dottiTabId: targetTabId,
        dottiProcessing: isProcessingQueue,
        dottiTotalProcessed: totalProcessed,
        dottiLastActivity: lastActivityTime,
        dottiMediaType: queueMediaType
    });
}

async function loadQueueState() {
    const data = await chrome.storage.local.get([
        'dottiQueue', 'dottiProcessedPrompts', 'dottiSettings', 'dottiBatchCount',
        'dottiPaused', 'dottiTabId', 'dottiProcessing', 'dottiTotalProcessed',
        'dottiLastActivity', 'dottiMediaType', 'veoWindowId', 'veoTabId', 'isWindowMini'
    ]);
    if (data.veoWindowId) {
        veoWindowId = data.veoWindowId;
        targetTabId = data.veoTabId;
        isWindowMini = data.isWindowMini !== false;
    }
    if (data.dottiQueue?.length > 0) {
        promptQueue = data.dottiQueue;
        processedPrompts = data.dottiProcessedPrompts || [];
        queueSettings = data.dottiSettings || queueSettings;
        currentBatchCount = data.dottiBatchCount || 0;
        queuePaused = data.dottiPaused || false;
        totalProcessed = data.dottiTotalProcessed || 0;
        lastActivityTime = data.dottiLastActivity || 0;
        queueMediaType = data.dottiMediaType || "video";
        isProcessingQueue = data.dottiProcessing || false;
        return true;
    }
    // v2.0.0: restaurar processedPrompts mesmo sem fila ativa
    if (data.dottiProcessedPrompts?.length > 0) {
        processedPrompts = data.dottiProcessedPrompts;
        totalProcessed = data.dottiTotalProcessed || 0;
    }
    return false;
}

async function clearQueueState() {
    promptQueue = [];
    processedPrompts = [];
    currentBatchCount = 0;
    isProcessingQueue = false;
    queuePaused = false;
    totalProcessed = 0;
    lastActivityTime = 0;
    queueMediaType = "video";
    await chrome.storage.local.remove([
        'dottiQueue', 'dottiProcessedPrompts', 'dottiSettings', 'dottiBatchCount',
        'dottiPaused', 'dottiTabId', 'dottiProcessing', 'dottiTotalProcessed',
        'dottiLastActivity', 'dottiMediaType'
    ]);
}

async function notifyTab(message) {
    if (!targetTabId) return;
    try {
        await chrome.tabs.sendMessage(targetTabId, message);
    } catch (e) {
        // Tab pode ter sido fechada - nao e critico
    }
}

// ============================================
// HELPERS
// ============================================
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// v2.0.0: waitFor condicional em vez de sleep fixo
async function waitForCondition(tabId, conditionFn, args, timeout = 10000, interval = 300) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            const result = await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: conditionFn,
                args: args || []
            });
            if (result?.[0]?.result) return true;
        } catch (e) {
            // Tab pode nao estar pronta ainda
        }
        await sleep(interval);
    }
    return false;
}

// ============================================
// EXECUTE PROMPT - v2.0.0 COM WAITFOR
// ============================================
async function executePromptInTab(prompt, mediaType) {
    console.log("[LetzFlow] Executing prompt", prompt.number);
    lastActivityTime = Date.now();

    // Verificar se a janela ainda existe
    if (isWindowMini) {
        try {
            await chrome.windows.get(veoWindowId);
        } catch (e) {
            veoWindowId = null;
            return { success: false, error: "window_closed" };
        }
    } else {
        await focusVeoWindow();
    }

    // v2.0.0: Esperar pagina estar pronta (contenteditable textbox visivel)
    const pageReady = await waitForCondition(targetTabId, function() {
        const ta = document.querySelector("[role='textbox']");
        return ta && ta.offsetParent !== null;
    }, [], 15000, 500);

    if (!pageReady) {
        console.log("[Dotti] Page not ready after 15s");
        return { success: false, error: "page_not_ready" };
    }

    await sleep(200);

    const hasElements = prompt.elements?.length > 0;

    // v2.1.0: Setup de output count so no PRIMEIRO prompt do lote
    // A aba do Flow ja foi trocada pelo panel.js quando o usuario mudou de aba
    if (firstPromptOfBatch) {
        console.log("[Dotti] Primeiro prompt - setup output count");

        // Definir quantidade de outputs (respostas por comando) - so no primeiro prompt
        const outCount = queueSettings.outputCount || 1;
        if (outCount > 1) {
            console.log("[Dotti] Definindo outputs per prompt =", outCount);
            try {
                const setResult = await Promise.race([
                    chrome.tabs.sendMessage(targetTabId, {
                        action: "SET_OUTPUTS_PER_PROMPT",
                        count: outCount
                    }),
                    sleep(10000).then(() => ({ timeout: true }))
                ]);
                console.log("[Dotti] SET_OUTPUTS_PER_PROMPT result:", JSON.stringify(setResult));
                await sleep(1000);
            } catch (e) {
                console.log("[Dotti] SET_OUTPUTS_PER_PROMPT failed:", e.message);
            }
        }

        firstPromptOfBatch = false;
        console.log("[Dotti] Setup completo - prosseguindo com prompt");
    }

    // Delay de seguranca antes dos steps (dar tempo pro Flow estabilizar UI)
    await sleep(800);

    console.log("[Dotti] Iniciando steps 1-5 (mode=" + mediaType + ", hasElements=" + hasElements + ")");

    try {
        // 1. Trocar modo Video/Imagem - abrir seletor e clicar na tab correta
        console.log("[Dotti] Step 1: selecionando modo", mediaType);

        // Helper: simular clique completo com coordenadas (funciona com frameworks Google)
        const simulateClickScript = `
            window.__dottiClick = function(el) {
                const rect = el.getBoundingClientRect();
                const x = rect.left + rect.width / 2;
                const y = rect.top + rect.height / 2;
                const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, detail: 1 };
                el.dispatchEvent(new PointerEvent("pointerover", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mouseover", opts));
                el.dispatchEvent(new MouseEvent("mouseenter", opts));
                el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mousedown", opts));
                el.focus && el.focus();
                el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1, pointerType: "mouse" }));
                el.dispatchEvent(new MouseEvent("mouseup", opts));
                el.dispatchEvent(new MouseEvent("click", opts));
            };
        `;
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (script) => { eval(script); },
            args: [simulateClickScript]
        });

        // Step 1a: Abrir seletor de modo
        const openResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                const tb = document.querySelector("[role='textbox']");
                if (!tb) return { found: false, reason: "no_textbox" };
                const tbY = tb.getBoundingClientRect().top;
                let modeBtn = null;
                let modeBtnText = "";
                document.querySelectorAll("button").forEach(b => {
                    if (b.offsetParent === null) return;
                    const r = b.getBoundingClientRect();
                    if (Math.abs(r.top - tbY) < 100 && r.width > 60 && r.width < 200) {
                        const t = b.textContent.toLowerCase();
                        if (t.indexOf("crop") >= 0 || t.indexOf("videocam") >= 0 || t.indexOf("movie") >= 0 || t.indexOf("image") >= 0 || t.indexOf("video") >= 0) {
                            modeBtn = b;
                            modeBtnText = t;
                        }
                    }
                });
                if (!modeBtn) return { found: false, reason: "no_mode_btn" };
                window.__dottiClick(modeBtn);
                return { found: true, text: modeBtnText };
            }
        });
        const or = openResult?.[0]?.result;
        console.log("[Dotti] Step 1a open selector:", JSON.stringify(or));
        await sleep(1200);

        // Step 1b: Clicar na tab do modo correto
        const modeResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (targetMode) => {
                const tabs = document.querySelectorAll('button[role="tab"]');
                const allTabTexts = Array.from(tabs).map(t => ({
                    text: t.textContent.trim().toLowerCase(),
                    visible: t.offsetParent !== null,
                    selected: t.getAttribute("aria-selected")
                }));
                let targetTab = null;
                // Match exato primeiro
                for (const tab of tabs) {
                    if (tab.offsetParent === null) continue;
                    const t = tab.textContent.trim().toLowerCase();
                    if (targetMode === "image" && t === "imageimage") { targetTab = tab; break; }
                    if (targetMode === "video" && t === "videocamvideo") { targetTab = tab; break; }
                }
                // Fallback parcial
                if (!targetTab) {
                    for (const tab of tabs) {
                        if (tab.offsetParent === null) continue;
                        const t = tab.textContent.trim().toLowerCase();
                        if (targetMode === "image" && t.indexOf("image") >= 0 && t.indexOf("view") < 0) { targetTab = tab; break; }
                        if (targetMode === "video" && t.indexOf("video") >= 0 && t.indexOf("view") < 0) { targetTab = tab; break; }
                    }
                }
                if (!targetTab) {
                    return { clicked: false, tabs: allTabTexts };
                }
                const wasSel = targetTab.getAttribute("aria-selected");
                window.__dottiClick(targetTab);
                const nowSel = targetTab.getAttribute("aria-selected");
                return { clicked: true, tab: targetTab.textContent.trim(), before: wasSel, after: nowSel, allTabs: allTabTexts };
            },
            args: [mediaType]
        });
        const mr = modeResult?.[0]?.result;
        console.log("[Dotti] Step 1b tab click:", JSON.stringify(mr));
        await sleep(1000);

        // Fechar seletor clicando no textbox
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                const tb = document.querySelector("[role='textbox']");
                if (tb) window.__dottiClick(tb);
            }
        });
        await sleep(500);
        console.log("[Dotti] Step 1 modo selecionado:", mediaType);

        // 2. Clear elements anexados ao prompt (APENAS perto do textbox, NAO na galeria)
        try {
            await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: () => {
                    const ta = document.querySelector("[role='textbox']");
                    if (!ta) return;
                    const taRect = ta.getBoundingClientRect();

                    document.querySelectorAll("button").forEach(btn => {
                        if (btn.offsetParent === null) return;
                        const icon = btn.querySelector("i");
                        if (!icon) return;
                        const iconText = icon.textContent?.trim();
                        if (iconText !== "close" && iconText !== "clear") return;

                        // So limpar se esta perto do textarea (area de composicao)
                        const btnRect = btn.getBoundingClientRect();
                        if (Math.abs(btnRect.top - taRect.top) > 200) return;

                        // Confirmar que tem thumbnail (img) como irmao
                        const parent = btn.parentElement;
                        if (!parent || !parent.querySelector("img")) return;

                        console.log("[Dotti DOM] Removendo elemento anexado ao prompt");
                        btn.click();
                    });
                }
            });
        } catch (e) {
            console.log("[Dotti] Step 2 clear error (non-fatal):", e.message);
        }
        await sleep(600);

        // 3. Add elements (referencias da galeria)
        if (hasElements) {
            const selectedOriginalIndices = []; // indices originais ja selecionados (0-based)
            for (const elementNum of prompt.elements) {
                // Clicar no botao "add_2" perto do textbox para abrir galeria
                const openResult = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        // Priorizar add_2 (botao perto do textbox)
                        const allBtns = [...document.querySelectorAll("button")].filter(b => b.offsetParent !== null);
                        let addBtn = allBtns.find(b => {
                            const icon = b.querySelector("i");
                            return icon && icon.textContent.trim() === "add_2";
                        });
                        // Fallback: qualquer botao add perto do textbox
                        if (!addBtn) {
                            const tb = document.querySelector("[role='textbox']");
                            const tbY = tb ? tb.getBoundingClientRect().top : 0;
                            addBtn = allBtns.find(b => {
                                const icon = b.querySelector("i");
                                if (!icon) return false;
                                const t = icon.textContent.trim().toLowerCase();
                                if (t !== "add" && t !== "add_circle" && t !== "add_photo_alternate") return false;
                                return Math.abs(b.getBoundingClientRect().top - tbY) < 200;
                            });
                        }
                        if (!addBtn) { console.log("[Dotti DOM] Botao add galeria NAO encontrado"); return false; }
                        console.log("[Dotti DOM] Clicando add_2 via .click()");
                        addBtn.click();
                        return true;
                    }
                });
                if (!openResult?.[0]?.result) {
                    console.log("[Dotti] gallery_failed for element", elementNum);
                    return { success: false, error: "gallery_failed" };
                }

                // Esperar galeria abrir (dialog com imagens)
                await waitForCondition(targetTabId, function() {
                    return document.querySelectorAll('[role="dialog"] img').length > 0 ||
                           document.querySelectorAll('[data-state="open"] img').length > 0;
                }, [], 8000, 300);
                await sleep(500);

                // Ordenar por "Mais antigo" (Oldest) - Radix UI dropdown
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (!dialog) return;
                        // Achar botao de sort (tem "arrow_drop_down" no texto)
                        let sortBtn = null;
                        dialog.querySelectorAll("button").forEach(b => {
                            if (b.textContent.indexOf("arrow_drop_down") >= 0) sortBtn = b;
                        });
                        if (!sortBtn) { console.log("[Dotti DOM] Sort btn nao encontrado"); return; }
                        // Se ja esta em "Oldest"/"Mais antigo", pular
                        if (sortBtn.textContent.indexOf("antigo") >= 0 || sortBtn.textContent.indexOf("ldest") >= 0) {
                            console.log("[Dotti DOM] Ja esta em Mais antigo");
                            return;
                        }
                        // Radix dropdown precisa de PointerEvent
                        console.log("[Dotti DOM] Abrindo sort dropdown...");
                        sortBtn.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
                        sortBtn.dispatchEvent(new PointerEvent("pointerup", {bubbles: true}));
                        sortBtn.dispatchEvent(new MouseEvent("click", {bubbles: true}));
                    }
                });
                await sleep(1000);

                // Clicar em "Mais antigo" / "Oldest"
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        // Procurar opcoes do dropdown Radix (data-state="open" ou elementos visiveis)
                        const items = document.querySelectorAll('[role="menuitem"], [data-radix-collection-item]');
                        for (const item of items) {
                            const t = item.textContent.trim();
                            if (t.indexOf("antigo") >= 0 || t.indexOf("ldest") >= 0) {
                                console.log("[Dotti DOM] Selecionando:", t);
                                item.click();
                                return;
                            }
                        }
                        // Fallback: buscar qualquer elemento visivel com texto "antigo"/"Oldest"
                        document.querySelectorAll("div, span, button, li, a").forEach(el => {
                            const t = el.textContent.trim();
                            const r = el.getBoundingClientRect();
                            if (r.width > 0 && r.height > 10 && r.width < 300 && t.length < 30) {
                                if ((t.indexOf("antigo") >= 0 || t === "Oldest") && el.children.length === 0) {
                                    console.log("[Dotti DOM] Selecionando (fallback):", t);
                                    el.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true}));
                                    el.dispatchEvent(new PointerEvent("pointerup", {bubbles: true}));
                                    el.dispatchEvent(new MouseEvent("click", {bubbles: true}));
                                }
                            }
                        });
                    }
                });
                await sleep(1500);

                // Calcular indice ajustado: imagens ja selecionadas saem da galeria
                const originalIdx = elementNum - 1; // 0-based
                let adjustedIdx = originalIdx;
                for (const prevIdx of selectedOriginalIndices) {
                    if (prevIdx < originalIdx) adjustedIdx--;
                }
                console.log("[Dotti] Element", elementNum, "-> originalIdx:", originalIdx, "adjustedIdx:", adjustedIdx, "prevSelected:", selectedOriginalIndices);

                // Selecionar thumbnail na galeria
                const selectResult = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: (idx) => {
                        const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[data-state="open"]');
                        if (!dialog) { console.log("[Dotti DOM] Dialog nao encontrado"); return false; }
                        const imgs = dialog.querySelectorAll("img");
                        console.log("[Dotti DOM] Gallery imgs:", imgs.length, "selecting idx:", idx);
                        if (idx < imgs.length) {
                            imgs[idx].click();
                            return true;
                        }
                        console.log("[Dotti DOM] Indice", idx, "fora do range (max:", imgs.length - 1, ")");
                        return false;
                    },
                    args: [adjustedIdx]
                });
                if (!selectResult?.[0]?.result) return { success: false, error: "element_select_failed" };
                selectedOriginalIndices.push(originalIdx); // registrar indice selecionado
                await sleep(1500);

                // Fechar dialog se ainda estiver aberto (pode precisar confirmar)
                await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    world: "MAIN",
                    func: () => {
                        const dialog = document.querySelector('[role="dialog"]');
                        if (!dialog) return;
                        // Procurar botao de fechar/confirmar
                        const btns = dialog.querySelectorAll("button");
                        for (const btn of btns) {
                            const icon = btn.querySelector("i");
                            const t = icon ? icon.textContent.trim() : "";
                            if (t === "close" || t === "done" || t === "check") {
                                btn.click();
                                return;
                            }
                        }
                        // Fallback: clicar fora do dialog pra fechar
                        const overlay = dialog.parentElement;
                        if (overlay && overlay !== document.body) {
                            overlay.click();
                        }
                    }
                });
                await sleep(800);
            }
        }

        // 4. Fill textbox via Slate API (contenteditable + Slate.js editor)
        console.log("[Dotti] Step 4: fill textbox via Slate API");
        const fillResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (text) => {
                const ta = document.querySelector("[role='textbox']");
                if (!ta) { console.log("[Dotti DOM] textbox NOT FOUND"); return false; }
                // Encontrar editor Slate via React Fiber
                const fk = Object.keys(ta).find(k => k.startsWith("__reactFiber$"));
                if (!fk) { console.log("[Dotti DOM] React fiber NOT FOUND"); return false; }
                let fiber = ta[fk], editor = null;
                for (let i = 0; i < 50 && fiber; i++) {
                    if (fiber.memoizedProps?.editor?.insertText) { editor = fiber.memoizedProps.editor; break; }
                    if (fiber.memoizedProps?.value?.insertText) { editor = fiber.memoizedProps.value; break; }
                    fiber = fiber.return;
                }
                if (!editor) { console.log("[Dotti DOM] Slate editor NOT FOUND"); return false; }
                // withoutNormalizing forca Slate a sincronizar com React ao final
                editor.withoutNormalizing(() => {
                    try {
                        editor.select({ anchor: editor.start([]), focus: editor.end([]) });
                        editor.deleteFragment();
                    } catch(e) {}
                    editor.insertText(text);
                });
                console.log("[Dotti DOM] Slate filled:", editor.children[0]?.children[0]?.text?.substring(0, 50));
                return true;
            },
            args: [prompt.text]
        });
        if (!fillResult?.[0]?.result) return { success: false, error: "fill_failed" };

        // Esperar DOM atualizar com o texto do Slate
        const fillConfirmed = await waitForCondition(targetTabId, function() {
            const ta = document.querySelector("[role='textbox']");
            if (!ta) return false;
            const text = ta.textContent || "";
            // Verificar que tem conteudo alem do placeholder
            return text.length > 30 || (text.length > 0 && !text.includes("O que voc"));
        }, [], 5000, 300);
        if (!fillConfirmed) {
            console.log("[Dotti] Step 4 FAILED: text fill not confirmed in textbox");
            return { success: false, error: "fill_not_confirmed" };
        }
        await sleep(500);

        // 5. Click submit (botao "Criar" com icone arrow_forward)
        console.log("[Dotti] Step 5: submit");
        const clickResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                for (const btn of document.querySelectorAll("button")) {
                    if (btn.offsetParent === null) continue;
                    const icon = btn.querySelector("i");
                    if (icon?.textContent?.trim() === "arrow_forward") {
                        console.log("[Dotti DOM] Submit btn found");
                        btn.click();
                        return true;
                    }
                }
                console.log("[Dotti DOM] Submit button NOT FOUND");
                return false;
            }
        });
        if (!clickResult?.[0]?.result) return { success: false, error: "submit_failed" };

        // Esperar confirmacao (textbox voltou ao placeholder ou botao desabilitado)
        const submitted = await waitForCondition(targetTabId, function() {
            const ta = document.querySelector("[role='textbox']");
            if (!ta) return true;
            const text = ta.textContent || "";
            // Textbox vazio ou so tem placeholder = submit confirmado
            if (text.includes("O que voc") && text.length < 40) return true;
            if (text.trim().length === 0) return true;
            for (const btn of document.querySelectorAll("button")) {
                const icon = btn.querySelector("i");
                if (icon?.textContent?.trim() === "arrow_forward" && btn.disabled) return true;
            }
            return false;
        }, [], 10000, 500);

        if (!submitted) {
            console.log("[Dotti] Submit not confirmed, retrying...");
            await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                world: "MAIN",
                func: () => {
                    for (const btn of document.querySelectorAll("button")) {
                        if (btn.offsetParent === null) continue;
                        if (btn.querySelector("i")?.textContent?.trim() === "arrow_forward") {
                            btn.click();
                            return true;
                        }
                    }
                }
            });
            // Verificar novamente apos retry
            const retryConfirmed = await waitForCondition(targetTabId, function() {
                const ta = document.querySelector("[role='textbox']");
                if (!ta) return true;
                const text = ta.textContent || "";
                if (text.includes("O que voc") && text.length < 40) return true;
                if (text.trim().length === 0) return true;
                for (const btn of document.querySelectorAll("button")) {
                    const icon = btn.querySelector("i");
                    if (icon?.textContent?.trim() === "arrow_forward" && btn.disabled) return true;
                }
                return false;
            }, [], 5000, 500);
            if (!retryConfirmed) {
                console.log("[Dotti] Submit FAILED after retry for prompt", prompt.number);
                return { success: false, error: "submit_not_confirmed" };
            }
        }

        console.log("[Dotti] Prompt", prompt.number, "OK");
        return { success: true };
    } catch (e) {
        console.error("[Dotti] Execute error:", e.message);
        return { success: false, error: e.message };
    }
}

// ============================================
// STATUS OVERLAY
// ============================================
async function injectStatusOverlay() {
    if (!targetTabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (iconUrl, mW, mH) => {
                document.getElementById("dotti-status-overlay")?.remove();
                let link = document.querySelector("link[rel*='icon']");
                if (!link) {
                    link = document.createElement('link');
                    link.rel = 'icon';
                    document.head.appendChild(link);
                }
                link.href = iconUrl;
                document.title = "LetzFlow Sender";
                if (window.innerWidth > mW + 100 || window.innerHeight > mH + 100) return;
                // Esconder sidebar e botao toggle na mini window
                const sidebar = document.getElementById("dotti-sender-full-panel");
                if (sidebar) sidebar.style.display = "none";
                const toggleBtn = document.getElementById("dotti-sender-toggle-btn");
                if (toggleBtn) toggleBtn.style.display = "none";
                // Remover classe que limita max-width do body
                document.documentElement.classList.remove("dotti-sidebar-open");
                const o = document.createElement("div");
                o.id = "dotti-status-overlay";
                o.innerHTML = `<style>#dotti-status-overlay{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;margin:0!important;padding:20px!important;box-sizing:border-box!important;background:linear-gradient(135deg,#1a1a2e,#16213e)!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;font-family:'Segoe UI',Arial,sans-serif!important;color:#fff!important;pointer-events:none!important;transform:none!important;contain:none!important}#dotti-status-overlay .logo{font-size:48px!important;margin-bottom:15px!important}#dotti-status-overlay .title{font-size:22px!important;font-weight:700!important;margin-bottom:8px!important;background:linear-gradient(90deg,#00d4ff,#7b2cbf)!important;-webkit-background-clip:text!important;-webkit-text-fill-color:transparent!important}#dotti-status-overlay .status{font-size:14px!important;color:#a0a0a0!important;margin-bottom:20px!important}#dotti-status-overlay .pbar{width:80%!important;height:6px!important;background:#2a2a4a!important;border-radius:3px!important;overflow:hidden!important;margin-bottom:15px!important}#dotti-status-overlay .pfill{height:100%!important;background:linear-gradient(90deg,#00d4ff,#7b2cbf)!important;border-radius:3px!important;transition:width .3s!important;width:0}#dotti-status-overlay .count{font-size:36px!important;font-weight:700!important;color:#00d4ff!important}#dotti-status-overlay .label{font-size:12px!important;color:#666!important;margin-top:5px!important}</style><div class="logo">⚡</div><div class="title">LETZFLOW SENDER</div><div class="status" id="dso-status">Preparando...</div><div class="pbar"><div class="pfill" id="dso-progress"></div></div><div class="count" id="dso-count">0/0</div><div class="label">prompts enviados</div>`;
                document.documentElement.appendChild(o);
            },
            args: [chrome.runtime.getURL("icons/icon128.png"), WINDOW_SIZES.mini.width, WINDOW_SIZES.mini.height]
        });
    } catch (e) {}
}

async function updateStatusOverlay(status, current, total) {
    if (!targetTabId || !isWindowMini) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: (s, c, t) => {
                const st = document.getElementById("dso-status");
                const pr = document.getElementById("dso-progress");
                const ct = document.getElementById("dso-count");
                if (st) st.textContent = s;
                if (ct) ct.textContent = c + "/" + t;
                if (pr) pr.style.width = (t > 0 ? (c / t) * 100 : 0) + "%";
            },
            args: [status, current, total]
        });
    } catch (e) {}
}

async function removeStatusOverlay() {
    if (!targetTabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                document.getElementById("dotti-status-overlay")?.remove();
                // Restaurar sidebar e botao toggle
                const sidebar = document.getElementById("dotti-sender-full-panel");
                if (sidebar) sidebar.style.display = "";
                const toggleBtn = document.getElementById("dotti-sender-toggle-btn");
                if (toggleBtn) toggleBtn.style.display = "";
                // Restaurar classe que controla layout do body
                document.documentElement.classList.add("dotti-sidebar-open");
            }
        });
    } catch (e) {
        console.log("[Dotti] removeStatusOverlay error:", e.message);
    }
}

// Garantir que pagina esta restaurada apos remover overlay
async function restorePageAfterOverlay() {
    if (!targetTabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            world: "MAIN",
            func: () => {
                // Verificar se overlay ainda existe e remover forçadamente
                const overlay = document.getElementById("dotti-status-overlay");
                if (overlay) {
                    console.log("[Dotti DOM] Overlay ainda presente - removendo forcadamente");
                    overlay.remove();
                }
                // Restaurar visibilidade dos elementos
                const sidebar = document.getElementById("dotti-sender-full-panel");
                if (sidebar) sidebar.style.display = "";
                const toggleBtn = document.getElementById("dotti-sender-toggle-btn");
                if (toggleBtn) toggleBtn.style.display = "";
                document.documentElement.classList.add("dotti-sidebar-open");
            }
        });
    } catch (e) {
        console.log("[Dotti] restorePageAfterOverlay error:", e.message);
    }
}

// ============================================
// QUEUE PROCESSING - v2.0.0 COM RETRY MELHORADO
// ============================================
async function processNextPrompt() {
    console.log("[Dotti] processNextPrompt called, queue:", promptQueue.length, "paused:", queuePaused, "processing:", isProcessingQueue);
    if (promptQueue.length === 0 || queuePaused) {
        if (promptQueue.length === 0 && isProcessingQueue && totalProcessed > 0) {
            isProcessingQueue = false;
            setBadgeStatus("active");
            await saveQueueState(); // v2.0.0: salvar estado final com processedPrompts
            await sleep(3000);
            await removeStatusOverlay();
            if (veoWindowId) {
                try {
                    await chrome.windows.update(veoWindowId, {
                        state: "maximized",
                        focused: true
                    });
                    isWindowMini = false;
                } catch (e) {}
            }
            notifyTab({ action: "QUEUE_COMPLETE", data: { total: totalProcessed } });
        }
        return;
    }

    isProcessingQueue = true;
    setBadgeStatus("processing");
    lastActivityTime = Date.now();

    const prompt = promptQueue[0];
    const totalInQueue = totalProcessed + promptQueue.length;

    await updateStatusOverlay("Enviando PROMPT " + prompt.number + "...", totalProcessed, totalInQueue);

    // v2.1.0: Limpar galeria/elementos antes de cada prompt
    try {
        await chrome.tabs.sendMessage(targetTabId, { action: "PREPARE_FOR_NEXT_PROMPT" });
        await sleep(800);
    } catch (e) {}

    notifyTab({ action: "PROMPT_STARTING", data: prompt });

    const result = await executePromptInTab(prompt, queueMediaType);
    console.log("[Dotti] Prompt", prompt.number, "result:", JSON.stringify(result));

    // v2.0.0: Se janela fechada, parar fila inteira
    if (!result.success && result.error === "window_closed") {
        isProcessingQueue = false;
        queuePaused = true;
        setBadgeStatus("active");
        notifyTab({ action: "QUEUE_ERROR", data: { message: "Janela do Veo foi fechada" } });
        await saveQueueState();
        return;
    }

    // v2.0.0: Retry melhorado - maximo 3 tentativas com delay extra
    if (!result.success && (prompt.retryCount || 0) < 3) {
        prompt.retryCount = (prompt.retryCount || 0) + 1;
        console.log("[Dotti] Retry", prompt.retryCount, "for prompt", prompt.number, "error:", result.error);
        // Manter prompt na frente da fila para retry imediato
        await saveQueueState();
        await sleep(3000); // v2.0.0: delay extra antes de retry
        await processNextPrompt();
        return;
    }

    // Registrar resultado
    prompt.status = result.success ? "sent" : "error";
    if (!result.success) prompt.error = result.error;
    notifyTab({ action: "PROMPT_RESULT", data: { ...prompt, result } });

    // v2.1.0: Log persistente de resultados para precisao do reenvio
    logPromptResult(prompt, queueMediaType);

    // v2.0.0: Mover para processedPrompts
    promptQueue.shift();
    processedPrompts.push({ ...prompt });
    currentBatchCount++;
    totalProcessed++;
    lastActivityTime = Date.now();

    await updateStatusOverlay("PROMPT " + prompt.number + " enviado!", totalProcessed, totalInQueue);
    await saveQueueState();

    // v2.0.2: Capturar tile ID do prompt recem-enviado
    if (result.success && targetTabId) {
        try {
            let newTileId = null;
            for (let attempt = 0; attempt < 5 && !newTileId; attempt++) {
                if (attempt > 0) await sleep(1000);
                const tilesResult = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    func: () => {
                        return Array.from(document.querySelectorAll('[data-tile-id]'))
                            .map(el => el.getAttribute('data-tile-id'));
                    }
                });
                const currentTiles = tilesResult?.[0]?.result || [];
                newTileId = currentTiles.find(id => !_knownTileIds.has(id));
            }
            if (newTileId) {
                _tileToPromptMap[newTileId] = prompt.number;
                _knownTileIds.add(newTileId);
                console.log("[Dotti] TILE MAPPED:", newTileId, "-> PROMPT", prompt.number);
            } else {
                console.log("[Dotti] WARNING: No new tile found for PROMPT", prompt.number);
            }
        } catch (e) {}
    }

    if (promptQueue.length > 0 && !queuePaused) {
        let delay = queueSettings.promptDelay;
        if (currentBatchCount >= queueSettings.batchSize) {
            // Video: 180s minimo entre lotes / Imagem: 90s minimo
            const batchDelay = queueMediaType === "video"
                ? Math.max(queueSettings.batchInterval, 180000)
                : Math.max(queueSettings.batchInterval, 90000);
            await updateStatusOverlay("Aguardando proximo lote...", totalProcessed, totalInQueue);
            notifyTab({
                action: "BATCH_PAUSE",
                data: { remaining: promptQueue.length, interval: batchDelay }
            });
            delay = batchDelay;
            currentBatchCount = 0;
        }
        chrome.alarms.create("dottiNextPrompt", { when: Date.now() + delay });
    } else if (promptQueue.length === 0 && totalProcessed > 0) {
        isProcessingQueue = false;
        setBadgeStatus("active");
        await saveQueueState();
        await sleep(3000);
        await removeStatusOverlay();
        if (veoWindowId) {
            try {
                await chrome.windows.update(veoWindowId, {
                    state: "maximized",
                    focused: true
                });
                isWindowMini = false;
            } catch (e) {}
        }
        notifyTab({ action: "QUEUE_COMPLETE", data: { total: totalProcessed } });
    }
}

async function startQueue(prompts, settings, tabId, mediaType, bgMode) {
    if (!tabId && targetTabId) tabId = targetTabId;
    if (!tabId) return { success: false, error: "no_tab" };

    promptQueue = [...prompts];
    processedPrompts = [];
    queueSettings = {
        promptDelay: (settings.promptDelay || 3) * 1000,
        batchSize: settings.batchSize || 20,
        batchInterval: (settings.batchInterval || 90) * 1000,
        outputCount: settings.outputCount || 1
    };
    currentBatchCount = 0;
    queuePaused = false;
    targetTabId = tabId;
    totalProcessed = 0;
    firstPromptOfBatch = true;
    isProcessingQueue = true;
    lastActivityTime = Date.now();
    queueMediaType = mediaType || "video";

    setBadgeStatus("processing");
    await saveQueueState();

    let winId = null;
    try {
        const tab = await chrome.tabs.get(targetTabId);
        winId = tab.windowId;
        veoWindowId = winId;
    } catch (e) {
        winId = veoWindowId;
    }
    const useBackground = bgMode !== false; // default true
    if (winId && useBackground) {
        try {
            const wi = await chrome.windows.get(winId);
            if (wi.state === "maximized" || wi.state === "fullscreen") {
                await chrome.windows.update(winId, { state: "normal" });
            }
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(winId, {
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            isWindowMini = true;
            await chrome.storage.local.set({ isWindowMini: true, veoWindowId: winId });
        } catch (e) {}

        await injectStatusOverlay();
        await updateStatusOverlay("Iniciando...", 0, promptQueue.length);
    } else if (winId) {
        try {
            veoWindowId = winId;
            await chrome.storage.local.set({ veoWindowId: winId });
        } catch (e) {}
    }
    await sleep(2000);

    // v2.0.2: Escanear tiles existentes antes de comecar (para saber quais sao novos)
    _tileToPromptMap = {};
    _knownTileIds = new Set();
    try {
        const tilesResult = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: () => {
                return Array.from(document.querySelectorAll('[data-tile-id]'))
                    .map(el => el.getAttribute('data-tile-id'));
            }
        });
        if (tilesResult?.[0]?.result) {
            for (const id of tilesResult[0].result) _knownTileIds.add(id);
        }
        console.log("[Dotti] Initial tiles:", _knownTileIds.size);
    } catch (e) {}

    console.log("[Dotti] startQueue: launching processNextPrompt, queue:", promptQueue.length);
    processNextPrompt().catch(e => console.error("[Dotti] processNextPrompt error:", e));
    return { success: true };
}

async function pauseQueue() {
    queuePaused = true;
    isProcessingQueue = false;
    chrome.alarms.clear("dottiNextPrompt");
    await saveQueueState();
    await updateStatusOverlay("Pausado", totalProcessed, totalProcessed + promptQueue.length);
    setBadgeStatus("active");
}

async function resumeQueue() {
    queuePaused = false;
    isProcessingQueue = true;
    lastActivityTime = Date.now();
    firstPromptOfBatch = true;
    await saveQueueState();

    let winId = null;
    try {
        const tab = await chrome.tabs.get(targetTabId);
        winId = tab.windowId;
        veoWindowId = winId;
    } catch (e) {
        winId = veoWindowId;
    }
    if (winId) {
        try {
            const wi = await chrome.windows.get(winId);
            if (wi.state === "maximized" || wi.state === "fullscreen") {
                await chrome.windows.update(winId, { state: "normal" });
            }
            const size = WINDOW_SIZES.mini;
            const displays = await chrome.system.display.getInfo();
            const pd = displays[0];
            await chrome.windows.update(winId, {
                width: size.width,
                height: size.height,
                left: pd.workArea.width - size.width - 20,
                top: pd.workArea.height - size.height - 20
            });
            isWindowMini = true;
        } catch (e) {}
    }
    await injectStatusOverlay();
    await updateStatusOverlay("Retomando...", totalProcessed, totalProcessed + promptQueue.length);
    await sleep(1000);
    processNextPrompt();
    return { success: true };
}

async function cancelQueue() {
    queuePaused = true;
    isProcessingQueue = false;
    chrome.alarms.clear("dottiNextPrompt");
    await clearQueueState();
    await removeStatusOverlay();
    setBadgeStatus("active");
}

// v2.1.0: Reset completo - limpa fila, tracked downloads, pending downloads, e log
async function fullReset() {
    await cancelQueue();
    trackedDownloads = {};
    pendingUpscaleDownloads = {};
    await chrome.storage.local.remove([
        'dottiTrackedDownloads', 'dottiPendingDownloads', 'dottiPromptLog'
    ]);
    console.log("[Dotti] Full reset completo - cache e log limpos");
}

// v2.1.0: Log persistente de prompts para reenvio preciso
async function logPromptResult(prompt, mediaType) {
    try {
        const data = await chrome.storage.local.get('dottiPromptLog');
        const log = data.dottiPromptLog || [];
        log.push({
            number: prompt.number,
            text: (prompt.text || "").substring(0, 100),
            elements: prompt.elements || [],
            status: prompt.status,
            error: prompt.error || null,
            mediaType: mediaType,
            timestamp: Date.now()
        });
        // Manter apenas os ultimos 500 registros
        if (log.length > 500) log.splice(0, log.length - 500);
        await chrome.storage.local.set({ dottiPromptLog: log });
    } catch (e) {
        console.log("[Dotti] Erro ao salvar log:", e.message);
    }
}

// v2.1.0: Atualizar log quando media e detectada (gerada/downloaded)
async function updatePromptLog(promptNumber, mediaType, mediaStatus) {
    try {
        const data = await chrome.storage.local.get('dottiPromptLog');
        const log = data.dottiPromptLog || [];
        // Encontrar o registro mais recente deste prompt
        for (let i = log.length - 1; i >= 0; i--) {
            if (log[i].number === promptNumber && log[i].mediaType === mediaType) {
                log[i].mediaStatus = mediaStatus;
                log[i].lastUpdate = Date.now();
                break;
            }
        }
        await chrome.storage.local.set({ dottiPromptLog: log });
    } catch (e) {}
}

// ============================================
// v2.0.1: VIDEO NETWORK INTERCEPTION (webRequest API)
// Captura TODOS os videos carregados pela pagina no nivel de REDE
// Independente do DOM - funciona com virtual scrolling
// ============================================
const _interceptedVideoUrls = new Set();

// v2.0.2: Tile tracking - mapeia data-tile-id do Flow ao numero do prompt
let _tileToPromptMap = {};
let _knownTileIds = new Set();

chrome.webRequest.onCompleted.addListener(
    (details) => {
        const url = details.url;
        if (_interceptedVideoUrls.has(url)) return;

        // So de paginas do Flow
        if (details.initiator && !details.initiator.includes("labs.google")) return;

        // So respostas bem-sucedidas (200 ou 206 partial content para range requests)
        if (details.statusCode !== 200 && details.statusCode !== 206) return;

        // Verificar Content-Type dos response headers
        let contentType = "";
        if (details.responseHeaders) {
            const ct = details.responseHeaders.find(h => h.name.toLowerCase() === "content-type");
            if (ct) contentType = (ct.value || "").toLowerCase();
        }

        // Rejeitar explicitamente tipos nao-video conhecidos
        if (contentType && (
            contentType.includes("json") ||
            contentType.includes("html") ||
            contentType.includes("xml") ||
            contentType.includes("javascript") ||
            contentType.includes("css") ||
            contentType.includes("image/") ||
            contentType.includes("text/") ||
            contentType.includes("manifest") ||
            contentType.includes("font")
        )) return;

        // Aceitar se: tipo "media" COM content-type video, OU content-type video/*, OU URL indica video
        const isVideo = (details.type === "media" && (!contentType || contentType.startsWith("video/"))) ||
                        contentType.startsWith("video/") ||
                        url.includes(".mp4") || url.includes(".webm") ||
                        url.includes("mime=video");

        if (!isVideo) return;

        _interceptedVideoUrls.add(url);
        console.log("[Dotti] webRequest video interceptado:", url.substring(0, 150),
            "type:", details.type, "contentType:", contentType, "tab:", details.tabId);

        // v2.0.1: Notificar content script - webRequest e a UNICA fonte de VIDEO_DETECTED.
        // URLs de storage.googleapis.com contem UUID unico = dedup perfeito.
        if (details.tabId > 0) {
            chrome.tabs.sendMessage(details.tabId, {
                action: "VIDEO_URL_INTERCEPTED",
                data: {
                    url: url,
                    timestamp: details.timeStamp,
                    contentType: contentType
                }
            }).catch(() => {});
        }
    },
    {
        urls: [
            "https://*.googleapis.com/*",
            "https://*.googleusercontent.com/*",
            "https://labs.google/*"
        ],
        types: ["media", "xmlhttprequest", "other"]
    },
    ["responseHeaders"]
);

// ============================================
// v2.0.0: DOWNLOAD FILENAME INTERCEPTOR
// Usa onDeterminingFilename para redirecionar downloads do Flow
// para pasta personalizada com nome customizado.
// IMPORTANTE: trackedDownloads e persistido no chrome.storage.local
// porque o service worker MV3 pode dormir entre o inicio do download
// e a conclusao (upscale 1080p leva 30-60s).
// ============================================
let trackedDownloads = {}; // { downloadId: { promptNumber, type, resolution } }
let _ownDownloadFilenames = {}; // { downloadId: filename } - mapa por ID do download (nao por URL!)

// Persistir trackedDownloads no storage (sobrevive ao service worker dormindo)
function saveTrackedDownloads() {
    chrome.storage.local.set({ dottiTrackedDownloads: trackedDownloads });
}

// Carregar trackedDownloads do storage (quando service worker acorda)
async function loadTrackedDownloads() {
    const data = await chrome.storage.local.get('dottiTrackedDownloads');
    if (data.dottiTrackedDownloads) {
        trackedDownloads = data.dottiTrackedDownloads;
    }
}

// v2.0.1: Verificar se URL/MIME e de midia do Google Flow (mais restrito)
function isFlowMediaDownload(url, mime) {
    // v2.0.1: Apenas URLs especificas do Flow (removido google.com/ generico)
    const isFlowUrl = url.includes("storage.googleapis.com") ||
                      url.includes("googleusercontent.com") ||
                      url.includes("labs.google");
    const isLabsBlob = url.startsWith("blob:https://labs.google");
    // Precisa ser URL do Flow E ter MIME de midia
    const isMediaMime = mime && (
        mime.startsWith("video/") ||
        mime.startsWith("image/") ||
        mime.includes("mp4") || mime.includes("webm") || mime.includes("gif")
    );
    return isLabsBlob || (isFlowUrl && isMediaMime);
}

// Helper: encontrar o pendente mais antigo
function findOldestPending() {
    const now = Date.now();
    for (const key of Object.keys(pendingUpscaleDownloads)) {
        if (now - pendingUpscaleDownloads[key].timestamp > 600000) { // 10 min (era 5 min)
            delete pendingUpscaleDownloads[key];
        }
    }
    let matchKey = null;
    let matchPending = null;
    let oldestTime = Infinity;
    for (const key of Object.keys(pendingUpscaleDownloads)) {
        const p = pendingUpscaleDownloads[key];
        if (p.timestamp < oldestTime) {
            oldestTime = p.timestamp;
            matchKey = key;
            matchPending = p;
        }
    }
    return { matchKey, matchPending };
}

// Helper: construir filename customizado
function buildCustomFilename(pending, downloadItem) {
    const folder = pending.folder || "LetzVideos";
    const promptNum = pending.promptNumber || 0;
    const resolution = pending.resolution || "1080p";
    const type = pending.type || "video";

    let extension = type === "image" ? "png" : "mp4";
    if (downloadItem?.mime) {
        if (downloadItem.mime.includes("webm")) extension = "webm";
        else if (downloadItem.mime.includes("gif")) extension = "gif";
        else if (downloadItem.mime.includes("png")) extension = "png";
        else if (downloadItem.mime.includes("jpeg") || downloadItem.mime.includes("jpg")) extension = "jpg";
        else if (downloadItem.mime.includes("webp")) extension = "webp";
    }
    const origFilename = downloadItem?.filename || "";
    const origExt = origFilename.split(".").pop()?.toLowerCase();
    if (origExt && ["mp4", "webm", "gif", "png", "jpg", "jpeg", "webp"].includes(origExt)) {
        extension = origExt;
    }

    let promptSlug = (pending.promptText || "")
        .substring(0, 50)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/\s+/g, "_")
        .trim();
    if (!promptSlug) promptSlug = "prompt";

    return folder + "/PROMPT_" + String(promptNum).padStart(3, "0") + "_" + resolution + "_" + promptSlug + "." + extension;
}

// PRINCIPAL: Redirecionar nome/pasta de downloads do Flow
// Usa suggest assincrono (return true) para carregar pending do storage primeiro
chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    const url = downloadItem.url || "";
    const mime = downloadItem.mime || "";
    const isOwnDownload = downloadItem.byExtensionId === chrome.runtime.id;

    // v2.0.1: Downloads da PROPRIA extensao (DOWNLOAD_VIDEO/DOWNLOAD_IMAGE)
    // Usar filename armazenado pelo download ID (nao URL - URLs podem ser iguais)
    if (isOwnDownload) {
        const dlId = downloadItem.id;
        const storedFilename = _ownDownloadFilenames[dlId];
        if (storedFilename) {
            delete _ownDownloadFilenames[dlId];
            console.log("[Dotti] onDeterminingFilename OWN id:" + dlId + " - usando filename:", storedFilename);
            suggest({ filename: storedFilename, conflictAction: "uniquify" });
        } else {
            console.log("[Dotti] onDeterminingFilename OWN id:" + dlId + " - sem filename, url:", url.substring(0, 80));
            suggest();
        }
        return;
    }

    // Para downloads que NAO sao midia do Flow, ignorar
    if (!isFlowMediaDownload(url, mime)) {
        suggest();
        return;
    }

    // So chega aqui para downloads do BROWSER (upscale via UI do Flow)
    // Esses precisam ser interceptados e renomeados via pending entries
    (async () => {
        try {
            await _bootPromise;
            await loadPendingDownloads();

            if (Object.keys(pendingUpscaleDownloads).length === 0) {
                suggest();
                return;
            }

            const { matchKey, matchPending } = findOldestPending();
            if (!matchPending) {
                suggest();
                return;
            }

            const customFilename = buildCustomFilename(matchPending, downloadItem);
            console.log("[Dotti] Redirecionando download upscale para:", customFilename);

            trackedDownloads[downloadItem.id] = {
                promptNumber: matchPending.promptNumber,
                type: matchPending.type,
                resolution: matchPending.resolution
            };
            delete pendingUpscaleDownloads[matchKey];
            saveTrackedDownloads();
            savePendingDownloads();

            suggest({
                filename: customFilename,
                conflictAction: "uniquify"
            });
        } catch (e) {
            console.error("[Dotti] Erro no onDeterminingFilename:", e);
            suggest();
        }
    })();

    return true;
});

// Detectar quando download termina para contabilizar
// IMPORTANTE: O service worker MV3 pode ter dormido e reiniciado.
// Todas as variaveis em memoria (trackedDownloads, targetTabId) podem estar vazias.
// Por isso carregamos TUDO do storage antes de processar.
chrome.downloads.onChanged.addListener(async (delta) => {
    if (!delta.state) return;

    // 1. Garantir boot + carregar trackedDownloads do storage
    await _bootPromise;
    await loadTrackedDownloads();

    const tracked = trackedDownloads[delta.id];
    if (!tracked) return;

    if (delta.state.current === "complete") {
        console.log("[Dotti] Download complete for PROMPT", tracked.promptNumber);

        // 2. Recuperar targetTabId do storage (pode estar null em memoria)
        if (!targetTabId) {
            const data = await chrome.storage.local.get(['veoTabId']);
            if (data.veoTabId) targetTabId = data.veoTabId;
        }

        // 3. Se ainda nao tem tab, buscar a tab do labs.google
        if (!targetTabId) {
            try {
                const tabs = await chrome.tabs.query({ url: "https://labs.google/*" });
                if (tabs.length > 0) targetTabId = tabs[0].id;
            } catch (e) {}
        }

        // 4. Notificar a tab
        if (targetTabId) {
            try {
                await chrome.tabs.sendMessage(targetTabId, {
                    action: "DOWNLOAD_INTERCEPTED",
                    data: {
                        promptNumber: tracked.promptNumber,
                        type: tracked.type,
                        resolution: tracked.resolution
                    }
                });
                console.log("[Dotti] Tab notificada com sucesso para PROMPT", tracked.promptNumber);
            } catch (e) {
                console.log("[Dotti] Falha ao notificar tab:", e.message);
                // Tab pode ter mudado - tentar encontrar novamente
                try {
                    const tabs = await chrome.tabs.query({ url: "https://labs.google/*" });
                    if (tabs.length > 0) {
                        targetTabId = tabs[0].id;
                        await chrome.tabs.sendMessage(targetTabId, {
                            action: "DOWNLOAD_INTERCEPTED",
                            data: {
                                promptNumber: tracked.promptNumber,
                                type: tracked.type,
                                resolution: tracked.resolution
                            }
                        });
                        console.log("[Dotti] Tab notificada (retry) para PROMPT", tracked.promptNumber);
                    }
                } catch (e2) {
                    console.log("[Dotti] Retry tambem falhou:", e2.message);
                }
            }
        } else {
            console.log("[Dotti] Nenhuma tab encontrada para notificar PROMPT", tracked.promptNumber);
        }

        delete trackedDownloads[delta.id];
        saveTrackedDownloads();
    } else if (delta.state.current === "interrupted") {
        console.log("[Dotti] Download failed for PROMPT", tracked.promptNumber);
        delete trackedDownloads[delta.id];
        saveTrackedDownloads();
    }
});

// ============================================
// ALARMS - v2.1.0 COM BOOT GATE + WATCHDOG
// ============================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
    await _bootPromise; // Garantir que estado foi carregado do storage

    if (alarm.name === "dottiKeepAlive") {
        // v2.1.0: Manter service worker vivo - verificar se precisa retomar fila
        if (isProcessingQueue && !queuePaused && promptQueue.length > 0) {
            lastActivityTime = Date.now();
        }
    } else if (alarm.name === "dottiNextPrompt") {
        processNextPrompt();
    } else if (alarm.name === "dottiWatchdog") {
        // v2.1.0: Watchdog - detecta fila travada e retoma automaticamente
        if (isProcessingQueue && !queuePaused && promptQueue.length > 0) {
            const timeSinceLastActivity = Date.now() - lastActivityTime;
            if (timeSinceLastActivity > 3 * 60 * 1000) { // 3 minutos sem atividade
                console.log("[Dotti] Watchdog: Queue stuck for", Math.round(timeSinceLastActivity / 1000), "s. Retrying...");
                firstPromptOfBatch = true;
                lastActivityTime = Date.now();
                processNextPrompt().catch(e => console.error("[Dotti] Watchdog stuck retry error:", e));
            }
        }
        // v2.1.0: Detectar fila que deveria estar rodando mas parou (service worker reiniciou)
        if (!isProcessingQueue && !queuePaused && promptQueue.length > 0 && totalProcessed > 0) {
            console.log("[Dotti] Watchdog: Queue has", promptQueue.length, "pending but not processing. Resuming...");
            isProcessingQueue = true;
            firstPromptOfBatch = true;
            setBadgeStatus("processing");
            lastActivityTime = Date.now();
            processNextPrompt().catch(e => console.error("[Dotti] Watchdog resume error:", e));
        }
    }
});

chrome.alarms.create("dottiKeepAlive", { periodInMinutes: 0.3 }); // 18s keep-alive
chrome.alarms.create("dottiWatchdog", { periodInMinutes: 0.33 }); // Watchdog a cada 20s

// ============================================
// MESSAGE HANDLER - v2.0.0 COM GET_FULL_STATE
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            await _bootPromise;
            switch (message.action) {
                case "GET_STATUS":
                    sendResponse({
                        isInitialized: true,
                        queueLength: promptQueue.length,
                        isProcessing: isProcessingQueue,
                        isPaused: queuePaused,
                        hasVeoWindow: !!veoWindowId,
                        isWindowMini
                    });
                    break;

                case "GET_FULL_STATE":
                    sendResponse({
                        isProcessing: isProcessingQueue,
                        isPaused: queuePaused,
                        promptQueue: promptQueue,
                        processedPrompts: processedPrompts,
                        totalProcessed: totalProcessed,
                        queueSettings: queueSettings,
                        lastActivity: lastActivityTime,
                        hasVeoWindow: !!veoWindowId,
                        isWindowMini: isWindowMini,
                        mediaType: queueMediaType
                    });
                    break;

                case "OPEN_VEO_WINDOW":
                    const win = await openVeoWindow(message.mini !== false);
                    sendResponse({ success: true, windowId: win.id, tabId: targetTabId });
                    break;

                case "TOGGLE_WINDOW_SIZE":
                    sendResponse(await toggleWindowSize());
                    break;

                case "FOCUS_VEO_WINDOW":
                    await focusVeoWindow();
                    sendResponse({ success: true });
                    break;

                case "START_QUEUE":
                    sendResponse(await startQueue(message.prompts, message.settings, message.tabId || targetTabId, message.mediaType, message.backgroundMode));
                    break;

                case "PAUSE_QUEUE":
                    await pauseQueue();
                    sendResponse({ success: true });
                    break;

                case "RESUME_QUEUE":
                    sendResponse(await resumeQueue());
                    break;

                case "CANCEL_QUEUE":
                    await cancelQueue();
                    sendResponse({ success: true });
                    break;

                case "FULL_RESET":
                    await fullReset();
                    sendResponse({ success: true });
                    break;

                case "INJECT_FETCH_INTERCEPT":
                    (async () => {
                        try {
                            const tabId = sender.tab?.id;
                            if (!tabId) { sendResponse({ success: false }); return; }
                            const count = message.count || 1;
                            await chrome.scripting.executeScript({
                                target: { tabId },
                                world: "MAIN",
                                func: (desiredCount) => {
                                    // Evitar instalar mais de uma vez
                                    if (window.__dottiFetchInterceptInstalled) {
                                        window.__dottiOutputCount = desiredCount;
                                        console.log("[Dotti Inject] Output count atualizado para", desiredCount);
                                        return;
                                    }
                                    window.__dottiOutputCount = desiredCount;
                                    window.__dottiFetchInterceptInstalled = true;

                                    // Listener para atualizacoes futuras via custom event
                                    window.addEventListener('__dotti_set_output_count', (e) => {
                                        window.__dottiOutputCount = parseInt(e.detail?.count) || 1;
                                        console.log("[Dotti Inject] Output count via event:", window.__dottiOutputCount);
                                    });

                                    // Patch window.fetch
                                    const origFetch = window.fetch;
                                    window.fetch = async function(...args) {
                                        let [url, options] = args;
                                        const cnt = window.__dottiOutputCount;
                                        if (cnt > 1 && options?.body && typeof url === 'string' &&
                                            (url.includes('aisandbox-pa.googleapis.com') || url.includes('generativelanguage') || url.includes('labs.google'))) {
                                            try {
                                                const bodyStr = typeof options.body === 'string' ? options.body : null;
                                                if (bodyStr && bodyStr.startsWith('{')) {
                                                    const body = JSON.parse(bodyStr);
                                                    let modified = false;

                                                    // Busca recursiva por campos de contagem
                                                    function deepModify(obj) {
                                                        if (typeof obj !== 'object' || obj === null) return false;
                                                        let found = false;
                                                        for (const key of Object.keys(obj)) {
                                                            const kl = key.toLowerCase();
                                                            if (kl === 'samplecount' || kl === 'sample_count' ||
                                                                kl === 'candidatecount' || kl === 'candidate_count' ||
                                                                kl === 'numoutputs' || kl === 'num_outputs' ||
                                                                (kl === 'count' && typeof obj[key] === 'number')) {
                                                                obj[key] = cnt;
                                                                found = true;
                                                            }
                                                            if (typeof obj[key] === 'object') {
                                                                if (deepModify(obj[key])) found = true;
                                                            }
                                                        }
                                                        return found;
                                                    }

                                                    modified = deepModify(body);

                                                    // Se nao encontrou campo existente, adicionar em parameters
                                                    if (!modified && body.parameters) {
                                                        body.parameters.sampleCount = cnt;
                                                        modified = true;
                                                    }
                                                    // Ou adicionar campo count na raiz
                                                    if (!modified) {
                                                        body.sampleCount = cnt;
                                                        modified = true;
                                                    }

                                                    if (modified) {
                                                        options = Object.assign({}, options, { body: JSON.stringify(body) });
                                                        console.log("[Dotti Inject] Request modificado: sampleCount=" + cnt);
                                                    }
                                                }
                                            } catch (e) {
                                                // Body nao eh JSON, ignorar
                                            }
                                        }
                                        return origFetch.apply(this, [url, options]);
                                    };

                                    // Patch XMLHttpRequest.send
                                    const origXHRSend = XMLHttpRequest.prototype.send;
                                    XMLHttpRequest.prototype.send = function(body) {
                                        const cnt = window.__dottiOutputCount;
                                        if (cnt > 1 && body && typeof body === 'string' && body.startsWith('{')) {
                                            const url = this._dottiUrl || '';
                                            if (url.includes('aisandbox-pa.googleapis.com') || url.includes('generativelanguage') || url.includes('labs.google')) {
                                                try {
                                                    const parsed = JSON.parse(body);
                                                    let modified = false;
                                                    function deepModify(obj) {
                                                        if (typeof obj !== 'object' || obj === null) return false;
                                                        let found = false;
                                                        for (const key of Object.keys(obj)) {
                                                            const kl = key.toLowerCase();
                                                            if (kl === 'samplecount' || kl === 'sample_count' ||
                                                                kl === 'candidatecount' || kl === 'candidate_count' ||
                                                                (kl === 'count' && typeof obj[key] === 'number')) {
                                                                obj[key] = cnt;
                                                                found = true;
                                                            }
                                                            if (typeof obj[key] === 'object') {
                                                                if (deepModify(obj[key])) found = true;
                                                            }
                                                        }
                                                        return found;
                                                    }
                                                    modified = deepModify(parsed);
                                                    if (!modified) { parsed.sampleCount = cnt; }
                                                    body = JSON.stringify(parsed);
                                                    console.log("[Dotti Inject XHR] Request modificado: sampleCount=" + cnt);
                                                } catch (e) {}
                                            }
                                        }
                                        return origXHRSend.call(this, body);
                                    };

                                    // Capturar URL do XHR
                                    const origXHROpen = XMLHttpRequest.prototype.open;
                                    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                                        this._dottiUrl = url;
                                        return origXHROpen.call(this, method, url, ...rest);
                                    };

                                    console.log("[Dotti Inject] Fetch/XHR intercept instalado, count=" + desiredCount);
                                },
                                args: [count]
                            });
                            sendResponse({ success: true });
                        } catch (e) {
                            console.log("[Dotti] Inject fetch intercept error:", e.message);
                            sendResponse({ success: false, error: e.message });
                        }
                    })();
                    return true;

                case "GET_PROMPT_LOG":
                    chrome.storage.local.get('dottiPromptLog', (data) => {
                        sendResponse({ log: data.dottiPromptLog || [] });
                    });
                    return true;

                case "UPDATE_PROMPT_LOG":
                    updatePromptLog(message.promptNumber, message.mediaType, message.mediaStatus);
                    sendResponse({ success: true });
                    break;

                case "MINIMIZE_WINDOW":
                    try {
                        const fw = await chrome.windows.getLastFocused();
                        if (fw.state === "maximized" || fw.state === "fullscreen") {
                            await chrome.windows.update(fw.id, { state: "normal" });
                        }
                        const size = WINDOW_SIZES.mini;
                        const displays = await chrome.system.display.getInfo();
                        const pd = displays[0];
                        await chrome.windows.update(fw.id, {
                            width: size.width,
                            height: size.height,
                            left: pd.workArea.width - size.width - 20,
                            top: pd.workArea.height - size.height - 20
                        });
                        isWindowMini = true;
                        veoWindowId = fw.id;
                        sendResponse({ success: true });
                    } catch (e) {
                        sendResponse({ success: false, error: e.message });
                    }
                    break;

                case "GET_QUEUE_STATUS":
                    sendResponse({
                        queueLength: promptQueue.length,
                        isProcessing: isProcessingQueue,
                        isPaused: queuePaused,
                        currentBatch: currentBatchCount,
                        settings: queueSettings,
                        totalProcessed: totalProcessed
                    });
                    break;

                // v2.0.1: Registrar download pendente de upscale (video ou imagem)
                // So para upscale via UI do Flow (NAO para downloads diretos)
                case "REGISTER_UPSCALE_DOWNLOAD":
                    const regId = String(message.promptNumber || Date.now());
                    // v2.0.1: Se ja existe entry para esse prompt, nao duplicar
                    if (pendingUpscaleDownloads[regId]) {
                        console.log("[Dotti] Pending entry ja existe para prompt", regId, "- ignorando duplicata");
                        sendResponse({ success: true, registeredId: regId, duplicate: true });
                        break;
                    }
                    pendingUpscaleDownloads[regId] = {
                        promptNumber: message.promptNumber,
                        promptText: message.promptText || "",
                        folder: message.folder || "LetzVideos",
                        resolution: message.resolution || "1080p",
                        type: message.downloadType || "video",
                        timestamp: Date.now()
                    };
                    savePendingDownloads();
                    console.log("[Dotti] Registered pending upscale download:", regId);
                    sendResponse({ success: true, registeredId: regId });
                    break;

                case "DOWNLOAD_VIDEO":
                    if (!message.url || !message.filename) {
                        console.log("[Dotti] DOWNLOAD_VIDEO rejeitado - missing params");
                        sendResponse({ success: false, error: "missing_params" });
                        return true;
                    }
                    console.log("[Dotti] DOWNLOAD_VIDEO iniciando:", message.filename);
                    chrome.downloads.download({
                        url: message.url,
                        filename: message.filename,
                        saveAs: false
                    }, (id) => {
                        if (chrome.runtime.lastError) {
                            console.log("[Dotti] DOWNLOAD_VIDEO erro:", chrome.runtime.lastError.message);
                            sendResponse({ success: false, error: chrome.runtime.lastError.message });
                        } else {
                            // Armazenar filename pelo ID do download (nao URL!)
                            _ownDownloadFilenames[id] = message.filename;
                            console.log("[Dotti] DOWNLOAD_VIDEO ok, id:", id, "filename:", message.filename);
                            const pMatch = message.filename.match(/(\d+)_PROMPT_/);
                            if (pMatch) {
                                trackedDownloads[id] = {
                                    promptNumber: parseInt(pMatch[1]),
                                    type: "video",
                                    resolution: "720p"
                                };
                                saveTrackedDownloads();
                            }
                            sendResponse({ success: true, downloadId: id });
                        }
                    });
                    return true;

                // v2.0.0: Download de imagem
                case "DOWNLOAD_IMAGE":
                    if (!message.url || !message.filename) {
                        console.log("[Dotti] DOWNLOAD_IMAGE rejeitado - missing params");
                        sendResponse({ success: false, error: "missing_params" });
                        return true;
                    }
                    console.log("[Dotti] DOWNLOAD_IMAGE iniciando:", message.filename);
                    chrome.downloads.download({
                        url: message.url,
                        filename: message.filename,
                        saveAs: false
                    }, (id) => {
                        if (chrome.runtime.lastError) {
                            console.log("[Dotti] DOWNLOAD_IMAGE erro:", chrome.runtime.lastError.message);
                            sendResponse({ success: false, error: chrome.runtime.lastError.message });
                        } else {
                            _ownDownloadFilenames[id] = message.filename;
                            console.log("[Dotti] DOWNLOAD_IMAGE ok, id:", id, "filename:", message.filename);
                            const pMatch = message.filename.match(/(\d+)_PROMPT_/);
                            if (pMatch) {
                                trackedDownloads[id] = {
                                    promptNumber: parseInt(pMatch[1]),
                                    type: "image",
                                    resolution: "1K"
                                };
                                saveTrackedDownloads();
                            }
                            sendResponse({ success: true, downloadId: id });
                        }
                    });
                    return true;

                // v2.0.1: Limpar URLs interceptadas pelo webRequest
                case "CLEAR_INTERCEPTED_VIDEOS":
                    _interceptedVideoUrls.clear();
                    _tileToPromptMap = {};
                    _knownTileIds = new Set();
                    console.log("[Dotti] Intercepted URLs and tile map cleared");
                    sendResponse({ success: true });
                    break;

                // v2.0.2: Buscar videos via tile ID mapping (data-tile-id)
                case "GET_INTERCEPTED_VIDEOS":
                    (async () => {
                        let matchedVideos = [];
                        try {
                            const tabId = targetTabId || sender.tab?.id;
                            if (tabId) {
                                const tileMap = JSON.parse(JSON.stringify(_tileToPromptMap));
                                const results = await chrome.scripting.executeScript({
                                    target: { tabId },
                                    args: [tileMap],
                                    func: (tileMap) => {
                                        const matched = [];
                                        const usedUrls = new Set();

                                        // Para cada tile mapeado, buscar o video DENTRO dele
                                        for (const [tileId, promptNum] of Object.entries(tileMap)) {
                                            const tile = document.querySelector('[data-tile-id="' + tileId + '"]');
                                            if (!tile) continue;
                                            const video = tile.querySelector("video");
                                            if (!video) continue;
                                            const url = video.src || video.currentSrc;
                                            if (url && !url.startsWith("blob:") && url.includes("labs.google")) {
                                                matched.push({ url, promptNum });
                                                usedUrls.add(url);
                                            }
                                        }

                                        // Videos sem tile (fallback)
                                        document.querySelectorAll("video").forEach(v => {
                                            const url = v.src || v.currentSrc;
                                            if (url && !url.startsWith("blob:") && url.includes("labs.google") && !usedUrls.has(url)) {
                                                matched.push({ url, promptNum: null });
                                            }
                                        });

                                        return matched;
                                    }
                                });
                                if (results?.[0]?.result) {
                                    matchedVideos = results[0].result;
                                    const before = _interceptedVideoUrls.size;
                                    for (const v of matchedVideos) _interceptedVideoUrls.add(v.url);
                                    if (_interceptedVideoUrls.size > before) {
                                        console.log("[Dotti] Tile scan found", _interceptedVideoUrls.size - before, "new videos. Total:", _interceptedVideoUrls.size);
                                    }
                                }
                            }
                        } catch (e) {
                            console.log("[Dotti] Tile scan error:", e);
                        }
                        sendResponse({
                            success: true,
                            videos: [..._interceptedVideoUrls],
                            matchedVideos: matchedVideos
                        });
                    })();
                    return true; // async sendResponse
                    break;

                case "GET_SETTINGS":
                    chrome.storage.local.get([
                        "autoDownload", "backgroundMode", "batchSize", "batchInterval", "promptDelay",
                        "videoFolder", "imageFolder", "videoResolution", "imageResolution",
                        "videoOutputCount", "imageOutputCount"
                    ], (s) => {
                        sendResponse({
                            autoDownload: s.autoDownload !== false,
                            backgroundMode: s.backgroundMode !== false,
                            batchSize: s.batchSize || 20,
                            batchInterval: s.batchInterval || 90,
                            promptDelay: s.promptDelay || 3,
                            videoFolder: s.videoFolder || "LetzVideos",
                            imageFolder: s.imageFolder || "LetzImagens",
                            videoResolution: s.videoResolution || "720",
                            imageResolution: s.imageResolution || "1024",
                            videoOutputCount: s.videoOutputCount || 1,
                            imageOutputCount: s.imageOutputCount || 1
                        });
                    });
                    return true;

                case "SAVE_SETTINGS":
                    chrome.storage.local.set(message.settings, () => sendResponse({ success: true }));
                    return true;

                case "GET_ACTIVE_TAB":
                    if (targetTabId) {
                        sendResponse({ tabId: targetTabId, url: "https://labs.google/fx/tools/flow" });
                    } else {
                        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                        sendResponse({ tabId: tab?.id, url: tab?.url });
                    }
                    break;

                case "KEEP_ALIVE":
                    sendResponse({ alive: true });
                    break;

                // v2.0.1: Zoom out na pagina do Flow para mostrar mais cards de video
                case "SET_PAGE_ZOOM":
                    (async () => {
                        try {
                            const zoomTabId = targetTabId || sender?.tab?.id;
                            const zoomLevel = message.zoom || 1.0;
                            console.log("[Dotti] SET_PAGE_ZOOM:", zoomLevel, "tab:", zoomTabId);
                            if (zoomTabId) {
                                await chrome.tabs.setZoom(zoomTabId, zoomLevel);
                                console.log("[Dotti] Zoom applied:", zoomLevel);
                            } else {
                                console.log("[Dotti] Zoom FAILED - no tab ID");
                            }
                            sendResponse({ success: true });
                        } catch (e) {
                            console.log("[Dotti] Zoom error:", e.message);
                            sendResponse({ success: false });
                        }
                    })();
                    return true;

                case "GET_AUTO_NEW_PROJECT":
                    const autoData = await chrome.storage.local.get("dottiAutoNewProject");
                    if (autoData.dottiAutoNewProject) {
                        await chrome.storage.local.remove("dottiAutoNewProject");
                        sendResponse({ autoNewProject: true });
                    } else {
                        sendResponse({ autoNewProject: false });
                    }
                    break;

                default:
                    sendResponse({ error: "Unknown action" });
            }
        } catch (e) {
            sendResponse({ error: e.message });
        }
    })();
    return true;
});

// ============================================
// ACTION & STARTUP
// ============================================
chrome.action.onClicked.addListener(async () => {
    await _bootPromise;
    if (veoWindowId) {
        await focusVeoWindow();
        if (targetTabId) chrome.tabs.sendMessage(targetTabId, { action: "TOGGLE_PANEL" });
    } else {
        // Flag para content.js abrir novo projeto automaticamente
        await chrome.storage.local.set({ dottiAutoNewProject: true });
        await openVeoWindow(false);
    }
});

chrome.runtime.onInstalled.addListener(async () => {
    await _bootPromise;

    // Permitir downloads multiplos automaticos no labs.google
    // Evita que o Chrome pergunte "Este site quer baixar varios ficheiros"
    try {
        await chrome.contentSettings.automaticDownloads.set({
            primaryPattern: 'https://labs.google/*',
            setting: 'allow'
        });
        console.log("[Dotti] Downloads automaticos permitidos para labs.google");
    } catch (e) {
        console.log("[Dotti] Nao foi possivel configurar downloads automaticos:", e.message);
    }
});

chrome.runtime.onStartup.addListener(async () => {
    await _bootPromise;
    if (!queuePaused && promptQueue.length > 0) {
        isProcessingQueue = true;
        setBadgeStatus("processing");
        setTimeout(processNextPrompt, 3000);
    }
});

// v2.1.0: BOOT PROMISE - garante que TODOS os handlers esperam o estado carregar
// Resolve UMA vez e depois retorna instantaneamente
// ============================================
const _bootPromise = (async () => {
    await loadQueueState();
    await loadTrackedDownloads();
    await loadPendingDownloads();
    setBadgeStatus("active");
    console.log("[LetzFlow] Boot complete. Queue:", promptQueue.length, "Processing:", isProcessingQueue);
})();
