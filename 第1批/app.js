(() => {
  const cases = window.QUIZ_CASES || [];
  const security = window.QUIZ_SECURITY;
  const STORAGE_KEY = "case-drawer-private-used-v1";
  const HISTORY_KEY = "case-drawer-private-history-v1";
  const encoder = new TextEncoder();
  const AUTO_UNLOCK_KEY = "et2IkAL4PyYYy5FK8AZIeNDHurGKx3vVMChdJMuhhUs=";
  let cryptoKey = null;
  let currentQuestionUrl = null;
  let currentAnswerUrl = null;
  const packCache = new Map();

  const $ = (id) => document.getElementById(id);
  const lockScreen = $("lockScreen");
  const appShell = $("appShell");
  const unlockForm = $("unlockForm");
  const passwordInput = $("passwordInput");
  const lockMessage = $("lockMessage");
  const drawBtn = $("drawBtn");
  const revealBtn = $("revealBtn");
  const nextBtn = $("nextBtn");
  const resetBtn = $("resetBtn");
  const cacheBtn = $("cacheBtn");
  const noRepeat = $("noRepeat");
  const jumpInput = $("jumpInput");
  const jumpBtn = $("jumpBtn");
  const historySelect = $("historySelect");
  const summary = $("summary");
  const totalCount = $("totalCount");
  const usedCount = $("usedCount");
  const leftCount = $("leftCount");
  const caseTitle = $("caseTitle");
  const sourceMeta = $("sourceMeta");
  const questionState = $("questionState");
  const answerState = $("answerState");
  const questionImg = $("questionImg");
  const answerImg = $("answerImg");
  const questionPlaceholder = $("questionPlaceholder");
  const answerPlaceholder = $("answerPlaceholder");
  const answerFrame = $("answerFrame");
  const offlineStatus = $("offlineStatus");
  const cacheProgress = $("cacheProgress");

  let currentIndex = null;
  let answerVisible = false;
  let used = new Set(loadArray(STORAGE_KEY));
  let history = loadArray(HISTORY_KEY).filter((idx) => Number.isInteger(idx) && cases[idx]);

  function bytesFromBase64(text) {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  async function derivePasswordKey(password) {
    const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: bytesFromBase64(security.salt), iterations: security.iterations, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
  }

  async function loadEncryptedAsset(url) {
    const entry = window.QUIZ_ASSET_INDEX && window.QUIZ_ASSET_INDEX[url];
    if (!entry) {
      const response = await fetch(url);
      if (!response.ok) throw new Error("fetch failed");
      return response.arrayBuffer();
    }
    let packBytes = packCache.get(entry.pack);
    if (!packBytes) {
      const response = await fetch(entry.pack);
      if (!response.ok) throw new Error("pack fetch failed");
      const text = (await response.text()).trim();
      packBytes = bytesFromBase64(text);
      packCache.set(entry.pack, packBytes);
    }
    return packBytes.slice(entry.offset, entry.offset + entry.length).buffer;
  }

  async function decryptBytes(url, ivText) {
    const encrypted = await loadEncryptedAsset(url);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesFromBase64(ivText) }, cryptoKey, encrypted);
    return new Blob([plain], { type: "image/webp" });
  }

  async function verifyPassword(password) {
    const key = await derivePasswordKey(password);
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesFromBase64(security.verifierIv) }, key, bytesFromBase64(security.verifier));
    cryptoKey = key;
  }

  function loadArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...used]));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {}
  }

  function formatCaseTitle(item) {
    return `第${item.id}题`;
  }

  function updateStats() {
    const total = cases.length;
    const usedSize = used.size;
    totalCount.textContent = total;
    usedCount.textContent = usedSize;
    leftCount.textContent = Math.max(0, total - usedSize);
    summary.textContent = `${total} 题 · 已抽 ${usedSize} · 未抽 ${Math.max(0, total - usedSize)}`;
  }

  function updateHistory() {
    historySelect.innerHTML = "";
    if (!history.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "暂无记录";
      historySelect.appendChild(option);
      return;
    }
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "抽题记录";
    historySelect.appendChild(empty);
    for (const idx of history.slice().reverse()) {
      const item = cases[idx];
      const option = document.createElement("option");
      option.value = String(idx);
      option.textContent = `${formatCaseTitle(item)} · PDF第${item.pdfPage}页`;
      historySelect.appendChild(option);
    }
  }

  function showToast(text) {
    const old = document.querySelector(".toast");
    if (old) old.remove();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    window.setTimeout(() => toast.remove(), 2800);
  }

  function chooseRandomIndex() {
    const pool = cases.map((_, index) => index).filter((index) => !noRepeat.checked || !used.has(index));
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  async function setEncryptedImage(img, item, kind) {
    const oldUrl = kind === "question" ? currentQuestionUrl : currentAnswerUrl;
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    const blob = await decryptBytes(kind === "question" ? item.question : item.answer, kind === "question" ? item.questionIv : item.answerIv);
    const nextUrl = URL.createObjectURL(blob);
    img.src = nextUrl;
    if (kind === "question") currentQuestionUrl = nextUrl;
    else currentAnswerUrl = nextUrl;
  }

  async function loadCase(index, addToUsed) {
    const item = cases[index];
    if (!item) return;
    currentIndex = index;
    answerVisible = false;
    drawBtn.disabled = true;
    nextBtn.disabled = true;
    try {
      if (addToUsed) {
        used.add(index);
        history = history.filter((idx) => idx !== index);
        history.push(index);
        saveState();
      }
      caseTitle.textContent = formatCaseTitle(item);
      sourceMeta.textContent = `原PDF第 ${item.pdfPage} 页 · 原页题号 ${item.sourceNum}`;
      questionState.textContent = "正在解密";
      answerState.textContent = "未显示";
      questionImg.hidden = true;
      questionPlaceholder.hidden = false;
      questionPlaceholder.textContent = "正在解密题目...";
      answerImg.hidden = true;
      answerPlaceholder.hidden = false;
      answerPlaceholder.textContent = "点击“显示答案”";
      answerFrame.classList.add("locked");
      await setEncryptedImage(questionImg, item, "question");
      questionImg.hidden = false;
      questionPlaceholder.hidden = true;
      questionState.textContent = "已显示";
      revealBtn.disabled = false;
      drawBtn.textContent = "重新抽题";
      updateStats();
      updateHistory();
    } catch {
      showToast("解密题目失败，请确认网络或缓存状态。");
    } finally {
      drawBtn.disabled = false;
      nextBtn.disabled = false;
    }
  }

  async function revealAnswer() {
    if (currentIndex === null) return;
    const item = cases[currentIndex];
    revealBtn.disabled = true;
    answerPlaceholder.textContent = "正在解密答案...";
    try {
      await setEncryptedImage(answerImg, item, "answer");
      answerVisible = true;
      answerImg.hidden = false;
      answerPlaceholder.hidden = true;
      answerFrame.classList.remove("locked");
      answerState.textContent = "已显示";
    } catch {
      showToast("解密答案失败，请确认网络或缓存状态。");
      revealBtn.disabled = false;
    }
  }

  function drawCase() {
    const index = chooseRandomIndex();
    if (index === null) {
      showToast("不重复抽题已抽完，可以取消勾选或点击重置。");
      return;
    }
    loadCase(index, true);
  }

  function openByNumber() {
    const raw = jumpInput.value.trim();
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > cases.length) {
      showToast(`请输入 1 到 ${cases.length} 之间的题号。`);
      return;
    }
    loadCase(number - 1, true);
    jumpInput.value = "";
  }

  function resetAll() {
    used = new Set();
    history = [];
    currentIndex = null;
    answerVisible = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(HISTORY_KEY);
    } catch {}
    caseTitle.textContent = "未抽题";
    sourceMeta.textContent = "PDF 页码 -";
    questionState.textContent = "等待抽题";
    answerState.textContent = "未显示";
    questionImg.hidden = true;
    questionImg.removeAttribute("src");
    answerImg.hidden = true;
    answerImg.removeAttribute("src");
    questionPlaceholder.hidden = false;
    questionPlaceholder.textContent = "点击“抽取一题”";
    answerPlaceholder.hidden = false;
    answerPlaceholder.textContent = "点击“显示答案”";
    answerFrame.classList.add("locked");
    revealBtn.disabled = true;
    nextBtn.disabled = true;
    drawBtn.textContent = "抽取一题";
    updateStats();
    updateHistory();
  }

  async function cacheAllCases() {
    if (!("serviceWorker" in navigator)) {
      showToast("当前浏览器不支持离线缓存。");
      return;
    }
    cacheBtn.disabled = true;
    cacheProgress.hidden = false;
    cacheProgress.value = 0;
    const urls = (window.QUIZ_PACK_URLS && window.QUIZ_PACK_URLS.length) ? window.QUIZ_PACK_URLS : cases.flatMap((item) => [item.question, item.answer]);
    const total = urls.length;
    let done = 0;
    offlineStatus.textContent = `正在缓存加密题库 0/${total}`;
    for (const url of urls) {
      try { await fetch(url, { cache: "reload" }); } catch {}
      done += 1;
      if (done % 8 === 0 || done === total) {
        cacheProgress.value = Math.round((done / total) * 100);
        offlineStatus.textContent = `正在缓存加密题库 ${done}/${total}`;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    offlineStatus.textContent = "加密题库已缓存。之后断网打开仍需输入密码。";
    cacheBtn.disabled = false;
  }

  async function registerWorker() {
    if (!("serviceWorker" in navigator)) {
      offlineStatus.textContent = "当前浏览器不支持离线缓存。";
      cacheBtn.disabled = true;
      return;
    }
    try {
      await navigator.serviceWorker.register("service-worker.js");
      offlineStatus.textContent = "网站已支持离线；点击按钮可缓存加密题库。";
    } catch {
      offlineStatus.textContent = "离线缓存注册失败；在线抽题仍可使用。";
    }
  }

  async function autoUnlock() {
    if (lockMessage) lockMessage.textContent = "正在打开题库...";
    try {
      cryptoKey = await crypto.subtle.importKey("raw", bytesFromBase64(AUTO_UNLOCK_KEY), "AES-GCM", false, ["decrypt"]);
      lockScreen.hidden = true;
      appShell.hidden = false;
      updateStats();
      updateHistory();
      registerWorker();
    } catch {
      if (lockMessage) lockMessage.textContent = "打开失败，请刷新后重试。";
    }
  }

  autoUnlock();

  drawBtn.addEventListener("click", drawCase);
  nextBtn.addEventListener("click", drawCase);
  revealBtn.addEventListener("click", revealAnswer);
  resetBtn.addEventListener("click", resetAll);
  jumpBtn.addEventListener("click", openByNumber);
  cacheBtn.addEventListener("click", cacheAllCases);
  jumpInput.addEventListener("keydown", (event) => { if (event.key === "Enter") openByNumber(); });
  historySelect.addEventListener("change", () => {
    const index = Number(historySelect.value);
    if (Number.isInteger(index) && cases[index]) loadCase(index, false);
    historySelect.value = "";
  });
  document.addEventListener("keydown", (event) => {
    if (appShell.hidden) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (currentIndex === null) drawCase();
    else if (!answerVisible) revealAnswer();
    else drawCase();
  });
})();