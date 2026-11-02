/**
 * Apply screenshot gate — intercept Submit / Apply / Send clicks.
 * Dialog always opens on the top frame (full browser viewport), never
 * clipped inside a nested iframe. Child frames request the top dialog
 * via the extension background.
 */
(function () {
  if (window.__devora21ApplyGate) return;
  window.__devora21ApplyGate = true;

  const IS_TOP = window === window.top;
  const ACTION_RE = /\b(submit|apply|send)\b/i;
  const DIALOG_ID = "devora21-apply-gate-dialog";
  const STYLE_ID = "devora21-apply-gate-style";

  let enabled = true;
  let dialogOpen = false;
  let uploadInFlight = false;
  /** When set, the next matching click is allowed through once. */
  let passThroughEl = null;
  let lastUploadKey = "";
  /** Ignore duplicate pointerdown→click for the same gesture. */
  let lastGateAt = 0;
  /** Active paste listener while dialog is open (removed on close). */
  let pasteHandler = null;
  let lastPasteFingerprint = "";
  let lastPasteAt = 0;
  /**
   * In the frame that intercepted the click: element to resume after
   * the top-frame dialog finishes.
   */
  let pendingTargetEl = null;
  /** Top-frame only: accept a File into the open dialog (paste / relay). */
  let activeAcceptImage = null;

  function newClientCaptureId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `cap_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function controlLabel(el) {
    if (!(el instanceof HTMLElement)) return "";
    const parts = [
      el.innerText,
      el.textContent,
      el.getAttribute("aria-label"),
      el.getAttribute("title"),
      el.getAttribute("value"),
      el.getAttribute("name"),
      el.getAttribute("data-testid"),
    ];
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function isClickable(el) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    if (tag === "BUTTON" || tag === "A") return true;
    if (tag === "INPUT") {
      const t = String(el.type || "").toLowerCase();
      return t === "submit" || t === "button" || t === "image";
    }
    if (el.getAttribute("role") === "button") return true;
    if (el.onclick != null) return true;
    const style = window.getComputedStyle(el);
    return style.cursor === "pointer";
  }

  function resolveActionControl(fromEvent) {
    let n = fromEvent;
    for (let i = 0; i < 8 && n; i += 1) {
      if (n instanceof HTMLElement && isClickable(n) && ACTION_RE.test(controlLabel(n))) {
        return n;
      }
      n = n.parentElement;
    }
    if (fromEvent instanceof Element) {
      const closest = fromEvent.closest(
        "button, a, input[type=submit], input[type=button], [role=button]"
      );
      if (
        closest instanceof HTMLElement &&
        ACTION_RE.test(controlLabel(closest))
      ) {
        return closest;
      }
    }
    return null;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${DIALOG_ID}-backdrop {
  position: fixed; inset: 0; z-index: 2147483646;
  width: 100vw; height: 100vh; height: 100dvh;
  background: rgba(8, 12, 10, 0.55);
  display: flex; align-items: center; justify-content: center;
  font-family: "Segoe UI", system-ui, sans-serif;
  box-sizing: border-box;
}
#${DIALOG_ID} {
  width: min(420px, calc(100vw - 32px));
  max-height: min(90vh, 90dvh);
  overflow: auto;
  background: #1a221f; color: #f2f7f4;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px; padding: 20px; box-shadow: 0 18px 50px rgba(0,0,0,0.45);
  box-sizing: border-box;
}
#${DIALOG_ID} h2 { margin: 0 0 8px; font-size: 17px; font-weight: 650; }
#${DIALOG_ID} p { margin: 0 0 14px; font-size: 13px; color: #8fa399; line-height: 1.45; }
#${DIALOG_ID} .field { margin-bottom: 14px; }
#${DIALOG_ID} label { display: block; font-size: 12px; margin-bottom: 6px; color: #b7c7be; }
#${DIALOG_ID} .hint {
  margin: 0 0 10px; font-size: 12px; color: #8fa399; line-height: 1.4;
}
#${DIALOG_ID} .hint kbd,
#${DIALOG_ID} .paste-zone kbd {
  display: inline-block; padding: 1px 6px; border-radius: 4px;
  background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
  font-size: 11px; font-family: inherit; color: #d7e6dd;
}
#${DIALOG_ID} .paste-zone {
  margin: 0 0 12px; padding: 14px 12px; border-radius: 10px;
  border: 1px dashed rgba(62, 207, 142, 0.45);
  background: rgba(62, 207, 142, 0.06);
  color: #b7c7be; font-size: 12px; line-height: 1.45; text-align: center;
  cursor: text; outline: none;
}
#${DIALOG_ID} .paste-zone:focus {
  border-color: #3ecf8e;
  background: rgba(62, 207, 142, 0.12);
  color: #f2f7f4;
}
#${DIALOG_ID} input[type=file] {
  width: 100%; font-size: 12px; color: #f2f7f4;
}
#${DIALOG_ID} .btn-paste {
  width: 100%; margin-bottom: 10px;
  background: rgba(62, 207, 142, 0.16); color: #3ecf8e;
  border: 1px solid rgba(62, 207, 142, 0.35) !important;
}
#${DIALOG_ID} .preview {
  margin-top: 8px; max-height: min(50vh, 360px); border-radius: 8px;
  overflow: auto; overscroll-behavior: contain;
  background: #101614; display: none;
  border: 1px solid rgba(255,255,255,0.08);
}
#${DIALOG_ID} .preview img {
  display: block; width: 100%; height: auto; max-width: none;
  vertical-align: top;
}
#${DIALOG_ID} .source {
  margin-top: 6px; font-size: 11px; color: #6f857a; display: none;
}
#${DIALOG_ID} .actions { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
#${DIALOG_ID} button {
  border: 0; border-radius: 10px; padding: 10px 12px; font-size: 13px;
  font-weight: 600; cursor: pointer;
}
#${DIALOG_ID} .btn-primary { background: #3ecf8e; color: #062416; }
#${DIALOG_ID} .btn-primary:disabled { opacity: 0.55; cursor: not-allowed; }
#${DIALOG_ID} .btn-muted { background: rgba(255,255,255,0.08); color: #f2f7f4; }
#${DIALOG_ID} .btn-ghost { background: transparent; color: #8fa399; font-weight: 500; }
#${DIALOG_ID} .err { color: #f07178; font-size: 12px; min-height: 16px; margin: 0 0 8px; }
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function closeDialog() {
    if (pasteHandler) {
      document.removeEventListener("paste", pasteHandler, true);
      pasteHandler = null;
    }
    activeAcceptImage = null;
    const backdrop = document.getElementById(`${DIALOG_ID}-backdrop`);
    if (backdrop) backdrop.remove();
    dialogOpen = false;
    uploadInFlight = false;
  }

  function dataUrlToFile(dataUrl, name, mimeType) {
    const raw = String(dataUrl || "");
    const comma = raw.indexOf(",");
    const header = comma >= 0 ? raw.slice(0, comma).toLowerCase() : "";
    const b64 = comma >= 0 ? raw.slice(comma + 1) : raw;
    let mime = String(mimeType || "").toLowerCase();
    if (!mime) {
      const m = header.match(/data:([^;,]+)/);
      mime = m ? m[1] : "image/png";
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const ext =
      mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
    const safeMime =
      ext === "jpg" ? "image/jpeg" : mime.startsWith("image/") ? mime : "image/png";
    return new File([bytes], name || `clipboard-screenshot.${ext}`, {
      type: safeMime,
      lastModified: Date.now(),
    });
  }

  function rememberPasteFingerprint(file) {
    const fingerprint = `${file.type}|${file.size}|${file.lastModified || 0}`;
    const now = Date.now();
    if (fingerprint === lastPasteFingerprint && now - lastPasteAt < 800) {
      return false;
    }
    lastPasteFingerprint = fingerprint;
    lastPasteAt = now;
    return true;
  }

  async function readClipboardImageFile() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== "function") {
      throw new Error(
        "Clipboard API unavailable. Click the green paste box, then press Ctrl+V (⌘V on Mac)."
      );
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const types = item.types || [];
      const preferred =
        types.find((t) => /^image\/(png|jpeg|jpg)$/i.test(t)) ||
        types.find((t) => /^image\//i.test(t));
      if (!preferred) continue;
      const blob = await item.getType(preferred);
      return clipboardImageToFile(blob, preferred);
    }
    throw new Error(
      "Clipboard has no image. Press Win+Shift+S (or Mac screenshot), copy it, then paste here."
    );
  }

  function isAllowedImageFile(file) {
    if (!file) return { ok: false, error: "No image selected." };
    const type = String(file.type || "").toLowerCase();
    const name = String(file.name || "");
    if (/^image\/(jpeg|jpg|png)$/i.test(type) || /\.(jpe?g|png)$/i.test(name)) {
      return { ok: true };
    }
    if (/^image\//i.test(type)) {
      return { ok: false, error: "Use a JPEG or PNG screenshot (not " + type + ")." };
    }
    return { ok: false, error: "Use a JPEG or PNG screenshot." };
  }

  function clipboardImageToFile(blob, mimeHint) {
    const type = String(blob.type || mimeHint || "image/png").toLowerCase();
    const ext = type.includes("jpeg") || type.includes("jpg") ? "jpg" : "png";
    const safeType =
      ext === "jpg" ? "image/jpeg" : type.startsWith("image/") ? type : "image/png";
    return new File([blob], `clipboard-screenshot.${ext}`, {
      type: safeType,
      lastModified: Date.now(),
    });
  }

  function extractImageFromClipboardEvent(ev) {
    const cd = ev.clipboardData;
    if (!cd) return null;
    if (cd.files && cd.files.length) {
      for (const f of cd.files) {
        if (f && /^image\//i.test(f.type || "")) return f;
      }
    }
    if (cd.items && cd.items.length) {
      for (let i = 0; i < cd.items.length; i += 1) {
        const item = cd.items[i];
        if (!item || item.kind !== "file") continue;
        if (!/^image\//i.test(item.type || "")) continue;
        const blob = item.getAsFile();
        if (blob) return clipboardImageToFile(blob, item.type);
      }
    }
    return null;
  }

  /** SPA / site DOM wipes can remove our backdrop while dialogOpen stays true. */
  function syncDialogState() {
    if (!dialogOpen) return true;
    const backdrop = document.getElementById(`${DIALOG_ID}-backdrop`);
    if (backdrop) return true;
    dialogOpen = false;
    uploadInFlight = false;
    return false;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read screenshot file"));
      reader.readAsDataURL(file);
    });
  }

  async function uploadScreenshot(file, meta = {}) {
    const dataBase64 = await fileToDataUrl(file);
    const clientCaptureId = newClientCaptureId();
    const tabUrl = String(meta.tabUrl || location.href || "").trim();
    const pageTitle = String(meta.pageTitle || document.title || "").trim();
    const uploadKey = `${tabUrl}|${file.name}|${file.size}|${file.lastModified}`;
    if (uploadKey === lastUploadKey) {
      return { ok: true, deduped: true };
    }
    const res = await chrome.runtime.sendMessage({
      type: "UPLOAD_APPLY_SCREENSHOT",
      clientCaptureId,
      tabUrl,
      pageTitle: pageTitle || undefined,
      capturedAt: Date.now(),
      dataBase64,
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Upload failed");
    }
    lastUploadKey = uploadKey;
    return res;
  }

  function findAssociatedForm(el) {
    if (!(el instanceof HTMLElement)) return null;
    if (
      (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) &&
      el.form
    ) {
      return el.form;
    }
    return el.closest("form");
  }

  /** Prefer a still-connected control; SPA re-renders may detach the original node. */
  function resolveLiveControl(el) {
    if (el instanceof HTMLElement && el.isConnected) return el;
    const candidates = document.querySelectorAll(
      "button, a, input[type=submit], input[type=button], input[type=image], [role=button]"
    );
    for (const c of candidates) {
      if (
        c instanceof HTMLElement &&
        isClickable(c) &&
        ACTION_RE.test(controlLabel(c))
      ) {
        return c;
      }
    }
    return el instanceof HTMLElement ? el : null;
  }

  /**
   * Fire the original control once (pass-through the gate).
   * After Upload & Continue / Skip we always attempt the real action.
   * @returns {boolean} true if native validation blocked (only when respectValidation)
   */
  function replayClick(el, opts = {}) {
    const live = resolveLiveControl(el);
    if (!(live instanceof HTMLElement)) return false;

    // Default FALSE: Upload&Continue and Skip must always invoke the site action.
    const respectValidation = opts.respectValidation === true;
    const form = findAssociatedForm(live);

    let blockedByValidation = false;
    if (
      respectValidation &&
      form &&
      typeof form.checkValidity === "function" &&
      !form.checkValidity()
    ) {
      blockedByValidation = true;
      try {
        form.reportValidity();
      } catch {
        // ignore
      }
      return true;
    }

    passThroughEl = live;
    pendingTargetEl = live;
    lastGateAt = 0;

    try {
      const tag = live.tagName;
      const type = String(live.type || "").toLowerCase();
      const isSubmitControl =
        type === "submit" ||
        (tag === "BUTTON" && type !== "button" && type !== "reset");

      if (form && isSubmitControl && typeof form.requestSubmit === "function") {
        try {
          if (
            live instanceof HTMLButtonElement ||
            live instanceof HTMLInputElement
          ) {
            form.requestSubmit(live);
          } else {
            form.requestSubmit();
          }
        } catch {
          live.click();
        }
      } else {
        live.click();
      }
    } finally {
      // Keep pass-through long enough for sync + microtask site handlers.
      setTimeout(() => {
        if (passThroughEl === live) passThroughEl = null;
        lastGateAt = 0;
      }, 300);
    }
    return blockedByValidation;
  }

  function sendResumeToFrame(sourceFrameId, action, respectValidation) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "APPLY_GATE_RESUME",
            targetFrameId: sourceFrameId,
            action,
            respectValidation: Boolean(respectValidation),
          },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(res || { ok: true });
          }
        );
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  /**
   * Ask top frame to show the dialog (used from iframes).
   */
  function requestTopDialog(meta) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "APPLY_GATE_OPEN_DIALOG",
            tabUrl: meta.tabUrl,
            pageTitle: meta.pageTitle,
          },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(res || { ok: false });
          }
        );
      } catch (err) {
        resolve({ ok: false, error: String(err?.message || err) });
      }
    });
  }

  /**
   * Dialog UI — only ever mounted in the top frame (full tab viewport).
   * @param {HTMLElement|null} targetEl local target when click was in top frame
   * @param {object} opts
   */
  function openDialog(targetEl, opts = {}) {
    if (!IS_TOP) {
      // Safety: never paint dialog inside a nested frame.
      return;
    }
    syncDialogState();
    if (dialogOpen) {
      if (opts.notice) {
        const err = document.getElementById(`${DIALOG_ID}-err`);
        if (err) err.textContent = opts.notice;
      }
      return;
    }
    ensureStyles();

    const remoteFrameId =
      opts.sourceFrameId != null && Number(opts.sourceFrameId) > 0
        ? Number(opts.sourceFrameId)
        : null;
    const captureTabUrl = String(opts.tabUrl || location.href || "").trim();
    const capturePageTitle = String(
      opts.pageTitle || document.title || ""
    ).trim();

    const isMac =
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
    const pasteShortcut = isMac ? "⌘V" : "Ctrl+V";

    const backdrop = document.createElement("div");
    backdrop.id = `${DIALOG_ID}-backdrop`;
    backdrop.innerHTML = `
      <div id="${DIALOG_ID}" role="dialog" aria-modal="true" aria-labelledby="${DIALOG_ID}-title">
        <h2 id="${DIALOG_ID}-title">Did you take the screenshot?</h2>
        <p>Add a JPEG or PNG screenshot of this page, then continue. Required for Submit / Apply / Send.</p>
        <div class="paste-zone" id="${DIALOG_ID}-paste-zone" tabindex="0">
          Click here, then press <kbd>${pasteShortcut}</kbd> to paste a screenshot from the clipboard
        </div>
        <button type="button" class="btn-paste" id="${DIALOG_ID}-paste-btn">Paste from clipboard</button>
        <div class="field">
          <label for="${DIALOG_ID}-file">Or choose a file</label>
          <input id="${DIALOG_ID}-file" type="file" accept="image/jpeg,image/png,image/*" />
          <div class="preview" id="${DIALOG_ID}-preview"><img alt="Preview" /></div>
          <div class="source" id="${DIALOG_ID}-source"></div>
        </div>
        <p class="err" id="${DIALOG_ID}-err"></p>
        <div class="actions">
          <button type="button" class="btn-primary" id="${DIALOG_ID}-upload">Upload &amp; Continue</button>
          <button type="button" class="btn-muted" id="${DIALOG_ID}-cancel">Cancel</button>
          <button type="button" class="btn-ghost" id="${DIALOG_ID}-skip">This is not an Apply Page</button>
        </div>
      </div>
    `;
    const host = document.documentElement || document.body;
    if (!host) return;
    dialogOpen = true;
    host.appendChild(backdrop);

    const dialogEl = backdrop.querySelector(`#${DIALOG_ID}`);
    const pasteZone = backdrop.querySelector(`#${DIALOG_ID}-paste-zone`);
    const btnPaste = backdrop.querySelector(`#${DIALOG_ID}-paste-btn`);
    const fileInput = backdrop.querySelector(`#${DIALOG_ID}-file`);
    const preview = backdrop.querySelector(`#${DIALOG_ID}-preview`);
    const previewImg = preview.querySelector("img");
    const sourceEl = backdrop.querySelector(`#${DIALOG_ID}-source`);
    const errEl = backdrop.querySelector(`#${DIALOG_ID}-err`);
    const btnUpload = backdrop.querySelector(`#${DIALOG_ID}-upload`);
    const btnCancel = backdrop.querySelector(`#${DIALOG_ID}-cancel`);
    const btnSkip = backdrop.querySelector(`#${DIALOG_ID}-skip`);

    // Steal focus from the iframe so Ctrl/Cmd+V hits this document.
    setTimeout(() => {
      try {
        window.focus();
        pasteZone.focus();
      } catch {
        try {
          dialogEl.focus();
        } catch {
          // ignore
        }
      }
    }, 0);

    if (opts.notice) {
      errEl.textContent = opts.notice;
    }

    let selectedFile = null;
    let uploadedOk = Boolean(opts.allowContinueWithoutFile);
    if (uploadedOk) {
      btnUpload.textContent = "Continue";
    }

    function clearPreview() {
      preview.style.display = "none";
      previewImg.removeAttribute("src");
      sourceEl.style.display = "none";
      sourceEl.textContent = "";
    }

    function showPreview(file, sourceLabel) {
      const url = URL.createObjectURL(file);
      previewImg.onload = () => URL.revokeObjectURL(url);
      previewImg.onerror = () => {
        URL.revokeObjectURL(url);
        clearPreview();
        errEl.textContent = "Could not preview that image. Try another JPEG or PNG.";
      };
      previewImg.src = url;
      preview.style.display = "block";
      sourceEl.textContent = sourceLabel || "";
      sourceEl.style.display = sourceLabel ? "block" : "none";
    }

    function acceptImage(file, sourceLabel) {
      const check = isAllowedImageFile(file);
      if (!check.ok) {
        errEl.textContent = check.error;
        return false;
      }
      errEl.textContent = "";
      selectedFile = file;
      uploadedOk = false;
      btnUpload.textContent = "Upload & Continue";
      showPreview(file, sourceLabel);
      return true;
    }

    activeAcceptImage = (file, sourceLabel) => acceptImage(file, sourceLabel);

    async function finishLocalOrRemote(action) {
      // Never hold Upload&Continue / Skip for HTML5 validity — always fire
      // the original control; the site shows its own field errors if any.
      if (remoteFrameId != null) {
        const res = await sendResumeToFrame(remoteFrameId, action, false);
        return res;
      }
      if (action === "cancel") {
        pendingTargetEl = null;
        return { ok: true, blocked: false };
      }
      const el = targetEl || pendingTargetEl;
      if (action === "skip" || action === "continue") {
        const blocked = replayClick(el, { respectValidation: false });
        return { ok: true, blocked };
      }
      return { ok: true, blocked: false };
    }

    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) {
        selectedFile = null;
        clearPreview();
        return;
      }
      acceptImage(file, "From file");
    });

    btnPaste.addEventListener("click", async () => {
      if (uploadInFlight) return;
      errEl.textContent = "";
      btnPaste.disabled = true;
      const prev = btnPaste.textContent;
      btnPaste.textContent = "Reading clipboard…";
      try {
        const file = await readClipboardImageFile();
        if (!rememberPasteFingerprint(file)) return;
        acceptImage(file, "Pasted from clipboard");
      } catch (err) {
        errEl.textContent = String(err?.message || err);
      } finally {
        btnPaste.disabled = false;
        btnPaste.textContent = prev;
      }
    });

    pasteZone.addEventListener("click", () => {
      try {
        pasteZone.focus();
      } catch {
        // ignore
      }
    });

    pasteHandler = (ev) => {
      if (!dialogOpen || uploadInFlight) return;
      const backdropEl = document.getElementById(`${DIALOG_ID}-backdrop`);
      if (!backdropEl) return;

      const file = extractImageFromClipboardEvent(ev);
      if (!file) {
        const t = ev.target;
        const inDialog = t instanceof Node && backdropEl.contains(t);
        if (inDialog) {
          errEl.textContent =
            "Clipboard has no image. Copy a screenshot first (Win+Shift+S), then paste.";
        }
        return;
      }

      ev.preventDefault();
      ev.stopPropagation();
      if (!rememberPasteFingerprint(file)) return;
      acceptImage(file, `Pasted with ${pasteShortcut}`);
    };
    document.addEventListener("paste", pasteHandler, true);

    btnCancel.addEventListener("click", async () => {
      if (uploadInFlight) return;
      closeDialog();
      await finishLocalOrRemote("cancel");
    });

    btnSkip.addEventListener("click", async (ev) => {
      if (uploadInFlight) return;
      ev.preventDefault();
      ev.stopPropagation();
      closeDialog();
      setTimeout(() => {
        void finishLocalOrRemote("skip");
      }, 0);
    });

    btnUpload.addEventListener("click", async () => {
      if (uploadInFlight) return;
      errEl.textContent = "";
      const file = selectedFile;
      if (!file && !uploadedOk) {
        errEl.textContent = `Choose a file or paste a screenshot (${pasteShortcut}) first.`;
        return;
      }
      if (file) {
        const check = isAllowedImageFile(file);
        if (!check.ok) {
          errEl.textContent = check.error;
          return;
        }
      }
      uploadInFlight = true;
      btnUpload.disabled = true;
      btnUpload.textContent = file ? "Uploading…" : "Continuing…";
      try {
        if (file) {
          await uploadScreenshot(file, {
            tabUrl: captureTabUrl,
            pageTitle: capturePageTitle,
          });
          uploadedOk = true;
        }
        // Close overlay first so the page/iframe can receive the real action.
        closeDialog();
        await new Promise((r) => setTimeout(r, 40));
        const res = await finishLocalOrRemote("continue");
        if (res && res.ok === false) {
          // Re-open so the user can retry continue without re-selecting a file.
          openDialog(targetEl, {
            sourceFrameId: remoteFrameId,
            tabUrl: captureTabUrl,
            pageTitle: capturePageTitle,
            allowContinueWithoutFile: true,
            notice:
              res.error ||
              "Could not continue the original Submit action. Click Continue to try again.",
          });
        }
      } catch (err) {
        uploadInFlight = false;
        btnUpload.disabled = false;
        btnUpload.textContent = uploadedOk ? "Continue" : "Upload & Continue";
        errEl.textContent = String(err?.message || err);
      }
    });
  }

  async function beginGate(el) {
    pendingTargetEl = el;
    if (IS_TOP) {
      openDialog(el, {
        tabUrl: location.href,
        pageTitle: document.title || "",
      });
      return;
    }
    // Nested frame: show dialog on the top viewport, keep pending click here.
    const res = await requestTopDialog({
      tabUrl: location.href,
      pageTitle: document.title || "",
    });
    if (!res?.ok) {
      // Fallback: still do not paint inside a tiny iframe — cancel pending.
      pendingTargetEl = null;
      console.warn("[Devora21] Could not open apply-gate dialog on top frame:", res?.error);
    }
  }

  function onPointerCapture(ev) {
    if (!enabled) return;
    if (ev.type === "pointerdown" && ev.button != null && ev.button !== 0) return;

    // Dialog only lives in top frame; child frames never have a local backdrop.
    if (IS_TOP && syncDialogState()) {
      const backdrop = document.getElementById(`${DIALOG_ID}-backdrop`);
      if (backdrop) {
        if (backdrop.contains(ev.target)) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
        return;
      }
    }

    const el = resolveActionControl(ev.target);
    if (!el) return;

    if (
      passThroughEl &&
      (el === passThroughEl ||
        passThroughEl.contains(el) ||
        el.contains(passThroughEl))
    ) {
      return;
    }

    const now = Date.now();
    if (now - lastGateAt < 400) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      return;
    }
    lastGateAt = now;

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    void beginGate(el);
  }

  document.addEventListener("pointerdown", onPointerCapture, true);
  document.addEventListener("click", onPointerCapture, true);

  /**
   * If focus is still in an iframe, Ctrl+V lands here — forward the image
   * into the top-frame dialog.
   */
  document.addEventListener(
    "paste",
    (ev) => {
      if (!enabled || IS_TOP) return;
      const file = extractImageFromClipboardEvent(ev);
      if (!file) return;
      if (!rememberPasteFingerprint(file)) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      void fileToDataUrl(file)
        .then((dataBase64) =>
          chrome.runtime.sendMessage({
            type: "APPLY_GATE_PASTE_IMAGE",
            dataBase64,
            name: file.name,
            mimeType: file.type,
          })
        )
        .catch(() => {});
    },
    true
  );

  // Cross-frame dialog + resume (background relays with frameId).
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== "object") return undefined;

      if (msg.type === "APPLY_GATE_SHOW_DIALOG") {
        if (!IS_TOP) {
          sendResponse({ ok: false, error: "not top frame" });
          return false;
        }
        openDialog(null, {
          sourceFrameId: msg.sourceFrameId,
          tabUrl: msg.tabUrl,
          pageTitle: msg.pageTitle,
        });
        sendResponse({ ok: true });
        return false;
      }

      if (msg.type === "APPLY_GATE_ACCEPT_PASTE") {
        if (!IS_TOP || !dialogOpen || typeof activeAcceptImage !== "function") {
          sendResponse({ ok: false, error: "Dialog not open" });
          return false;
        }
        try {
          const file = dataUrlToFile(msg.dataBase64, msg.name, msg.mimeType);
          if (!rememberPasteFingerprint(file)) {
            sendResponse({ ok: true, deduped: true });
            return false;
          }
          const ok = activeAcceptImage(file, "Pasted from clipboard");
          sendResponse({ ok: Boolean(ok) });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        return false;
      }

      if (msg.type === "APPLY_GATE_RESUME") {
        const action = msg.action;
        if (action === "cancel") {
          pendingTargetEl = null;
          sendResponse({ ok: true, blocked: false });
          return false;
        }
        if (action === "skip" || action === "continue") {
          const el = resolveLiveControl(pendingTargetEl);
          if (!(el instanceof HTMLElement)) {
            sendResponse({
              ok: false,
              error: "No pending Submit / Apply / Send control to resume",
              blocked: false,
            });
            return false;
          }
          // Always invoke the original action after Upload&Continue / Skip.
          const blocked = replayClick(el, { respectValidation: false });
          sendResponse({ ok: true, blocked });
          return false;
        }
        sendResponse({ ok: false, error: "unknown action" });
        return false;
      }

      return undefined;
    });
  } catch {
    // ignore
  }

  try {
    chrome.storage.sync.get({ applyGateEnabled: true }, (data) => {
      enabled = data.applyGateEnabled !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes.applyGateEnabled) return;
      enabled = changes.applyGateEnabled.newValue !== false;
      if (!enabled && IS_TOP) closeDialog();
    });
  } catch {
    enabled = true;
  }
})();
