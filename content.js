// ============================================
// LETZFLOW SENDER - CONTENT SCRIPT v2.1.0
// Uso pessoal - sem licenciamento
// EXECUTOR DE DOM (recebe comandos do background)
// ============================================

(function() {
    "use strict";

    const PANEL_ID = "dotti-sender-full-panel";
    const TOGGLE_BTN_ID = "dotti-sender-toggle-btn";

    let isPanelVisible = false;
    let panelIframe = null;
    let toggleBtn = null;
    let videoObserver = null;
    let imageObserver = null;

    window.DOTTI_DETECTED_VIDEOS = {};
    window.DOTTI_DETECTED_IMAGES = {};

    // v2.0.1: Resetar zoom ao carregar - Chrome persiste zoom por dominio,
    // entao se sessao anterior terminou sem restaurar, a pagina abre com zoom errado
    try {
        chrome.runtime.sendMessage({ action: "SET_PAGE_ZOOM", zoom: 1.0 }).catch(() => {});
    } catch (e) {}

    // v2.0.0: Buffer de mensagens para quando o iframe nao esta disponivel
    let messageBuffer = [];
    const MAX_BUFFER_SIZE = 50;

    // v2.0.0: Fila sequencial para downloads/upscales
    // Evita que multiplos upscales rodem em paralelo e conflitem na UI
    let downloadQueue = [];
    let isProcessingDownloadQueue = false;

    function enqueueDownload(task) {
        // v2.2.1: Deduplicacao - nao enfileirar se ja existe task pro mesmo prompt
        const isDupe = downloadQueue.some(t => t.promptNumber === task.promptNumber && t.type === task.type);
        if (isDupe) {
            console.log("[Dotti] Download duplicado ignorado para PROMPT", task.promptNumber);
            return;
        }
        downloadQueue.push(task);
        processDownloadQueue();
    }

    async function processDownloadQueue() {
        if (isProcessingDownloadQueue || downloadQueue.length === 0) return;
        isProcessingDownloadQueue = true;

        while (downloadQueue.length > 0) {
            const task = downloadQueue.shift();
            try {
                if (task.type === "video") {
                    const success = await upscaleAndDownloadVideo(task.videoUrl, task.promptNumber, task.resolution);
                    if (!success) {
                        console.log("[Dotti] Upscale de video falhou para PROMPT", task.promptNumber);
                        notifyPanel({
                            type: "UPSCALE_FAILED",
                            data: { promptNumber: task.promptNumber }
                        });
                    }
                } else if (task.type === "image") {
                    const result = await upscaleAndDownloadImage(task.imageUrl, task.promptNumber, task.resolution);
                    if (result.success) {
                        notifyPanel({
                            type: "IMAGE_UPSCALE_STARTED",
                            data: { promptNumber: task.promptNumber, method: result.method }
                        });
                    } else {
                        notifyPanel({
                            type: "IMAGE_UPSCALE_FAILED",
                            data: { promptNumber: task.promptNumber, error: result.error }
                        });
                    }
                } else if (task.type === "generate_image") {
                    // v2.0.0: Gerar imagem ativamente para o prompt
                    const success = await generateImageForPrompt(task.videoUrl, task.promptNumber, task.resolution);
                    if (success) {
                        notifyPanel({
                            type: "IMAGE_GENERATION_STARTED",
                            data: { promptNumber: task.promptNumber }
                        });
                    } else {
                        console.log("[Dotti] Geracao de imagem nao encontrou botao para PROMPT", task.promptNumber);
                    }
                }
            } catch (e) {
                console.error("[Dotti] Erro no processamento da fila de download:", e);
            }

            // Esperar entre cada download para a UI do Flow se estabilizar
            // (menus fecham, upscale inicia, botoes voltam ao estado normal)
            if (downloadQueue.length > 0) {
                await sleep(8000);
            }
        }

        isProcessingDownloadQueue = false;
    }

    // ============================================
    // FUNCOES DE EXECUCAO NO DOM
    // ============================================

    // Clicar automaticamente no botao "Novo projeto" / "New project" na pagina inicial do Flow
    async function autoClickNewProject() {
        // Esperar botoes carregarem
        for (let i = 0; i < 10; i++) {
            const btns = document.querySelectorAll("button, a");
            for (const btn of btns) {
                const txt = (btn.textContent || "").toLowerCase().trim();
                if (txt.includes("novo projeto") || txt.includes("new project") ||
                    txt.includes("criar projeto") || txt.includes("create project") ||
                    txt.includes("new flow") || txt.includes("novo flow")) {
                    console.log("[Dotti DOM] Botao novo projeto encontrado:", btn.textContent?.trim());
                    btn.click();
                    return true;
                }
            }
            // Tambem procurar por icone "add" com texto de projeto
            for (const btn of btns) {
                const icon = btn.querySelector("i");
                if (icon && icon.textContent?.trim() === "add") {
                    const txt = (btn.textContent || "").toLowerCase();
                    if (txt.includes("project") || txt.includes("projeto") || txt.includes("flow")) {
                        console.log("[Dotti DOM] Botao add projeto encontrado:", btn.textContent?.trim());
                        btn.click();
                        return true;
                    }
                }
            }
            await sleep(1000);
        }
        console.log("[Dotti DOM] Botao novo projeto nao encontrado");
        return false;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function waitFor(conditionFn, timeout = 5000, interval = 100) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (conditionFn()) return true;
            await sleep(interval);
        }
        return false;
    }

    // Helper: remover acentos Unicode para comparacao robusta (NFC vs NFD)
    // "vídeo" (precomposed) e "vı́deo" (decomposed) ambos viram "video"
    function stripAccents(str) {
        return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    // Helper: encontrar o span do dropdown de modo de criacao
    // Retorna o span cuja texto corresponde a um dos modos conhecidos do Flow
    function findModeDropdownSpan() {
        const knownPatterns = [
            "texto para", "elementos para", "frames para",
            "text to", "ingredients to", "elements to", "frames to",
            "criar image", "create image"
        ];
        return [...document.querySelectorAll("span")].find(s => {
            const txt = stripAccents((s.textContent || "").toLowerCase().trim());
            if (txt.length > 40) return false;
            const btn = s.closest("button");
            if (!btn || s.closest('[role="option"]') || s.closest('[role="dialog"]')) return false;
            return knownPatterns.some(p => txt.includes(p));
        }) || null;
    }

    // Helper: verificar se o dropdown de modo esta em "Criar imagem/imagens"
    function isDropdownInImageMode() {
        const span = findModeDropdownSpan();
        if (!span) return false;
        const txt = stripAccents((span.textContent || "").toLowerCase().trim());
        return (txt.includes("criar") && (txt.includes("imagem") || txt.includes("imagens") || txt.includes("imagen"))) ||
               (txt.includes("create") && txt.includes("image"));
    }

    async function switchMode(needElements) {
        let modeSpan = null;
        for (let i = 0; i < 3; i++) {
            modeSpan = findModeDropdownSpan();
            if (modeSpan) break;
            await sleep(500);
        }

        if (!modeSpan) {
            console.log("[Dotti DOM] Seletor de modo nao encontrado");
            return false;
        }

        const currentText = modeSpan.textContent || "";
        const isElementsMode = currentText.includes("Elementos") ||
                               currentText.includes("Ingredients") ||
                               currentText.includes("Elements");

        if (needElements !== isElementsMode) {
            const btn = modeSpan.closest("button");
            if (btn) {
                btn.click();
            }

            await waitFor(() => document.querySelectorAll('[role="option"]').length > 0, 3000);
            await sleep(500);

            const options = document.querySelectorAll('[role="option"]');
            const idx = needElements ? 2 : 0;
            if (options[idx]) {
                options[idx].click();
                await sleep(800);
            }
        }
        return true;
    }

    // v2.0.0: Mudar o Flow para modo de geracao de imagem
    // v2.1.0: Mudar a aba do projeto Flow (Videos | Images)
    // O projeto Flow tem abas de filtro de resultados - precisamos estar na aba correta
    async function switchFlowProjectTab(targetType) {
        console.log("[Dotti DOM] Procurando aba do projeto Flow:", targetType);

        const videoKeywords = ["video", "videos"];
        const imageKeywords = ["image", "imagem", "images", "imagens", "photo", "foto", "photos", "fotos"];
        const keywords = targetType === "image" ? imageKeywords : videoKeywords;
        const otherKeywords = targetType === "image" ? videoKeywords : imageKeywords;

        // Estrategia 1: [role="tab"] elements
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
            const txt = stripAccents((tab.textContent || "").toLowerCase().trim());
            if (keywords.some(k => txt.includes(k))) {
                const isSelected = tab.getAttribute("aria-selected") === "true" ||
                                   tab.classList.contains("active") ||
                                   tab.classList.contains("selected");
                if (!isSelected) {
                    reactClick(tab);
                    await sleep(800);
                    console.log("[Dotti DOM] Aba clicada (role=tab):", tab.textContent?.trim());
                }
                return true;
            }
        }

        // Estrategia 2: botoes/links dentro de [role="tablist"]
        const tablist = document.querySelector('[role="tablist"]');
        if (tablist) {
            const items = tablist.querySelectorAll("button, a, [role='tab']");
            for (const item of items) {
                const txt = stripAccents((item.textContent || "").toLowerCase().trim());
                if (keywords.some(k => txt.includes(k))) {
                    reactClick(item);
                    await sleep(800);
                    console.log("[Dotti DOM] Aba clicada (tablist):", item.textContent?.trim());
                    return true;
                }
            }
        }

        // Estrategia 3: Botoes irmaos com keywords de video E imagem (abas do Flow)
        // O Flow usa <button> sem role="tab", com texto como "videocamVídeos" / "imageImagens"
        // (icone Material + nome da aba concatenados)
        const allButtons = document.querySelectorAll("button");
        for (const btn of allButtons) {
            if (btn.offsetParent === null) continue;
            if (btn.closest("textarea") || btn.closest('[role="option"]') || btn.closest('[role="dialog"]')) continue;
            const txt = stripAccents((btn.textContent || "").toLowerCase().trim());
            if (txt.length > 40 || txt.length < 3) continue;
            if (!keywords.some(k => txt.includes(k))) continue;

            // Confirmar: irmao deve ter keyword do outro tipo
            const parent = btn.parentElement;
            if (!parent) continue;
            let hasOtherTab = false;
            for (const sib of parent.children) {
                if (sib === btn) continue;
                const sibTxt = stripAccents((sib.textContent || "").toLowerCase().trim());
                if (otherKeywords.some(k => sibTxt.includes(k))) { hasOtherTab = true; break; }
            }
            if (hasOtherTab) {
                reactClick(btn);
                await sleep(800);
                console.log("[Dotti DOM] Aba clicada (botao):", btn.textContent?.trim());
                return true;
            }
        }

        console.log("[Dotti DOM] Aba do projeto nao encontrada para:", targetType);
        return false;
    }

    async function switchToImageMode() {
        console.log("[Dotti DOM] Mudando para modo de imagem...");

        let modeSpan = null;
        for (let i = 0; i < 3; i++) {
            modeSpan = findModeDropdownSpan();
            if (modeSpan) break;
            await sleep(500);
        }

        if (!modeSpan) {
            console.log("[Dotti DOM] Seletor de modo nao encontrado para switch imagem");
            return false;
        }

        // Se ja esta em modo imagem, so mudar aba do projeto
        if (isDropdownInImageMode()) {
            console.log("[Dotti DOM] Ja esta em modo imagem");
            await switchFlowProjectTab("image");
            return true;
        }

        const btn = modeSpan.closest("button");
        if (!btn) return false;

        // Contar options pre-existentes para detectar quando novas aparecem
        const optionsBefore = document.querySelectorAll('[role="option"]').length;

        btn.click();

        // Esperar NOVAS options aparecerem (nao confundir com pre-existentes)
        await waitFor(() => {
            const count = document.querySelectorAll('[role="option"]').length;
            return count > optionsBefore || count >= 3;
        }, 3000);
        await sleep(500);

        // Buscar options dentro do listbox especifico (evita pegar de outro componente)
        const listbox = document.querySelector('[role="listbox"]');
        const options = listbox
            ? listbox.querySelectorAll('[role="option"]')
            : document.querySelectorAll('[role="option"]');

        console.log("[Dotti DOM] Dropdown options:", [...options].map(o => o.textContent?.trim()));
        let imageOption = null;

        // Tentativa 1: keywords de imagem (com stripAccents para Unicode robusto)
        for (const opt of options) {
            const text = stripAccents((opt.textContent || "").toLowerCase());
            if (text.includes("imagem") || text.includes("imagens") ||
                text.includes("image") || text.includes("images") ||
                text.includes("foto") || text.includes("photo") ||
                (text.includes("criar") && (text.includes("imagem") || text.includes("imagen")))) {
                imageOption = opt;
                break;
            }
        }

        // Tentativa 2: opcao que NAO contem "video" (com stripAccents - resolve NFC/NFD)
        if (!imageOption) {
            for (const opt of options) {
                const text = stripAccents((opt.textContent || "").toLowerCase());
                if (!text.includes("video")) {
                    imageOption = opt;
                    break;
                }
            }
        }

        // Tentativa 3: ultima opcao (imagem e tipicamente a ultima)
        if (!imageOption && options.length > 2) {
            imageOption = options[options.length - 1];
        }

        if (imageOption) {
            imageOption.click();
            await sleep(800);
            console.log("[Dotti DOM] Modo de imagem selecionado:", imageOption.textContent?.trim());
            await switchFlowProjectTab("image");
            return true;
        }

        // Fechar dropdown se nao encontrou
        document.body.click();
        await sleep(300);
        console.log("[Dotti DOM] Opcao de imagem nao encontrada no dropdown");
        return false;
    }

    // v2.0.0: Voltar o Flow para modo de geracao de video
    async function switchToVideoMode() {
        console.log("[Dotti DOM] Voltando para modo de video...");

        let modeSpan = null;
        for (let i = 0; i < 3; i++) {
            modeSpan = findModeDropdownSpan();
            if (modeSpan) break;
            await sleep(500);
        }

        if (!modeSpan) return false;

        // Se ja esta em modo video, so mudar aba do projeto
        if (!isDropdownInImageMode()) {
            console.log("[Dotti DOM] Ja esta em modo video");
            await switchFlowProjectTab("video");
            return true;
        }

        const btn = modeSpan.closest("button");
        if (!btn) return false;

        // Contar options pre-existentes
        const optionsBefore = document.querySelectorAll('[role="option"]').length;

        btn.click();

        await waitFor(() => {
            const count = document.querySelectorAll('[role="option"]').length;
            return count > optionsBefore || count >= 3;
        }, 3000);
        await sleep(500);

        // Buscar dentro do listbox especifico
        const listbox = document.querySelector('[role="listbox"]');
        const options = listbox
            ? listbox.querySelectorAll('[role="option"]')
            : document.querySelectorAll('[role="option"]');

        // Procurar opcao de video (com stripAccents)
        for (const opt of options) {
            const text = stripAccents((opt.textContent || "").toLowerCase());
            if (text.includes("video")) {
                opt.click();
                await sleep(800);
                console.log("[Dotti DOM] Modo de video selecionado:", opt.textContent?.trim());
                await switchFlowProjectTab("video");
                return true;
            }
        }

        // Fallback: primeira opcao geralmente e "Text to video"
        if (options[0]) {
            options[0].click();
            await sleep(800);
            await switchFlowProjectTab("video");
            return true;
        }

        document.body.click();
        return false;
    }

    async function clearElements() {
        console.log("[Dotti DOM] Limpando elementos do prompt (area do textbox)...");

        // Encontrar a area do textbox para limitar a busca
        const textarea = document.querySelector("[role='textbox']");
        if (!textarea) {
            console.log("[Dotti DOM] Textbox nao encontrado, pulando limpeza");
            return;
        }

        // Encontrar o container do prompt (ancestral comum do textbox e dos thumbnails)
        // Subir ate encontrar um container com largura razoavel
        let promptArea = textarea.parentElement;
        for (let i = 0; i < 5 && promptArea; i++) {
            if (promptArea.offsetWidth > 300) break;
            promptArea = promptArea.parentElement;
        }
        if (!promptArea) promptArea = textarea.parentElement;

        const textareaRect = textarea.getBoundingClientRect();

        for (let pass = 0; pass < 3; pass++) {
            const closeButtons = [];

            // Buscar APENAS botoes DENTRO do promptArea (area de composicao do prompt)
            // NUNCA buscar no document inteiro para nao deletar imagens da galeria
            promptArea.querySelectorAll("button").forEach(btn => {
                if (btn.offsetParent === null) return;
                const icon = btn.querySelector("i");
                const iconText = icon?.textContent?.trim();
                if (iconText !== "close" && iconText !== "clear") return;

                // Verificar se o botao esta perto do textarea verticalmente
                const btnRect = btn.getBoundingClientRect();
                const verticalDistance = Math.abs(btnRect.top - textareaRect.top);
                if (verticalDistance > 150) return; // Fora da area de composicao

                // Verificar se tem thumbnail (img) como irmao - indica elemento anexado ao prompt
                const parent = btn.parentElement;
                if (parent && parent.querySelector("img")) {
                    closeButtons.push(btn);
                }
            });

            if (closeButtons.length === 0) break;

            console.log("[Dotti DOM] Encontrados", closeButtons.length, "elementos para limpar (passada", pass + 1, ")");

            for (const btn of closeButtons) {
                try {
                    const reactKey = Object.keys(btn).find(k => k.startsWith("__reactProps"));
                    if (reactKey && btn[reactKey]?.onClick) {
                        btn[reactKey].onClick();
                    } else {
                        btn.click();
                    }
                    await sleep(200);
                } catch (e) {
                    console.log("[Dotti DOM] Erro ao limpar elemento:", e);
                }
            }

            await sleep(400);
        }

        console.log("[Dotti DOM] Limpeza de elementos concluida");
    }

    async function addElement(elementIndex) {
        console.log("[Dotti DOM] Adicionando elemento indice", elementIndex);

        const addButtons = [];
        document.querySelectorAll("button").forEach(btn => {
            const icon = btn.querySelector("i");
            if (icon?.textContent?.trim() === "add") addButtons.push(btn);
        });

        if (addButtons.length === 0) {
            console.log("[Dotti DOM] Nenhum botao de adicionar encontrado");
            return false;
        }

        let leftmost = addButtons[0];
        let minLeft = Infinity;
        addButtons.forEach(btn => {
            const rect = btn.getBoundingClientRect();
            if (rect.left < minLeft) { minLeft = rect.left; leftmost = btn; }
        });

        const reactKey = Object.keys(leftmost).find(k => k.startsWith("__reactProps"));
        if (reactKey && leftmost[reactKey]?.onClick) {
            leftmost[reactKey].onClick();
        } else {
            leftmost.click();
        }

        await waitFor(() => {
            return document.querySelector('[role="dialog"]') ||
                   document.querySelectorAll(".sc-fbea20b2-9").length > 0 ||
                   document.querySelectorAll('[class*="thumbnail"]').length > 0;
        }, 5000);

        await sleep(1000);

        // v2.2.0: Virtual scroll - selecao por posicao geometrica
        async function scrollGalleryToIndex(targetIdx) {
            function getThumbs() {
                let t = document.querySelectorAll(".sc-fbea20b2-9");
                if (t.length === 0) t = document.querySelectorAll('[role="dialog"] img');
                if (t.length === 0) t = document.querySelectorAll('[class*="thumbnail"], [class*="Thumbnail"]');
                return t;
            }

            let thumbs = getThumbs();
            if (thumbs.length > targetIdx) {
                thumbs[targetIdx].click();
                return true;
            }

            console.log("[Dotti Gallery] Thumbs:", thumbs.length, "Precisa:", targetIdx + 1);

            // Achar container de virtual scroll (maior ratio scrollHeight/clientHeight)
            let scrollEl = null;
            let maxRatio = 0;
            document.querySelectorAll('*').forEach(el => {
                if (el.clientHeight > 50 && el.scrollHeight > el.clientHeight * 1.3) {
                    const ratio = el.scrollHeight / el.clientHeight;
                    if (ratio > maxRatio) {
                        maxRatio = ratio;
                        scrollEl = el;
                    }
                }
            });

            if (!scrollEl) {
                console.log("[Dotti Gallery] Virtual scroll container nao encontrado");
                return false;
            }

            // Ir pro topo pra medir geometria
            scrollEl.scrollTop = 0;
            await sleep(400);

            thumbs = getThumbs();
            if (thumbs.length < 2) return false;

            const cRect = scrollEl.getBoundingClientRect();
            const rects = Array.from(thumbs).slice(0, 20).map(t => t.getBoundingClientRect());

            const firstTop = rects[0].top;
            let ipr = 1;
            for (let i = 1; i < rects.length; i++) {
                if (Math.abs(rects[i].top - firstTop) < 5) ipr = i + 1;
                else break;
            }

            const itemW = rects[0].width;
            const itemH = rects[0].height;
            let rowH = itemH + 8;
            if (ipr < rects.length) rowH = rects[ipr].top - rects[0].top;

            const startX = rects[0].left;
            const gapX = ipr > 1 ? (rects[1].left - rects[0].left - itemW) : 0;
            const rowOffset = rects[0].top - cRect.top;

            const targetRow = Math.floor(targetIdx / ipr);
            const targetCol = targetIdx % ipr;

            console.log("[Dotti Gallery] Geometria: ipr=" + ipr + " rowH=" + Math.round(rowH) +
                " targetRow=" + targetRow + " targetCol=" + targetCol);

            // Retorna o elemento DOM ou null
            function findByLogicalIdx() {
                const t = getThumbs();
                for (let i = 0; i < t.length; i++) {
                    const r = t[i].getBoundingClientRect();
                    const absY = r.top - cRect.top + scrollEl.scrollTop;
                    const row = Math.round((absY - rowOffset) / rowH);
                    const col = Math.round((r.left - startX) / (itemW + gapX));
                    if (row === targetRow && col === targetCol) {
                        return t[i];
                    }
                }
                return null;
            }

            for (let attempt = -2; attempt <= 5; attempt++) {
                const st = Math.max(0, targetRow * rowH - cRect.height / 3 + attempt * rowH);
                scrollEl.scrollTop = st;
                await sleep(400);

                const found = findByLogicalIdx();
                if (found) {
                    console.log("[Dotti Gallery] Item " + targetIdx + " encontrado (attempt " + attempt + ")");
                    found.scrollIntoView({ block: "center", behavior: "instant" });
                    await sleep(150);
                    found.click();
                    return true;
                }
            }

            console.log("[Dotti Gallery] FALHOU - item " + targetIdx + " nao encontrado");
            return false;
        }

        const scrollOk = await scrollGalleryToIndex(elementIndex);
        await sleep(300);

        if (!scrollOk) {
            console.log("[Dotti DOM] Nao foi possivel selecionar elemento", elementIndex);
            return false;
        }
        // No virtual scroll, o click ja foi feito dentro de scrollGalleryToIndex
        // Para indice baixo (sem virtual scroll), o click tambem ja foi feito
        let clicked = true;

        await sleep(1500);

        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
            const closeBtn = dialog.querySelector('button i[class*="close"]')?.closest('button');
            if (closeBtn) closeBtn.click();
            await sleep(500);
        }

        console.log("[Dotti DOM] Elemento", elementIndex, "adicionado com sucesso");
        return true;
    }

    async function fillTextarea(text) {
        console.log("[Dotti DOM] Preenchendo textarea...");

        let textarea = document.querySelector("#PINHOLE_TEXT_AREA_ELEMENT_ID");
        if (!textarea) {
            textarea = document.querySelector('textarea[placeholder*="prompt"]') ||
                       document.querySelector('textarea[placeholder*="Prompt"]') ||
                       document.querySelector('textarea');
        }

        if (!textarea) {
            console.log("[Dotti DOM] Textarea nao encontrado");
            return false;
        }

        textarea.click();
        await sleep(100);
        textarea.focus();
        await sleep(100);

        textarea.value = "";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(100);

        textarea.select();

        document.execCommand("selectAll", false, null);
        document.execCommand("insertText", false, text);

        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

        await sleep(300);

        if (textarea.value !== text) {
            console.log("[Dotti DOM] Texto nao corresponde, tentando metodo alternativo...");

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeInputValueSetter.call(textarea, text);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));

            await sleep(300);
        }

        const success = textarea.value.length > 0;
        console.log("[Dotti DOM] Textarea preenchido:", success, "- Tamanho:", textarea.value.length);
        return success;
    }

    async function clickCreateButton() {
        console.log("[Dotti DOM] Clicando no botao criar...");

        let createBtn = null;
        const buttons = document.querySelectorAll("button");

        for (const btn of buttons) {
            const icon = btn.querySelector("i");
            const iconText = icon?.textContent?.trim();

            if (iconText === "arrow_forward" || iconText === "send") {
                createBtn = btn;
                break;
            }
        }

        if (!createBtn) {
            createBtn = document.querySelector('button[aria-label*="Create"], button[aria-label*="Send"], button[aria-label*="Generate"]');
        }

        if (!createBtn) {
            console.log("[Dotti DOM] Botao criar nao encontrado");
            return false;
        }

        if (createBtn.disabled) {
            console.log("[Dotti DOM] Botao criar esta desabilitado");
            return false;
        }

        const reactKey = Object.keys(createBtn).find(k => k.startsWith("__reactProps"));
        if (reactKey && createBtn[reactKey]?.onClick) {
            createBtn[reactKey].onClick();
        } else {
            createBtn.click();
        }

        await sleep(500);

        const textarea = document.querySelector("#PINHOLE_TEXT_AREA_ELEMENT_ID");
        const wasCleared = !textarea || textarea.value.length === 0 || createBtn.disabled;

        if (!wasCleared) {
            console.log("[Dotti DOM] Prompt pode nao ter sido enviado, tentando novamente...");
            createBtn.click();
            await sleep(500);
        }

        console.log("[Dotti DOM] Botao criar clicado com sucesso");
        return true;
    }

    // ============================================
    // EXECUTE PROMPT (CALLED BY BACKGROUND)
    // ============================================

    async function executePrompt(prompt) {
        console.log("[Dotti DOM] ========================================");
        console.log("[Dotti DOM] Executando PROMPT", prompt.number);
        console.log("[Dotti DOM] Texto:", prompt.text.substring(0, 50) + "...");
        console.log("[Dotti DOM] Elementos:", prompt.elements);

        try {
            const hasElements = prompt.elements && prompt.elements.length > 0;

            console.log("[Dotti DOM] Passo 1: Limpando elementos residuais...");
            await clearElements();
            await sleep(800);

            console.log("[Dotti DOM] Passo 2: Verificando modo...");
            const modeOk = await switchMode(hasElements);
            if (!modeOk) {
                console.log("[Dotti DOM] ERRO: Falha ao mudar modo");
                return { success: false, error: "mode_switch_failed" };
            }
            await sleep(500);

            if (hasElements) {
                console.log("[Dotti DOM] Passo 3: Adicionando", prompt.elements.length, "elementos...");
                for (const elementNum of prompt.elements) {
                    const added = await addElement(elementNum - 1);
                    if (!added) {
                        console.log("[Dotti DOM] ERRO: Falha ao adicionar elemento", elementNum);
                        return { success: false, error: "element_failed" };
                    }
                    await sleep(500);
                }
            }

            console.log("[Dotti DOM] Passo 4: Preenchendo prompt...");
            const filled = await fillTextarea(prompt.text);
            if (!filled) {
                console.log("[Dotti DOM] ERRO: Falha ao preencher textarea");
                return { success: false, error: "fill_failed" };
            }

            await sleep(1000);

            console.log("[Dotti DOM] Passo 5: Enviando...");
            const clicked = await clickCreateButton();
            if (!clicked) {
                console.log("[Dotti DOM] ERRO: Falha ao clicar no botao criar");
                return { success: false, error: "click_failed" };
            }

            await sleep(2000);

            const textarea = document.querySelector("#PINHOLE_TEXT_AREA_ELEMENT_ID");
            if (textarea && textarea.value.length > 0) {
                console.log("[Dotti DOM] AVISO: Textarea ainda tem conteudo, tentando enviar novamente...");
                await clickCreateButton();
                await sleep(1500);
            }

            console.log("[Dotti DOM] PROMPT", prompt.number, "executado com SUCESSO");
            console.log("[Dotti DOM] ========================================");
            return { success: true };

        } catch (error) {
            console.error("[Dotti DOM] ERRO CRITICO:", error);
            return { success: false, error: error.message };
        }
    }

    // ============================================
    // PANEL MANAGEMENT - v2.0.0 COM BUFFER
    // ============================================

    // v2.0.0: Encontrar iframe do painel de forma resiliente
    function findPanelIframe() {
        if (panelIframe?.contentWindow) return panelIframe;

        const panelContainer = document.getElementById(PANEL_ID);
        if (panelContainer) {
            const iframe = panelContainer.querySelector("iframe");
            if (iframe?.contentWindow) {
                panelIframe = iframe;
                return iframe;
            }
        }
        return null;
    }

    function notifyPanel(message) {
        const iframe = findPanelIframe();
        if (iframe?.contentWindow) {
            // v2.0.0: Enviar mensagens do buffer primeiro
            flushMessageBuffer();
            iframe.contentWindow.postMessage(message, "*");
            return;
        }

        // v2.0.0: Se iframe nao disponivel, armazenar no buffer
        if (messageBuffer.length < MAX_BUFFER_SIZE) {
            messageBuffer.push(message);
        }
    }

    // v2.0.0: Enviar mensagens pendentes do buffer
    function flushMessageBuffer() {
        if (messageBuffer.length === 0) return;
        const iframe = findPanelIframe();
        if (!iframe?.contentWindow) return;

        const buffered = [...messageBuffer];
        messageBuffer = [];
        for (const msg of buffered) {
            iframe.contentWindow.postMessage(msg, "*");
        }
    }

    function createPanel() {
        if (document.getElementById(PANEL_ID)) return;

        const container = document.createElement("div");
        container.id = PANEL_ID;
        container.className = "dotti-panel-container";

        const header = document.createElement("div");
        header.className = "dotti-panel-header";
        header.innerHTML = `
            <div class="dotti-panel-title">
                <span class="dotti-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4 14H11L10 22L19 10H12L13 2Z" fill="#FFD700" stroke="#FFD700" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
                <span>LetzFlow</span>
            </div>
            <div class="dotti-panel-actions">
                <button class="dotti-btn-minimize" title="Minimizar">&minus;</button>
                <button class="dotti-btn-close" title="Fechar">&times;</button>
            </div>
        `;

        panelIframe = document.createElement("iframe");
        panelIframe.src = chrome.runtime.getURL("panel.html");
        panelIframe.className = "dotti-panel-iframe";

        // v2.0.0: Quando iframe carregar, enviar mensagens do buffer
        panelIframe.addEventListener("load", () => {
            setTimeout(flushMessageBuffer, 500);
        });

        container.appendChild(header);
        container.appendChild(panelIframe);
        document.body.appendChild(container);

        header.querySelector(".dotti-btn-close").addEventListener("click", togglePanel);
        header.querySelector(".dotti-btn-minimize").addEventListener("click", () => {
            container.classList.toggle("minimized");
        });
    }

    function togglePanel() {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) {
            createPanel();
            isPanelVisible = true;
        } else {
            isPanelVisible = !isPanelVisible;
            if (isPanelVisible) {
                panel.style.display = "flex";
                panel.classList.remove("dotti-sidebar-hidden");
            } else {
                panel.classList.add("dotti-sidebar-hidden");
                setTimeout(() => { panel.style.display = "none"; }, 300);
            }
        }
        if (toggleBtn) {
            toggleBtn.classList.toggle("active", isPanelVisible);
            toggleBtn.classList.toggle("sidebar-closed", !isPanelVisible);
        }
        document.documentElement.classList.toggle("dotti-sidebar-open", isPanelVisible);
    }

    // ============================================
    // VIDEO DETECTION
    // ============================================

    // v2.0.1: Rastrear videos detectados por UUID
    // Google Flow usa 2 URLs para o mesmo video:
    //   DOM: labs.google/.../getMediaUrlRedirect?name=UUID
    //   Rede: storage.googleapis.com/.../video/UUID
    // Dedup por UUID garante que o mesmo video nao seja notificado 2x
    let _detectedVideoUuids = new Set();
    let _detectedVideoUrls = new Set(); // fallback se UUID nao encontrado
    let _scanCount = 0;
    let _videoDetCounter = 0;

    function extractVideoUuid(url) {
        const match = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return match ? match[0].toLowerCase() : null;
    }

    function isVideoAlreadyDetected(url) {
        const uuid = extractVideoUuid(url);
        if (uuid) {
            if (_detectedVideoUuids.has(uuid)) return true;
            _detectedVideoUuids.add(uuid);
            return false;
        }
        // Fallback: dedup por URL se nao tem UUID
        if (_detectedVideoUrls.has(url)) return true;
        _detectedVideoUrls.add(url);
        return false;
    }

    function scanForVideos() {
        const allVideos = document.querySelectorAll("video");
        _scanCount++;
        let flowCount = 0;
        let newCount = 0;
        let knownCount = 0;

        allVideos.forEach(video => {
            const src = video.src || video.querySelector("source")?.src;
            if (!src) return;
            const isFlowVideo = src.includes("storage.googleapis.com") || src.includes("labs.google") || src.includes("googleusercontent.com");
            if (!isFlowVideo) return;
            flowCount++;

            // Dedup por UUID - mesmo video tem URLs diferentes no DOM vs rede
            if (isVideoAlreadyDetected(src)) {
                knownCount++;
                return;
            }

            // Extrair texto do prompt subindo pelo DOM (25 niveis)
            let promptText = "SEM_PROMPT";
            let parent = video.parentElement;
            for (let i = 0; i < 25 && parent; i++) {
                const txt = parent.innerText || "";
                const firstMatch = txt.match(/PROMPT\s*\d+[^\n]*/i);
                if (firstMatch) {
                    const allMatches = [...txt.matchAll(/PROMPT\s*\d+[^\n]*/gi)];
                    if (allMatches.length === 1) {
                        promptText = allMatches[0][0];
                        break;
                    }
                    if (promptText === "SEM_PROMPT") {
                        promptText = allMatches[allMatches.length - 1][0];
                    }
                }
                parent = parent.parentElement;
            }

            newCount++;
            _videoDetCounter++;

            const videoInfo = {
                prompt: promptText,
                timestamp: Date.now(),
                width: video.videoWidth || 0,
                height: video.videoHeight || 0,
                urls: { default: src }
            };

            if (video.videoHeight >= 1080 || src.includes("1080")) {
                videoInfo.urls["1080"] = src;
            }
            if (video.videoHeight <= 720 || src.includes("720")) {
                videoInfo.urls["720"] = src;
            }
            if (!videoInfo.urls["720"] && !videoInfo.urls["1080"]) {
                videoInfo.urls["720"] = src;
            }

            const dictKey = "vdet_" + _videoDetCounter;
            window.DOTTI_DETECTED_VIDEOS[dictKey] = videoInfo;

            const pMatch = promptText.match(/PROMPT\s*(\d+)/i);
            const pNum = pMatch ? parseInt(pMatch[1]) : "?";
            console.log("[Dotti] Video detectado DOM #" + _videoDetCounter, "PROMPT", pNum,
                "- src:", src.substring(0, 100));

            // v2.0.1 FIX: DOM scanner NAO notifica o panel.
            // webRequest (VIDEO_URL_INTERCEPTED) e a UNICA fonte de VIDEO_DETECTED.
            // Motivo: DOM scanner usa redirect URLs que MUDAM entre scans (token/params),
            // fazendo o mesmo video ser detectado multiplas vezes = downloads duplicados.
            // webRequest usa URL real (storage.googleapis.com/UUID) que nunca muda.
        });

        if (newCount > 0 || _scanCount % 15 === 0) {
            console.log("[Dotti] scanForVideos #" + _scanCount + ": total=" + allVideos.length +
                " flow=" + flowCount + " new=" + newCount + " known=" + knownCount +
                " detectados_total=" + _videoDetCounter);
        }
    }

    function startVideoDetection() {
        if (videoObserver) return;
        videoObserver = new MutationObserver(mutations => {
            let hasNewVideos = false;
            mutations.forEach(m => m.addedNodes.forEach(n => {
                if (n.nodeType === 1 && (n.tagName === "VIDEO" || n.querySelectorAll?.("video").length > 0)) {
                    hasNewVideos = true;
                }
            }));
            if (hasNewVideos) setTimeout(scanForVideos, 500);
        });
        videoObserver.observe(document.body, { childList: true, subtree: true });
        scanForVideos();
        setInterval(scanForVideos, 2000);

        // v2.0.1: PerformanceObserver - captura recursos de video ja carregados
        // Complementa o webRequest do background.js (pega videos carregados antes do content script)
        try {
            const perfObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    const url = entry.name;
                    if (!url) continue;
                    const isVideo = url.includes(".mp4") || url.includes(".webm") ||
                                    url.includes("mime=video") || entry.initiatorType === "video";
                    const isGoogle = url.includes("googleapis.com") || url.includes("googleusercontent.com") ||
                                     url.includes("labs.google");
                    if (!isVideo || !isGoogle) continue;
                    if (isVideoAlreadyDetected(url)) continue;

                    _videoDetCounter++;
                    const dictKey = "vperf_" + _videoDetCounter;
                    const videoInfo = {
                        prompt: "SEM_PROMPT",
                        timestamp: Date.now(),
                        width: 0,
                        height: 0,
                        urls: { default: url, "720": url }
                    };
                    window.DOTTI_DETECTED_VIDEOS[dictKey] = videoInfo;
                    console.log("[Dotti] PerformanceObserver video #" + _videoDetCounter,
                        "url:", url.substring(0, 100), "(sem notificar panel - webRequest cuida)");
                }
            });
            perfObserver.observe({ type: "resource", buffered: true });
            console.log("[Dotti] PerformanceObserver ativado para deteccao de video");
        } catch (e) {
            console.log("[Dotti] PerformanceObserver nao disponivel:", e.message);
        }
    }

    // ============================================
    // IMAGE DETECTION - v2.0.0
    // ============================================

    function scanForImages() {
        document.querySelectorAll("img").forEach(img => {
            const src = img.src;
            if (!src) return;

            // Filtrar imagens geradas pelo AI - CDNs do Google usados pelo Flow
            // NAO incluir blob: pois nao podem ser baixados pela extensao
            const isGenerated = src.includes("storage.googleapis.com") ||
                               src.includes("googleusercontent.com") ||
                               src.includes("gstatic.com") ||
                               src.includes("ggpht.com") ||
                               src.includes("labs.google");

            // Excluir thumbnails pequenos, icones, avatares - usar fallbacks de tamanho
            const w = img.naturalWidth || img.offsetWidth || img.width || 0;
            const h = img.naturalHeight || img.offsetHeight || img.height || 0;
            const isLargeEnough = w > 200 && h > 200;
            const isNotIcon = !src.includes("icon") && !src.includes("avatar") && !src.includes("logo") && !src.includes("favicon");

            if (isGenerated && isLargeEnough && isNotIcon && !window.DOTTI_DETECTED_IMAGES[src]) {
                let promptText = "SEM_PROMPT";
                let parent = img.parentElement;

                for (let i = 0; i < 8 && parent; i++) {
                    const matches = [...(parent.innerText || "").matchAll(/PROMPT\s*\d+[^\n]*/gi)];
                    if (matches.length > 0) { promptText = matches[matches.length - 1][0]; break; }
                    parent = parent.parentElement;
                }

                const imageInfo = {
                    prompt: promptText,
                    timestamp: Date.now(),
                    width: w,
                    height: h,
                    urls: { default: src }
                };

                // URL padrao para download direto (1K)
                imageInfo.urls["1024"] = src;
                // 2K requer upscale via UI do Flow
                imageInfo.urls["2048"] = src;
                // Flag para indicar que upscale via UI e necessario para resolucao maior
                imageInfo.needsUpscale = true;

                window.DOTTI_DETECTED_IMAGES[src] = imageInfo;
                console.log("[Dotti] Imagem detectada:", promptText, "- Tamanho:", img.naturalWidth + "x" + img.naturalHeight);
                notifyPanel({
                    type: "IMAGE_DETECTED",
                    data: {
                        url: src,
                        prompt: promptText,
                        timestamp: Date.now(),
                        urls: imageInfo.urls,
                        width: imageInfo.width,
                        height: imageInfo.height
                    }
                });
            }
        });
    }

    function startImageDetection() {
        if (imageObserver) return;
        imageObserver = new MutationObserver(mutations => {
            let hasNewImages = false;
            mutations.forEach(m => m.addedNodes.forEach(n => {
                if (n.nodeType === 1 && (n.tagName === "IMG" || n.querySelectorAll?.("img").length > 0)) {
                    hasNewImages = true;
                }
            }));
            if (hasNewImages) setTimeout(scanForImages, 500);
        });
        imageObserver.observe(document.body, { childList: true, subtree: true });
        scanForImages();
        setInterval(scanForImages, 3000);
    }

    // ============================================
    // v2.0.0: UPSCALE DE VIDEO VIA MENU DO FLOW
    // O Flow tem um menu de download em cada video:
    //   - Animated GIF (270p)
    //   - Original Size (720p)
    //   - Upscaled (1080p)
    // Esta funcao encontra o video, clica no botao de download
    // e seleciona a opcao de upscale
    // ============================================

    // Helper: verificar se um elemento e um botao de download (icone ou aria-label)
    function isDownloadButton(el) {
        const icon = el.querySelector("i");
        const iconText = icon?.textContent?.trim();
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        // Tambem verificar SVG icons (Material Symbols)
        const svgTitle = el.querySelector("svg title")?.textContent?.toLowerCase() || "";

        return iconText === "download" || iconText === "file_download" ||
               iconText === "arrow_downward" || iconText === "save_alt" ||
               iconText === "get_app" ||
               ariaLabel.includes("download") || ariaLabel.includes("baixar") ||
               ariaLabel.includes("save") || ariaLabel.includes("salvar") ||
               svgTitle.includes("download");
    }

    // Helper: encontrar botao de download mais proximo de um elemento alvo por distancia geometrica
    function findClosestDownloadButton(targetElement) {
        const candidates = document.querySelectorAll('button, [role="button"]');
        const targetRect = targetElement.getBoundingClientRect();
        let closestBtn = null;
        let closestDist = Infinity;

        for (const el of candidates) {
            if (!isDownloadButton(el)) continue;

            const elRect = el.getBoundingClientRect();
            // Pular botoes com dimensao 0 (realmente invisivel) ou fora do viewport
            if (elRect.width === 0 && elRect.height === 0) continue;
            if (elRect.right < 0 || elRect.bottom < 0 ||
                elRect.left > window.innerWidth || elRect.top > window.innerHeight) continue;

            const dx = (elRect.left + elRect.width / 2) - (targetRect.left + targetRect.width / 2);
            const dy = (elRect.top + elRect.height / 2) - (targetRect.top + targetRect.height / 2);
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < closestDist) {
                closestDist = dist;
                closestBtn = el;
            }
        }

        if (closestBtn && closestDist < 600) {
            return { btn: closestBtn, dist: closestDist };
        }
        return null;
    }

    // Helper: encontrar botao "more options" (tres pontos) mais proximo de um elemento
    function findClosestMoreButton(targetElement) {
        const candidates = document.querySelectorAll('button, [role="button"]');
        const targetRect = targetElement.getBoundingClientRect();
        let closestBtn = null;
        let closestDist = Infinity;

        for (const el of candidates) {
            const icon = el.querySelector("i");
            const iconText = icon?.textContent?.trim();
            const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
            const isMoreBtn =
                iconText === "more_vert" || iconText === "more_horiz" ||
                iconText === "more" || iconText === "menu" ||
                ariaLabel.includes("more") || ariaLabel.includes("options") ||
                ariaLabel.includes("menu") || ariaLabel.includes("opcoes");
            if (!isMoreBtn) continue;

            const elRect = el.getBoundingClientRect();
            const dx = (elRect.left + elRect.width / 2) - (targetRect.left + targetRect.width / 2);
            const dy = (elRect.top + elRect.height / 2) - (targetRect.top + targetRect.height / 2);
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < closestDist) {
                closestDist = dist;
                closestBtn = el;
            }
        }

        if (closestBtn && closestDist < 800) {
            return { btn: closestBtn, dist: closestDist };
        }
        return null;
    }

    // Helper: fechar qualquer menu/dropdown aberto
    async function closeOpenMenus() {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await sleep(300);
        document.body.click();
        await sleep(300);
    }

    // Helper: hover - dispara pointer + mouse events com coordenadas reais
    function hoverElementFull(element) {
        const rect = element.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };

        // Subir ate 5 niveis de ancestrais
        let el = element;
        for (let i = 0; i < 5 && el && el !== document.body; i++) {
            // Pointer events primeiro (React 17+ prioriza estes)
            try { el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerType: 'mouse' })); } catch(e) {}
            try { el.dispatchEvent(new PointerEvent('pointermove', { ...opts, pointerType: 'mouse' })); } catch(e) {}
            // Mouse events (compatibilidade)
            el.dispatchEvent(new MouseEvent('mouseenter', opts));
            el.dispatchEvent(new MouseEvent('mouseover', opts));
            el.dispatchEvent(new MouseEvent('mousemove', opts));
            el = el.parentElement;
        }
    }

    // Helper: clicar em um elemento - React props OU click nativo, NUNCA ambos
    function reactClick(element) {
        const reactKey = Object.keys(element).find(k => k.startsWith("__reactProps"));
        if (reactKey && element[reactKey]?.onClick) {
            element[reactKey].onClick();
        } else {
            element.click();
        }
    }

    async function upscaleAndDownloadVideo(videoUrl, promptNumber, resolution) {
        console.log("[Dotti] Iniciando upscale para PROMPT", promptNumber, "resolucao:", resolution);

        try {
            // 0. FECHAR qualquer menu/dropdown que possa estar aberto de um download anterior
            await closeOpenMenus();

            // 1. Encontrar o elemento <video> correspondente na pagina
            let targetVideo = null;
            document.querySelectorAll("video").forEach(video => {
                const src = video.src || video.querySelector("source")?.src || "";
                if (src === videoUrl || src.includes(videoUrl.split("?")[0]?.split("/").pop())) {
                    targetVideo = video;
                }
            });

            if (!targetVideo) {
                // Tenta encontrar qualquer video que corresponda ao prompt
                const allVideos = document.querySelectorAll("video");
                for (const video of allVideos) {
                    let parent = video.parentElement;
                    for (let i = 0; i < 15 && parent; i++) {
                        if ((parent.innerText || "").includes("PROMPT " + promptNumber)) {
                            targetVideo = video;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    if (targetVideo) break;
                }
            }

            if (!targetVideo) {
                console.log("[Dotti] Video nao encontrado na pagina para PROMPT", promptNumber);
                return false;
            }

            console.log("[Dotti] Video encontrado para PROMPT", promptNumber, "readyState:", targetVideo.readyState);

            // 2. Esperar video carregar antes de interagir (readyState 0 = nao renderizado)
            if (targetVideo.readyState < 2) {
                console.log("[Dotti] Aguardando video carregar...");
                for (let w = 0; w < 30; w++) {
                    await sleep(1000);
                    if (targetVideo.readyState >= 2) break;
                }
                console.log("[Dotti] readyState apos espera:", targetVideo.readyState);
            }

            // 3. SCROLL o video para o centro da tela
            targetVideo.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(1200);

            // 3. Hover e busca de botao - 3 tentativas com intervalos crescentes
            let downloadBtn = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log("[Dotti] Hover tentativa #" + attempt + " para PROMPT", promptNumber);

                hoverElementFull(targetVideo);
                await sleep(1000 + attempt * 500); // 1500ms, 2000ms, 2500ms

                let result = findClosestDownloadButton(targetVideo);
                if (result) {
                    downloadBtn = result.btn;
                    console.log("[Dotti] Botao encontrado na tentativa #" + attempt + " (dist:", Math.round(result.dist), "px)");
                    break;
                }

                console.log("[Dotti] Botao nao encontrado, tentando novamente...");
            }

            if (!downloadBtn) {
                console.log("[Dotti] Botao de download nao encontrado para PROMPT", promptNumber);
                await closeOpenMenus();
                return false;
            }

            // 5. Clicar no botao de download para abrir o menu
            reactClick(downloadBtn);

            // 6. Esperar o menu/dropdown aparecer
            await sleep(1200);

            // 7. Encontrar a opcao de upscale no menu
            let upscaleOption = null;

            // Buscar nos menus/dropdowns/opcoes visiveis
            await waitFor(() => {
                const menuItems = document.querySelectorAll(
                    '[role="menuitem"], [role="option"], [role="listbox"] *, ' +
                    'li, [class*="menu"] *, [class*="dropdown"] *, [class*="popover"] *'
                );

                for (const item of menuItems) {
                    const text = (item.textContent || "").toLowerCase();
                    if (text.includes("upscale") || text.includes("1080") ||
                        text.includes("enhance") || text.includes("aprimorad") ||
                        text.includes("alta qualidade") || text.includes("high quality")) {
                        upscaleOption = item.closest("button") || item.closest("[role='menuitem']") ||
                                       item.closest("li") || item;
                        return true;
                    }
                }

                const allMenuTexts = document.querySelectorAll('[role="menu"] *, [class*="menu"] *');
                for (const el of allMenuTexts) {
                    const text = (el.textContent || "").trim().toLowerCase();
                    if ((text.includes("1080") || text.includes("upscale")) && el.offsetParent !== null) {
                        upscaleOption = el.closest("button") || el.closest("[role='menuitem']") || el;
                        return true;
                    }
                }

                return false;
            }, 5000, 300);

            if (!upscaleOption) {
                console.log("[Dotti] Opcao de upscale nao encontrada no menu. Tentando terceira opcao...");

                // Fallback: menu geralmente tem 3 opcoes - GIF, Original, Upscaled
                const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"]');
                if (menuItems.length >= 3) {
                    upscaleOption = menuItems[2]; // Terceira opcao = Upscaled
                    console.log("[Dotti] Usando terceira opcao do menu como upscale");
                } else if (menuItems.length >= 2) {
                    upscaleOption = menuItems[menuItems.length - 1]; // Ultima opcao
                    console.log("[Dotti] Usando ultima opcao do menu");
                }
            }

            if (!upscaleOption) {
                console.log("[Dotti] Nao foi possivel encontrar opcao de upscale para PROMPT", promptNumber);
                await closeOpenMenus();
                return false;
            }

            console.log("[Dotti] Opcao de upscale encontrada:", upscaleOption.textContent?.trim());

            // 8. Clicar na opcao de upscale
            reactClick(upscaleOption);

            console.log("[Dotti] Upscale solicitado para PROMPT", promptNumber, "- aguardando processamento...");

            // 9. Esperar o menu fechar e o Flow iniciar o processamento
            await sleep(1000);

            // Notificar o painel
            notifyPanel({
                type: "UPSCALE_STARTED",
                data: { promptNumber: promptNumber, resolution: resolution }
            });

            return true;

        } catch (e) {
            console.error("[Dotti] Erro no upscale:", e);
            await closeOpenMenus();
            return false;
        }
    }

    // ============================================
    // v2.0.0: GERACAO DE IMAGEM VIA UI DO FLOW
    // Apos gerar um video, o Flow pode ter um botao para gerar imagem
    // do mesmo prompt (ex: icone "image", "photo", "add_photo_alternate").
    // Esta funcao encontra o video, procura o botao de gerar imagem
    // e clica nele. A deteccao de imagens (MutationObserver) vai
    // capturar a imagem gerada e baixar automaticamente.
    // ============================================

    // Helper: verificar se um elemento e um botao de geracao de imagem
    function isImageGenerationButton(el) {
        const icon = el.querySelector("i");
        const iconText = icon?.textContent?.trim();
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const svgTitle = el.querySelector("svg title")?.textContent?.toLowerCase() || "";
        const text = (el.textContent || "").toLowerCase().trim();

        // Verificar icones Material Design relacionados a imagem
        const imageIcons = [
            "image", "photo", "add_photo_alternate", "photo_camera",
            "landscape", "panorama", "wallpaper", "collections",
            "add_a_photo", "photo_library", "insert_photo", "imagesmode"
        ];
        if (iconText && imageIcons.includes(iconText)) return true;

        // Verificar aria-label
        if (ariaLabel.includes("generate image") || ariaLabel.includes("create image") ||
            ariaLabel.includes("gerar imagem") || ariaLabel.includes("criar imagem") ||
            ariaLabel.includes("still frame") || ariaLabel.includes("still image") ||
            ariaLabel.includes("image from") || ariaLabel.includes("imagem de")) return true;

        // SVG title
        if (svgTitle.includes("image") || svgTitle.includes("photo")) return true;

        // Texto curto (evitar falsos positivos em paragrafos longos)
        if (text.length < 40) {
            if (text.includes("generate image") || text.includes("gerar imagem") ||
                text.includes("create image") || text.includes("criar imagem") ||
                text.includes("still frame") || text.includes("make image") ||
                text === "image" || text === "imagem" || text === "photo" || text === "foto") return true;
        }

        return false;
    }

    // Helper: encontrar botao de geracao de imagem mais proximo do video
    function findClosestImageGenButton(targetElement) {
        const candidates = document.querySelectorAll('button, [role="button"]');
        const targetRect = targetElement.getBoundingClientRect();
        let closestBtn = null;
        let closestDist = Infinity;

        for (const el of candidates) {
            if (!isImageGenerationButton(el)) continue;
            // Excluir botoes de download (podem ter icone parecido)
            if (isDownloadButton(el)) continue;

            const elRect = el.getBoundingClientRect();
            if (elRect.width === 0 && elRect.height === 0) continue;
            if (elRect.right < 0 || elRect.bottom < 0 ||
                elRect.left > window.innerWidth || elRect.top > window.innerHeight) continue;

            const dx = (elRect.left + elRect.width / 2) - (targetRect.left + targetRect.width / 2);
            const dy = (elRect.top + elRect.height / 2) - (targetRect.top + targetRect.height / 2);
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < closestDist) {
                closestDist = dist;
                closestBtn = el;
            }
        }

        if (closestBtn && closestDist < 600) {
            return { btn: closestBtn, dist: closestDist };
        }
        return null;
    }

    async function generateImageForPrompt(videoUrl, promptNumber, resolution) {
        console.log("[Dotti] Gerando imagem para PROMPT", promptNumber);

        try {
            await closeOpenMenus();

            // 1. Encontrar o <video> do prompt
            let targetVideo = null;
            document.querySelectorAll("video").forEach(video => {
                const src = video.src || video.querySelector("source")?.src || "";
                if (src === videoUrl || src.includes(videoUrl.split("?")[0]?.split("/").pop())) {
                    targetVideo = video;
                }
            });

            if (!targetVideo) {
                for (const video of document.querySelectorAll("video")) {
                    let parent = video.parentElement;
                    for (let i = 0; i < 15 && parent; i++) {
                        if ((parent.innerText || "").includes("PROMPT " + promptNumber)) {
                            targetVideo = video;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    if (targetVideo) break;
                }
            }

            if (!targetVideo) {
                console.log("[Dotti] Video nao encontrado para gerar imagem - PROMPT", promptNumber);
                return false;
            }

            // 2. Scroll para o video
            targetVideo.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(1200);

            // 3. Hover para revelar botoes
            let imageGenBtn = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
                hoverElementFull(targetVideo);
                await sleep(1000 + attempt * 500);

                const result = findClosestImageGenButton(targetVideo);
                if (result) {
                    imageGenBtn = result.btn;
                    console.log("[Dotti] Botao de gerar imagem encontrado na tentativa #" + attempt, "(dist:", Math.round(result.dist), "px)");
                    break;
                }
            }

            if (!imageGenBtn) {
                // Fallback: procurar no card/container pai do video
                let container = targetVideo.parentElement;
                for (let i = 0; i < 10 && container; i++) {
                    const btns = container.querySelectorAll('button, [role="button"]');
                    for (const btn of btns) {
                        if (isImageGenerationButton(btn)) {
                            imageGenBtn = btn;
                            console.log("[Dotti] Botao de gerar imagem encontrado no container pai");
                            break;
                        }
                    }
                    if (imageGenBtn) break;
                    container = container.parentElement;
                }
            }

            if (!imageGenBtn) {
                console.log("[Dotti] Botao de gerar imagem nao encontrado para PROMPT", promptNumber);
                return false;
            }

            // 4. Clicar no botao de gerar imagem
            reactClick(imageGenBtn);
            console.log("[Dotti] Geracao de imagem clicada para PROMPT", promptNumber, "- texto:", imageGenBtn.textContent?.trim());
            await sleep(2000);

            // 5. Verificar se abriu algum menu de resolucao
            if (resolution && resolution !== "1024") {
                const resText = resolution === "2048" ? "2k" : "";
                if (resText) {
                    await waitFor(() => {
                        const menuItems = document.querySelectorAll(
                            '[role="menuitem"], [role="option"], li, [class*="menu"] *'
                        );
                        for (const item of menuItems) {
                            const t = (item.textContent || "").toLowerCase();
                            if (t.includes(resText) || t.includes(resolution)) {
                                const clickable = item.closest("button") || item.closest("[role='menuitem']") ||
                                                 item.closest("li") || item;
                                reactClick(clickable);
                                console.log("[Dotti] Resolucao", resText, "selecionada para imagem");
                                return true;
                            }
                        }
                        return false;
                    }, 3000, 300);
                }
            }

            await sleep(500);
            return true;

        } catch (e) {
            console.error("[Dotti] Erro na geracao de imagem:", e);
            await closeOpenMenus();
            return false;
        }
    }

    // ============================================
    // v2.1.0: UPSCALE DE IMAGEM VIA UI DO FLOW
    // O Flow permite upscale de imagens para 2K.
    // O botao de download da imagem abre um menu com opcoes de resolucao
    // (similar ao video: Original, Upscaled 2K).
    // Se o botao de download nao abre menu, tenta o botao "more options".
    // ============================================

    async function upscaleAndDownloadImage(imageUrl, promptNumber, resolution) {
        console.log("[Dotti] Iniciando download/upscale de imagem PROMPT", promptNumber, "resolucao:", resolution);

        try {
            // 0. Fechar qualquer menu aberto de um download anterior
            await closeOpenMenus();

            // 1. Encontrar o elemento <img> correspondente na pagina
            let targetImg = null;
            document.querySelectorAll("img").forEach(img => {
                if (img.src === imageUrl) {
                    targetImg = img;
                }
            });

            if (!targetImg) {
                const allImages = document.querySelectorAll("img");
                for (const img of allImages) {
                    if (img.naturalWidth < 200 || img.naturalHeight < 200) continue;
                    let parent = img.parentElement;
                    for (let i = 0; i < 15 && parent; i++) {
                        if ((parent.innerText || "").includes("PROMPT " + promptNumber)) {
                            targetImg = img;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                    if (targetImg) break;
                }
            }

            if (!targetImg) {
                console.log("[Dotti] Imagem nao encontrada na pagina para PROMPT", promptNumber);
                return { success: false, error: "image_not_found" };
            }

            console.log("[Dotti] Imagem encontrada para PROMPT", promptNumber);

            // 2. Scroll a imagem para o centro da tela
            targetImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(1200);

            // 3. Hover e busca de botao - 3 tentativas
            let downloadBtn = null;

            for (let attempt = 1; attempt <= 3; attempt++) {
                hoverElementFull(targetImg);
                await sleep(1000 + attempt * 500);

                let result = findClosestDownloadButton(targetImg);
                if (result) {
                    downloadBtn = result.btn;
                    console.log("[Dotti] Botao de download de imagem encontrado na tentativa #" + attempt);
                    break;
                }
            }

            if (!downloadBtn) {
                console.log("[Dotti] Botao de download de imagem nao encontrado para PROMPT", promptNumber);
                await closeOpenMenus();
                return { success: false, error: "download_btn_not_found" };
            }

            // 4. Se resolucao e 1024 (padrao), apenas clicar no download direto
            if (resolution === "1024") {
                reactClick(downloadBtn);
                console.log("[Dotti] Download direto de imagem (1K) para PROMPT", promptNumber);
                await sleep(500);
                return { success: true, method: "direct" };
            }

            // 5. Para 2K, clicar no botao de download e procurar menu de resolucao
            reactClick(downloadBtn);
            await sleep(1500);

            // 6. Procurar opcoes de resolucao no menu/dropdown
            let targetOption = null;

            // Helper para procurar opcoes de upscale em menus visiveis
            function findUpscaleOption() {
                const menuItems = document.querySelectorAll(
                    '[role="menuitem"], [role="option"], [role="listbox"] *, ' +
                    'li, [class*="menu"] *, [class*="dropdown"] *, [class*="popover"] *'
                );

                for (const item of menuItems) {
                    const text = (item.textContent || "").toLowerCase();
                    // Ignorar itens com texto muito longo (nao sao opcoes de menu)
                    if (text.length > 80) continue;
                    // Procurar opcoes de upscale/2K
                    if (text.includes("2k") || text.includes("2048") ||
                        text.includes("upscale") || text.includes("aprimorad") ||
                        text.includes("enhance") || text.includes("alta qualidade") ||
                        text.includes("high quality") || text.includes("high res") ||
                        text.includes("higher") || text.includes("melhor")) {
                        return item.closest("button") || item.closest("[role='menuitem']") ||
                               item.closest("li") || item;
                    }
                }
                return null;
            }

            await waitFor(() => {
                targetOption = findUpscaleOption();
                return !!targetOption;
            }, 5000, 300);

            // 7. Se nao encontrou opcao, tentar fallback: ultima opcao do menu (como no video)
            if (!targetOption) {
                const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"]');
                if (menuItems.length >= 2) {
                    // Ultima opcao geralmente e a de maior resolucao
                    targetOption = menuItems[menuItems.length - 1];
                    console.log("[Dotti] Usando ultima opcao do menu como upscale:", targetOption.textContent?.trim());
                }
            }

            // 8. Se ainda nao encontrou menu, tentar o botao "more options" (tres pontos)
            if (!targetOption) {
                console.log("[Dotti] Menu de download sem opcoes de upscale. Tentando botao 'more options'...");
                await closeOpenMenus();
                await sleep(500);

                // Re-hover para garantir que botoes aparecem
                hoverElementFull(targetImg);
                await sleep(1500);

                const moreResult = findClosestMoreButton(targetImg);
                if (moreResult) {
                    console.log("[Dotti] Botao 'more options' encontrado (dist:", Math.round(moreResult.dist), "px)");
                    reactClick(moreResult.btn);
                    await sleep(1500);

                    await waitFor(() => {
                        targetOption = findUpscaleOption();
                        return !!targetOption;
                    }, 5000, 300);

                    if (!targetOption) {
                        const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"]');
                        for (const item of menuItems) {
                            const text = (item.textContent || "").toLowerCase();
                            if (text.includes("download") || text.includes("baixar") ||
                                text.includes("save") || text.includes("salvar")) {
                                targetOption = item;
                                console.log("[Dotti] Usando opcao de download do menu 'more':", text);
                                break;
                            }
                        }
                    }
                }
            }

            if (targetOption) {
                console.log("[Dotti] Opcao de resolucao encontrada:", targetOption.textContent?.trim());
                reactClick(targetOption);
                await sleep(1000);
                console.log("[Dotti] Upscale de imagem solicitado para PROMPT", promptNumber, "resolucao:", resolution);
                return { success: true, method: "upscale" };
            } else {
                console.log("[Dotti] Nenhuma opcao de upscale encontrada - download padrao para PROMPT", promptNumber);
                // Tentar download direto como fallback
                await closeOpenMenus();
                await sleep(500);
                hoverElementFull(targetImg);
                await sleep(1000);
                const dlResult = findClosestDownloadButton(targetImg);
                if (dlResult) {
                    reactClick(dlResult.btn);
                    console.log("[Dotti] Fallback: download direto clicado para PROMPT", promptNumber);
                }
                return { success: true, method: "direct_fallback" };
            }

        } catch (e) {
            console.error("[Dotti] Erro no download de imagem:", e);
            await closeOpenMenus();
            return { success: false, error: e.message };
        }
    }

    // ============================================
    // v2.1.0: SET OUTPUTS PER PROMPT
    // Encontra o controle de quantidade no Flow e define o valor desejado
    // Suporta: React custom components, dropdowns, segmented buttons, sliders
    // ============================================

    // Flag para o fetch intercept saber a quantidade desejada
    let _dottiDesiredOutputCount = 0;
    let _fetchInterceptRequested = false;

    async function setOutputsPerPrompt(targetCount) {
        targetCount = parseInt(targetCount) || 1;
        if (targetCount < 1 || targetCount > 4) targetCount = 1;
        console.log("[Dotti DOM] Definindo outputs per prompt =", targetCount);

        try {
            // === FASE 1: Tentar via combobox "Respostas por comando" no dialog aberto ===
            let success = await tryResponsesCombobox(targetCount);
            if (success) return true;

            // === FASE 2: Abrir settings e tentar o combobox ===
            const settingsBtn = findSettingsButton();
            if (settingsBtn) {
                console.log("[Dotti DOM] Abrindo settings...");
                reactClick(settingsBtn);
                await sleep(1500);

                success = await tryResponsesCombobox(targetCount);
                if (success) {
                    // Fechar dialog de settings
                    pressEscape();
                    await sleep(300);
                    return true;
                }

                // Fallback: tentar estrategias DOM genericas
                success = await trySetOutputsDOM(targetCount);
                if (success) {
                    pressEscape();
                    await sleep(300);
                    return true;
                }

                pressEscape();
                await sleep(300);
            }

            // === FASE 3: Fetch intercept como fallback definitivo ===
            console.log("[Dotti DOM] Estrategias DOM falharam. Ativando fetch intercept para count=" + targetCount);
            _dottiDesiredOutputCount = targetCount;
            requestFetchIntercept(targetCount);
            return true;

        } catch (e) {
            console.error("[Dotti DOM] Erro ao definir outputs:", e);
            return false;
        }
    }

    // Estrategia principal: encontrar combobox "Respostas por comando" / "Responses per prompt"
    // Estrutura do Flow: [role="dialog"] > div > button[role="combobox"] contendo span com label
    async function tryResponsesCombobox(targetCount) {
        // Labels conhecidos para o campo de quantidade (PT e EN)
        const labelPatterns = ["respostas por comando", "responses per prompt", "responses per command",
            "respuestas por comando", "outputs per prompt", "results per prompt"];

        // Procurar o combobox dentro de um dialog ou em qualquer lugar visivel
        const comboboxes = document.querySelectorAll('button[role="combobox"]');
        let targetCombobox = null;

        for (const cb of comboboxes) {
            if (cb.offsetParent === null) continue;
            const cbText = stripAccents((cb.textContent || "").toLowerCase().trim());
            if (labelPatterns.some(p => cbText.includes(p))) {
                targetCombobox = cb;
                break;
            }
        }

        // Fallback: procurar por span com label e subir ate o combobox
        if (!targetCombobox) {
            for (const span of document.querySelectorAll('span')) {
                if (span.offsetParent === null) continue;
                const spanText = stripAccents((span.textContent || "").toLowerCase().trim());
                if (labelPatterns.some(p => spanText.includes(p))) {
                    // Subir ate encontrar o combobox pai
                    const cb = span.closest('button[role="combobox"]') ||
                        span.closest('[role="combobox"]') ||
                        span.parentElement?.closest('button[role="combobox"]');
                    if (cb) {
                        targetCombobox = cb;
                        break;
                    }
                }
            }
        }

        if (!targetCombobox) {
            console.log("[Dotti DOM] Combobox 'Respostas por comando' nao encontrado");
            return false;
        }

        console.log("[Dotti DOM] Combobox encontrado:", targetCombobox.textContent?.trim()?.substring(0, 50));

        // Clicar no combobox para abrir o dropdown
        reactClick(targetCombobox);
        await sleep(800);

        // Procurar as opcoes que apareceram (role="option" ou role="listbox" > children)
        const options = document.querySelectorAll('[role="option"], [role="listbox"] [role="option"]');
        console.log("[Dotti DOM] Opcoes do dropdown:", options.length);

        if (options.length === 0) {
            // Tentar alternativa: procurar listbox e seus filhos diretos
            const listbox = document.querySelector('[role="listbox"]');
            if (listbox) {
                const listItems = listbox.children;
                for (const item of listItems) {
                    const itemText = (item.textContent || "").trim();
                    if (itemText === String(targetCount) || itemText.startsWith(String(targetCount))) {
                        console.log("[Dotti DOM] Item de listbox selecionado:", itemText);
                        reactClick(item);
                        await sleep(400);
                        return true;
                    }
                }
            }

            // Tentar procurar qualquer novo elemento visivel com o numero
            await sleep(400);
            const allVisible = document.querySelectorAll('*');
            for (const el of allVisible) {
                if (el.offsetParent === null || el.childElementCount > 0) continue;
                const text = (el.textContent || "").trim();
                if (text === String(targetCount)) {
                    const clickable = el.closest('[role="option"]') || el.closest('[role="menuitem"]') ||
                        el.closest('button') || el.closest('li') || el;
                    console.log("[Dotti DOM] Opcao encontrada por texto:", text, clickable.tagName);
                    reactClick(clickable);
                    await sleep(400);
                    return true;
                }
            }

            console.log("[Dotti DOM] Nenhuma opcao encontrada no dropdown");
            pressEscape();
            await sleep(300);
            return false;
        }

        // Clicar na opcao com o valor desejado
        for (const opt of options) {
            const optText = (opt.textContent || "").trim();
            if (optText === String(targetCount) || optText.startsWith(String(targetCount) + " ") ||
                optText.startsWith(String(targetCount) + "\t")) {
                console.log("[Dotti DOM] Opcao selecionada:", optText);
                reactClick(opt);
                await sleep(400);
                return true;
            }
        }

        console.log("[Dotti DOM] Opcao " + targetCount + " nao encontrada entre", options.length, "opcoes");
        pressEscape();
        await sleep(300);
        return false;
    }

    function pressEscape() {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    // Coletar todos os elementos visiveis cujo texto direto eh exatamente "1", "2", "3" ou "4"
    function collectVisibleNumbers() {
        const results = [];
        for (const el of document.querySelectorAll('button, div, span, a, label, [role], td, li')) {
            if (el.offsetParent === null) continue;
            // Texto direto (exclui texto de filhos)
            let directText = '';
            for (const child of el.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) directText += child.textContent;
            }
            directText = directText.trim();
            if (directText.length === 0 || directText.length > 2) continue;
            const num = parseInt(directText);
            if (isNaN(num) || num < 1 || num > 4) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) continue;
            results.push({ el, num, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 });
        }
        return results;
    }

    // Encontrar cluster de elementos numerados proximos (segmented buttons, chips, etc)
    function findNumberCluster(candidates) {
        if (!candidates || candidates.length < 2) return null;
        let bestCluster = null;
        for (const seed of candidates) {
            const nearby = candidates.filter(c => Math.hypot(c.cx - seed.cx, c.cy - seed.cy) < 300);
            // Deduplicar por numero
            const byNum = new Map();
            nearby.forEach(c => { if (!byNum.has(c.num)) byNum.set(c.num, c); });
            const unique = [...byNum.values()];
            if (unique.length >= 2 && (!bestCluster || unique.length > bestCluster.length)) {
                bestCluster = unique;
            }
        }
        if (bestCluster) {
            console.log("[Dotti DOM] Cluster numerico: [" + bestCluster.map(c => c.num).join(', ') + "]");
        }
        return bestCluster;
    }

    // Estrategias DOM para definir outputs
    async function trySetOutputsDOM(targetCount) {
        // --- Estrategia 1: input[type=range] visivel ---
        for (const slider of document.querySelectorAll('input[type="range"]')) {
            if (slider.offsetParent === null) continue;
            const min = parseInt(slider.min) || 0;
            const max = parseInt(slider.max) || 100;
            if (min >= 0 && max >= 2 && max <= 8) {
                const setVal = String(Math.min(Math.max(targetCount, min), max));
                console.log("[Dotti DOM] Range input: min=" + min + " max=" + max + " -> " + setVal);
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSetter.call(slider, setVal);
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                slider.dispatchEvent(new Event('change', { bubbles: true }));
                triggerReact(slider, setVal);
                await sleep(200);
                return true;
            }
        }

        // --- Estrategia 2: [role=slider] visivel ---
        for (const slider of document.querySelectorAll('[role="slider"]')) {
            if (slider.offsetParent === null) continue;
            const min = parseInt(slider.getAttribute("aria-valuemin")) || 0;
            const max = parseInt(slider.getAttribute("aria-valuemax")) || 100;
            if (min >= 0 && max >= 2 && max <= 8) {
                const setVal = Math.min(Math.max(targetCount, min), max);
                console.log("[Dotti DOM] ARIA slider: min=" + min + " max=" + max + " -> " + setVal);
                const rect = slider.getBoundingClientRect();
                const ratio = max > min ? (setVal - min) / (max - min) : 0;
                const x = rect.left + rect.width * 0.05 + (rect.width * 0.9) * ratio;
                const y = rect.top + rect.height / 2;
                for (const evt of ["pointerdown", "pointermove", "pointerup"]) {
                    slider.dispatchEvent(new PointerEvent(evt, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
                    await sleep(50);
                }
                slider.setAttribute("aria-valuenow", String(setVal));
                triggerReact(slider, setVal);
                await sleep(200);
                return true;
            }
        }

        // --- Estrategia 3: Cluster de elementos numerados (React divs/spans/buttons) ---
        // Encontra grupo de elementos visiveis com numeros 1-4 proximos entre si
        const visibleNums = collectVisibleNumbers();
        const cluster = findNumberCluster(visibleNums);
        if (cluster) {
            const target = cluster.find(c => c.num === targetCount);
            if (target) {
                console.log("[Dotti DOM] Clicando numero " + targetCount + " no cluster");
                // Tentar clicar no ancestral mais proximo que pareca interativo
                const clickTarget = target.el.closest('button') ||
                    target.el.closest('[role="radio"]') ||
                    target.el.closest('[role="option"]') ||
                    target.el.closest('[role="tab"]') ||
                    target.el.closest('[role="button"]') ||
                    target.el;
                reactClick(clickTarget);
                // Tambem clicar no proprio elemento se diferente
                if (clickTarget !== target.el) reactClick(target.el);
                await sleep(400);
                return true;
            }
        }

        // --- Estrategia 4: Stepper (botoes - / + com numero entre eles) ---
        const stepper = findStepper();
        if (stepper) {
            let attempts = 0;
            while (attempts < 10) {
                const currentVal = parseInt(stepper.valueEl.textContent?.trim());
                if (isNaN(currentVal) || currentVal === targetCount) break;
                if (currentVal > targetCount && stepper.minusBtn) reactClick(stepper.minusBtn);
                else if (currentVal < targetCount && stepper.plusBtn) reactClick(stepper.plusBtn);
                else break;
                await sleep(400);
                attempts++;
            }
            const finalVal = parseInt(stepper.valueEl.textContent?.trim());
            console.log("[Dotti DOM] Stepper: " + finalVal + " (target: " + targetCount + ")");
            if (finalVal === targetCount) return true;
        }

        // --- Estrategia 5: Select nativo ---
        for (const sel of document.querySelectorAll('select')) {
            if (sel.offsetParent === null) continue;
            const numOpts = [...sel.options].filter(o => {
                const v = parseInt(o.value);
                return !isNaN(v) && v >= 1 && v <= 8;
            });
            if (numOpts.length >= 2) {
                console.log("[Dotti DOM] Select nativo com " + numOpts.length + " opcoes");
                const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
                nativeSetter.call(sel, String(targetCount));
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                triggerReact(sel, targetCount);
                await sleep(200);
                return true;
            }
        }

        return false;
    }

    // Estrategia de dropdown: clicar em elemento com numero para abrir opcoes, depois selecionar
    async function tryDropdownPattern(targetCount) {
        console.log("[Dotti DOM] Tentando padrao dropdown...");

        // Coletar todos os elementos folha visiveis com numeros 1-4
        const numberEls = [];
        for (const el of document.querySelectorAll('*')) {
            if (el.offsetParent === null || el.childElementCount > 0) continue;
            const text = (el.textContent || '').trim();
            if (text.length > 2) continue;
            const num = parseInt(text);
            if (isNaN(num) || num < 1 || num > 4) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) continue;
            numberEls.push({ el, num });
        }

        if (numberEls.length === 0) {
            console.log("[Dotti DOM] Nenhum elemento numerico encontrado para dropdown");
            return false;
        }

        console.log("[Dotti DOM] " + numberEls.length + " elementos numericos, tentando dropdown...");

        // Para cada elemento numerico, tentar clicar para ver se abre dropdown
        for (const numEl of numberEls) {
            // Contar opcoes antes de clicar
            const beforeOptions = document.querySelectorAll('[role="option"], [role="menuitem"], [role="listbox"] > *').length;
            const beforeVisible = collectVisibleNumbers().length;

            // Clicar no elemento ou ancestral clicavel
            const clickTarget = numEl.el.closest('[role="button"]') ||
                numEl.el.closest('[role="combobox"]') ||
                numEl.el.closest('[aria-haspopup]') ||
                numEl.el.closest('button') ||
                numEl.el;
            reactClick(clickTarget);
            await sleep(800);

            // Verificar se apareceram novas opcoes (dropdown abriu)
            const afterOptions = document.querySelectorAll('[role="option"], [role="menuitem"]');
            if (afterOptions.length > beforeOptions) {
                // Dropdown abriu! Procurar opcao com o valor desejado
                for (const opt of afterOptions) {
                    const optText = (opt.textContent || '').trim();
                    if (optText === String(targetCount) || optText.startsWith(targetCount + ' ') || optText.startsWith(targetCount + '\t')) {
                        console.log("[Dotti DOM] Opcao de dropdown encontrada:", optText);
                        reactClick(opt);
                        await sleep(400);
                        return true;
                    }
                }
            }

            // Verificar se apareceram NOVOS elementos numericos (pode ser dropdown custom)
            const afterVisible = collectVisibleNumbers();
            if (afterVisible.length > beforeVisible) {
                const newNums = afterVisible.filter(a => !numberEls.some(b => b.el === a.el));
                const target = newNums.find(n => n.num === targetCount);
                if (target) {
                    console.log("[Dotti DOM] Novo elemento numerico no dropdown:", target.num);
                    const tgt = target.el.closest('[role]') || target.el.closest('button') || target.el;
                    reactClick(tgt);
                    if (tgt !== target.el) reactClick(target.el);
                    await sleep(400);
                    return true;
                }
            }

            // Fechar dropdown e tentar proximo
            pressEscape();
            await sleep(300);
        }

        return false;
    }

    // Encontrar botao de settings/config no prompt area
    function findSettingsButton() {
        const allBtns = document.querySelectorAll('button');
        // 1. Por icone material (settings, tune, sliders, more_vert)
        for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            const icon = btn.querySelector('i, span.material-icons, span.material-symbols-outlined, [class*="icon"]');
            const iconText = (icon?.textContent || "").trim().toLowerCase();
            if (iconText === "settings" || iconText === "tune" || iconText === "sliders" ||
                iconText === "more_vert" || iconText === "more_horiz") {
                return btn;
            }
        }
        // 2. Por aria-label / title
        for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
            const title = (btn.getAttribute("title") || "").toLowerCase();
            if (ariaLabel.includes("setting") || ariaLabel.includes("config") || ariaLabel.includes("option") ||
                title.includes("setting") || title.includes("config") || title.includes("option")) {
                return btn;
            }
        }
        return null;
    }

    // Encontrar stepper (- num +)
    function findStepper() {
        for (const btn of document.querySelectorAll('button')) {
            if (btn.offsetParent === null) continue;
            const icon = btn.querySelector('i, [class*="icon"]');
            const iconText = (icon?.textContent || "").trim().toLowerCase();
            if (iconText === 'remove' || iconText === 'remove_circle' || iconText === 'remove_circle_outline' ||
                btn.textContent?.trim() === '-' || btn.textContent?.trim() === '\u2212') {
                const parent = btn.parentElement;
                if (!parent) continue;
                for (const sib of parent.children) {
                    if (sib === btn) continue;
                    const val = parseInt(sib.textContent?.trim());
                    if (!isNaN(val) && val >= 1 && val <= 10) {
                        let plusBtn = null;
                        for (const sib2 of parent.children) {
                            if (sib2 === btn || sib2 === sib) continue;
                            const icon2 = sib2.querySelector?.('i, [class*="icon"]');
                            const iconText2 = (icon2?.textContent || "").trim().toLowerCase();
                            if (iconText2 === 'add' || iconText2 === 'add_circle' || iconText2 === 'add_circle_outline' ||
                                sib2.textContent?.trim() === '+') {
                                plusBtn = sib2;
                                break;
                            }
                        }
                        return { minusBtn: btn, plusBtn, valueEl: sib };
                    }
                }
            }
        }
        return null;
    }

    // Trigger React change handlers em um elemento
    function triggerReact(element, value) {
        const keys = Object.keys(element).filter(k => k.startsWith("__reactProps") || k.startsWith("__reactFiber"));
        for (const key of keys) {
            const props = element[key];
            if (props?.onChange) {
                try { props.onChange(typeof value === 'number' ? value : { target: { value: String(value), valueAsNumber: value } }); } catch (e) {}
            }
            if (props?.memoizedProps?.onChange) {
                try { props.memoizedProps.onChange(value); } catch (e) {}
            }
            if (props?.onValueChange) {
                try { props.onValueChange(value); } catch (e) {}
            }
        }
    }

    // Solicitar ao background.js que injete fetch interceptor via chrome.scripting.executeScript
    function requestFetchIntercept(count) {
        if (_fetchInterceptRequested) {
            // Ja instalado, apenas atualizar o count via custom event
            window.dispatchEvent(new CustomEvent('__dotti_set_output_count', { detail: { count } }));
            return;
        }
        _fetchInterceptRequested = true;
        try {
            chrome.runtime.sendMessage({
                action: "INJECT_FETCH_INTERCEPT",
                count: count
            });
        } catch (e) {
            console.log("[Dotti DOM] Erro ao solicitar fetch intercept:", e);
        }
    }

    // ============================================
    // CLIPBOARD HELPER
    // ============================================

    function copyToClipboard(text) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
            console.log("[Dotti] Copiado:", text);
        } catch (e) {
            console.error("[Dotti] Erro ao copiar:", e);
        }
        document.body.removeChild(textarea);
    }

    // ============================================
    // MESSAGE HANDLING (FROM BACKGROUND)
    // ============================================

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        console.log("[Dotti DOM] Received:", message.action);

        switch (message.action) {
            // v2.0.1: Video URL interceptado pelo webRequest no background.js
            // Captura videos no nivel de REDE - nao depende do DOM (resolve virtual scrolling)
            case "VIDEO_URL_INTERCEPTED":
                (() => {
                    const { url, timestamp, contentType } = message.data || {};
                    if (!url) return;

                    // v2.0.1 FIX: Dedup por UUID - URLs de storage.googleapis.com contem UUID unico
                    // Isso garante que cada video fisico e detectado exatamente 1 vez
                    if (isVideoAlreadyDetected(url)) {
                        console.log("[Dotti] webRequest video DEDUP (ja detectado):", url.substring(0, 80));
                        return;
                    }

                    _videoDetCounter++;
                    console.log("[Dotti] webRequest video #" + _videoDetCounter,
                        "url:", url.substring(0, 100));

                    // v2.0.1 FIX: NAO tentar extrair prompt text do DOM.
                    // Com zoom out, a busca por PROMPT no DOM e fragil (parents contem
                    // texto de multiplos cards). Enviar SEM_PROMPT e deixar o panel
                    // atribuir sequencialmente ao proximo prompt pendente.
                    notifyPanel({
                        type: "VIDEO_DETECTED",
                        data: {
                            url: url,
                            prompt: "SEM_PROMPT",
                            timestamp: timestamp || Date.now(),
                            urls: { default: url, "720": url },
                            width: 0,
                            height: 0,
                            source: "network"
                        }
                    });
                })();
                sendResponse({ success: true });
                break;

            case "TOGGLE_PANEL":
                togglePanel();
                sendResponse({ success: true });
                break;

            case "EXECUTE_PROMPT_DOM":
                executePrompt(message.data).then(result => {
                    sendResponse(result);
                });
                return true;

            case "PROMPT_STARTING":
                notifyPanel({ type: "PROMPT_STARTING", data: message.data });
                sendResponse({ success: true });
                break;

            case "PROMPT_RESULT":
                notifyPanel({ type: "PROMPT_RESULT", data: message.data });
                sendResponse({ success: true });
                break;

            case "BATCH_PAUSE":
                notifyPanel({ type: "BATCH_PAUSE", data: message.data });
                sendResponse({ success: true });
                break;

            case "QUEUE_COMPLETE":
                notifyPanel({ type: "QUEUE_COMPLETE", data: message.data });
                sendResponse({ success: true });
                break;

            case "QUEUE_ERROR":
                notifyPanel({ type: "QUEUE_ERROR", data: message.data });
                sendResponse({ success: true });
                break;

            case "LICENSE_ERROR":
                notifyPanel({ type: "LICENSE_ERROR", data: message.data });
                sendResponse({ success: true });
                break;

            // v2.1.0: Preparar para proximo prompt - limpar galeria/elementos
            case "PREPARE_FOR_NEXT_PROMPT":
                (async () => {
                    try {
                        await clearElements();
                        // Limpar imagens detectadas para evitar cross-matching
                        window.DOTTI_DETECTED_IMAGES = {};
                        console.log("[Dotti DOM] Galeria limpa para proximo prompt");
                        sendResponse({ success: true });
                    } catch (e) {
                        console.error("[Dotti DOM] Erro ao limpar galeria:", e);
                        sendResponse({ success: false });
                    }
                })();
                return true;

            // v2.2.1: Refresh de URL do video - re-ler src atual do elemento video
            case "REFRESH_VIDEO_URL":
                (async () => {
                    try {
                        const promptNum = message.promptNumber;
                        const oldUrl = message.oldUrl;
                        let freshUrl = null;

                        // Procurar video pelo prompt text no DOM
                        document.querySelectorAll("video").forEach(video => {
                            if (freshUrl) return;
                            const src = video.src || video.querySelector("source")?.src;
                            if (!src) return;
                            const isFlow = src.includes("storage.googleapis.com") || src.includes("labs.google") || src.includes("googleusercontent.com");
                            if (!isFlow) return;
                            // Verificar se este video pertence ao prompt (25 niveis)
                            let parent = video.parentElement;
                            for (let i = 0; i < 25 && parent; i++) {
                                const text = parent.innerText || "";
                                const match = text.match(/PROMPT\s*(\d+)/i);
                                if (match && parseInt(match[1]) === promptNum) {
                                    freshUrl = src;
                                    return;
                                }
                                parent = parent.parentElement;
                            }
                        });

                        // Fallback: se nao achou por prompt, usar o video com URL mais parecida
                        if (!freshUrl && oldUrl) {
                            const baseOld = oldUrl.split("?")[0];
                            document.querySelectorAll("video").forEach(video => {
                                const src = video.src || video.querySelector("source")?.src;
                                if (src && src.split("?")[0] === baseOld) {
                                    freshUrl = src;
                                }
                            });
                        }

                        sendResponse({ success: !!freshUrl, url: freshUrl || oldUrl });
                    } catch (e) {
                        sendResponse({ success: false, url: message.oldUrl });
                    }
                })();
                return true;

            // v2.0.0: Download interceptado pelo background - encaminhar ao painel
            case "DOWNLOAD_INTERCEPTED":
                notifyPanel({ type: "DOWNLOAD_INTERCEPTED", data: message.data });
                sendResponse({ success: true });
                break;

            // v2.1.0: Definir outputs per prompt (chamado pelo background no primeiro prompt)
            case "SET_OUTPUTS_PER_PROMPT":
                (async () => {
                    try {
                        const count = message.count || 1;
                        console.log("[Dotti DOM] SET_OUTPUTS_PER_PROMPT count=" + count);
                        const success = await setOutputsPerPrompt(count);
                        sendResponse({ success });
                    } catch (e) {
                        console.error("[Dotti DOM] SET_OUTPUTS_PER_PROMPT erro:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            // v2.0.0: Garantir modo correto antes de cada prompt
            // ORDEM CRITICA: 1) aba projeto  2) dropdown modo  3) esperar UI  4) output count
            case "ENSURE_IMAGE_MODE":
                (async () => {
                    try {
                        console.log("[Dotti ENSURE] === INICIO ENSURE_IMAGE_MODE ===");

                        // PASSO 1: Garantir aba do projeto = Images
                        console.log("[Dotti ENSURE] PASSO 1: switchFlowProjectTab('image')...");
                        const tabResult = await switchFlowProjectTab("image");
                        console.log("[Dotti ENSURE] PASSO 1 resultado:", tabResult);
                        await sleep(1500);

                        // PASSO 2: Verificar/trocar dropdown de modo
                        console.log("[Dotti ENSURE] PASSO 2: verificando dropdown...");
                        const inImage = isDropdownInImageMode();
                        console.log("[Dotti ENSURE] PASSO 2 inImage:", inImage);
                        if (!inImage) {
                            console.log("[Dotti ENSURE] PASSO 2: chamando switchToImageMode()...");
                            const ok = await switchToImageMode();
                            console.log("[Dotti ENSURE] PASSO 2 switchToImageMode:", ok);
                            await sleep(1500);
                        }

                        // PASSO 3: Fechar qualquer dropdown/popover residual
                        console.log("[Dotti ENSURE] PASSO 3: fechando popovers...");
                        document.body.click();
                        await sleep(800);
                        document.body.click();
                        await sleep(500);

                        console.log("[Dotti ENSURE] === FIM ENSURE_IMAGE_MODE - enviando resposta ===");
                        sendResponse({ success: true, switched: !inImage });
                    } catch (e) {
                        console.error("[Dotti ENSURE] ERRO:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            case "ENSURE_VIDEO_MODE":
                (async () => {
                    try {
                        console.log("[Dotti ENSURE] === INICIO ENSURE_VIDEO_MODE ===");

                        // PASSO 1: Garantir aba do projeto = Videos
                        console.log("[Dotti ENSURE] PASSO 1: switchFlowProjectTab('video')...");
                        const tabResult = await switchFlowProjectTab("video");
                        console.log("[Dotti ENSURE] PASSO 1 resultado:", tabResult);
                        await sleep(1500);

                        // PASSO 2: Verificar/trocar dropdown de modo
                        console.log("[Dotti ENSURE] PASSO 2: verificando dropdown...");
                        const inImage = isDropdownInImageMode();
                        console.log("[Dotti ENSURE] PASSO 2 inImage:", inImage);
                        if (inImage) {
                            console.log("[Dotti ENSURE] PASSO 2: chamando switchToVideoMode()...");
                            const ok = await switchToVideoMode();
                            console.log("[Dotti ENSURE] PASSO 2 switchToVideoMode:", ok);
                            await sleep(1500);
                        }

                        // PASSO 3: Fechar qualquer dropdown/popover residual
                        console.log("[Dotti ENSURE] PASSO 3: fechando popovers...");
                        document.body.click();
                        await sleep(500);

                        console.log("[Dotti ENSURE] === FIM ENSURE_VIDEO_MODE - enviando resposta ===");
                        sendResponse({ success: true, switched: inImage });
                    } catch (e) {
                        console.error("[Dotti ENSURE] ERRO:", e);
                        sendResponse({ success: false, error: e.message });
                    }
                })();
                return true;

            default:
                sendResponse({ success: false, error: "unknown_action" });
        }

        return true;
    });

    // ============================================
    // MESSAGE FROM PANEL (IFRAME)
    // ============================================

    window.addEventListener("message", async (event) => {
        let isFromPanel = false;
        const iframe = findPanelIframe();
        if (iframe && event.source === iframe.contentWindow) {
            isFromPanel = true;
        }
        if (!isFromPanel) return;

        const { type, data } = event.data;

        switch (type) {
            case "START_QUEUE":
                chrome.runtime.sendMessage({
                    action: "START_QUEUE",
                    prompts: data.prompts,
                    settings: data.settings,
                    tabId: await getCurrentTabId(),
                    mediaType: data.mediaType
                });
                break;

            case "PAUSE_QUEUE":
                chrome.runtime.sendMessage({ action: "PAUSE_QUEUE" });
                break;

            case "RESUME_QUEUE":
                chrome.runtime.sendMessage({ action: "RESUME_QUEUE" });
                break;

            case "CANCEL_QUEUE":
                chrome.runtime.sendMessage({ action: "CANCEL_QUEUE" });
                break;

            case "GET_QUEUE_STATUS":
                const status = await chrome.runtime.sendMessage({ action: "GET_QUEUE_STATUS" });
                notifyPanel({ type: "QUEUE_STATUS", data: status });
                break;

            case "GET_DETECTED_VIDEOS":
                notifyPanel({ type: "DETECTED_VIDEOS_LIST", data: window.DOTTI_DETECTED_VIDEOS });
                break;

            case "CLEAR_DETECTED_VIDEOS":
                window.DOTTI_DETECTED_VIDEOS = {};
                _videoDetCounter = 0;
                _detectedVideoUuids = new Set();
                _detectedVideoUrls = new Set();
                // Limpar tambem as URLs interceptadas no background.js
                chrome.runtime.sendMessage({ action: "CLEAR_INTERCEPTED_VIDEOS" }).catch(() => {});
                break;

            case "START_VIDEO_DETECTION":
                startVideoDetection();
                break;

            // v2.0.0: Deteccao de imagens
            case "GET_DETECTED_IMAGES":
                notifyPanel({ type: "DETECTED_IMAGES_LIST", data: window.DOTTI_DETECTED_IMAGES });
                break;

            case "CLEAR_DETECTED_IMAGES":
                window.DOTTI_DETECTED_IMAGES = {};
                break;

            case "START_IMAGE_DETECTION":
                startImageDetection();
                break;

            // v2.1.0: SWITCH_FLOW_TAB - Flow nao tem mais tabs/dropdown (UI unificada)
            case "SWITCH_FLOW_TAB":
                console.log("[Dotti DOM] SWITCH_FLOW_TAB ignorado - Flow UI unificada, sem tabs/dropdown");
                break;

            // v2.0.0: Mudar modo do Flow para imagem/video
            case "SWITCH_TO_IMAGE_MODE":
                switchToImageMode().then(success => {
                    notifyPanel({
                        type: "MODE_SWITCHED",
                        data: { mode: "image", success }
                    });
                });
                break;

            case "SWITCH_TO_VIDEO_MODE":
                switchToVideoMode().then(success => {
                    notifyPanel({
                        type: "MODE_SWITCHED",
                        data: { mode: "video", success }
                    });
                });
                break;

            // v2.0.0: Gerar imagem para um prompt (FILA SEQUENCIAL)
            case "GENERATE_IMAGE":
                enqueueDownload({
                    type: "generate_image",
                    videoUrl: data.videoUrl,
                    promptNumber: data.promptNumber,
                    resolution: data.resolution
                });
                break;

            // v2.0.0: Upscale e download de video via menu do Flow (FILA SEQUENCIAL)
            case "UPSCALE_AND_DOWNLOAD":
                enqueueDownload({
                    type: "video",
                    videoUrl: data.videoUrl,
                    promptNumber: data.promptNumber,
                    resolution: data.resolution
                });
                break;

            // v2.0.0: Upscale e download de imagem via UI do Flow (FILA SEQUENCIAL)
            case "UPSCALE_AND_DOWNLOAD_IMAGE":
                enqueueDownload({
                    type: "image",
                    imageUrl: data.imageUrl,
                    promptNumber: data.promptNumber,
                    resolution: data.resolution
                });
                break;

            // v2.1.0: Definir outputs per prompt
            case "SET_OUTPUTS_PER_PROMPT":
                setOutputsPerPrompt(data?.count || 1).then(success => {
                    notifyPanel({
                        type: "OUTPUTS_SET",
                        data: { success }
                    });
                });
                break;

            // v2.2.1: Refresh URL de video antes do download
            case "REFRESH_VIDEO_URL":
                (() => {
                    const promptNum = data?.promptNumber;
                    const oldUrl = data?.oldUrl;
                    let freshUrl = null;

                    document.querySelectorAll("video").forEach(video => {
                        if (freshUrl) return;
                        const src = video.src || video.querySelector("source")?.src;
                        if (!src) return;
                        const isFlow = src.includes("storage.googleapis.com") || src.includes("labs.google") || src.includes("googleusercontent.com");
                        if (!isFlow) return;
                        let parent = video.parentElement;
                        for (let i = 0; i < 25 && parent; i++) {
                            const text = parent.innerText || "";
                            const match = text.match(/PROMPT\s*(\d+)/i);
                            if (match && parseInt(match[1]) === promptNum) {
                                freshUrl = src;
                                return;
                            }
                            parent = parent.parentElement;
                        }
                    });

                    if (!freshUrl && oldUrl) {
                        const baseOld = oldUrl.split("?")[0];
                        document.querySelectorAll("video").forEach(video => {
                            const src = video.src || video.querySelector("source")?.src;
                            if (src && src.split("?")[0] === baseOld) freshUrl = src;
                        });
                    }

                    notifyPanel({
                        type: "REFRESH_VIDEO_URL_RESULT",
                        data: { url: freshUrl || oldUrl, promptNumber: promptNum }
                    });
                })();
                break;

            case "COPY_TEXT":
                copyToClipboard(data);
                break;

            // v2.0.1: Zoom out REAL do navegador (como Ctrl+-)
            // Muda o viewport - Flow renderiza mais cards, nao so encolhe
            case "SET_PAGE_ZOOM":
                (async () => {
                    const zoomLevel = data?.zoom || 1;
                    console.log("[Dotti] Requesting browser zoom:", zoomLevel);
                    try {
                        await chrome.runtime.sendMessage({
                            action: "SET_PAGE_ZOOM",
                            zoom: zoomLevel
                        });
                        console.log("[Dotti] Browser zoom applied:", zoomLevel);

                        const panel = document.getElementById(PANEL_ID);
                        const btn = document.getElementById(TOGGLE_BTN_ID);

                        if (zoomLevel < 1) {
                            // Counter-zoom: extensao mantem tamanho fixo
                            const counterZoom = String(1 / zoomLevel);
                            if (panel) panel.style.zoom = counterZoom;
                            if (btn) btn.style.zoom = counterZoom;
                        } else {
                            // Limpar counter-zoom ao restaurar
                            if (panel) { panel.style.zoom = ""; panel.style.width = ""; panel.style.height = ""; panel.style.transform = ""; }
                            if (btn) { btn.style.zoom = ""; btn.style.transform = ""; }
                        }
                    } catch (e) {
                        console.log("[Dotti] Browser zoom error:", e.message);
                    }
                    setTimeout(scanForVideos, 1000);
                    setTimeout(scanForImages, 1000);
                })();
                break;

            // v2.0.1: Scroll automatico para forcar virtual scroll a renderizar mais cards
            case "SCROLL_TO_REVEAL_MEDIA":
                (async () => {
                    // Encontrar TODOS os containers scrollaveis e scrollar CADA um
                    const scrollTargets = document.querySelectorAll('[role="main"], main, [class*="scroll"], [class*="result"], [class*="content"], [class*="grid"], [class*="list"]');
                    let scrolled = false;

                    // Scrollar todos os containers que tem overflow
                    scrollTargets.forEach(container => {
                        if (container.scrollHeight > container.clientHeight + 100) {
                            const currentScroll = container.scrollTop;
                            const maxScroll = container.scrollHeight - container.clientHeight;
                            if (currentScroll < maxScroll - 50) {
                                container.scrollTop = Math.min(currentScroll + 800, maxScroll);
                            } else {
                                container.scrollTop = 0; // Ciclar de volta ao topo
                            }
                            scrolled = true;
                        }
                    });

                    // Sempre scrollar a window tambem (redundante mas garante cobertura)
                    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                    if (window.scrollY < maxScroll - 50) {
                        window.scrollBy(0, 800);
                    } else {
                        window.scrollTo(0, 0);
                    }

                    // Scan imediato + segundo scan apos 500ms para pegar cards recem-renderizados
                    scanForVideos();
                    scanForImages();
                    setTimeout(scanForVideos, 500);
                    setTimeout(scanForImages, 500);
                })();
                break;
        }
    });

    async function getCurrentTabId() {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({ action: "GET_ACTIVE_TAB" }, response => {
                resolve(response?.tabId);
            });
        });
    }

    // ============================================
    // INITIALIZATION
    // ============================================

    function init() {
        if (!window.location.href.includes("labs.google")) return;

        if (!document.getElementById(TOGGLE_BTN_ID)) {
            toggleBtn = document.createElement("div");
            toggleBtn.id = TOGGLE_BTN_ID;
            toggleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4 14H11L10 22L19 10H12L13 2Z" fill="#FFD700" stroke="#FFD700" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            toggleBtn.title = "LetzFlow Sender";
            toggleBtn.addEventListener("click", togglePanel);
            document.body.appendChild(toggleBtn);
        }

        // Auto-abrir sidebar ao carregar a pagina
        if (!document.getElementById(PANEL_ID)) {
            createPanel();
            isPanelVisible = true;
            document.documentElement.classList.add("dotti-sidebar-open");
            if (toggleBtn) {
                toggleBtn.classList.add("active");
                toggleBtn.classList.remove("sidebar-closed");
            }
        }

        startVideoDetection();
        startImageDetection();

        // Ao carregar o Flow: abrir novo projeto (se veio do icone)
        // Flow UI unificada - nao precisa mais trocar tabs/dropdown
        setTimeout(async () => {
            try {
                // Verificar se deve abrir novo projeto automaticamente
                const flags = await chrome.runtime.sendMessage({ action: "GET_AUTO_NEW_PROJECT" });
                if (flags?.autoNewProject) {
                    console.log("[Dotti DOM] Auto novo projeto...");
                    await autoClickNewProject();
                }
            } catch (e) {
                console.log("[Dotti DOM] Init setup erro:", e.message);
            }
        }, 3000);

        console.log("[LetzFlow Sender] v2.1.0 ready");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
