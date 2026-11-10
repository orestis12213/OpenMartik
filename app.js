(() => {
  const $ = (id) => document.getElementById(id);

  const form = $("videoForm");
  const promptEl = $("prompt");
  const modeInput = $("mode");
  const imageField = $("imageField");
  const imageInput = $("image");
  const textMode = $("textMode");
  const imageMode = $("imageMode");
  const styleInput = $("selectedStyle");
  const customStyleField = $("customStyleField");
  const customStyleEl = $("customStyle");
  const durationInput = $("duration");
  const customDurationField = $("customDurationField");
  const customDurationEl = $("customDuration");
  const generateBtn = $("generateBtn");
  const errorBox = $("errorBox");
  const preview = $("preview");

  const WIDTH = 1280;
  const HEIGHT = 720;
  const FPS = 30;
  const FRAME_CONCURRENCY = 3;

  let busy = false;
  let lastVideoUrl = null;

  // ---------- Form controls ----------
  function setMode(mode) {
    modeInput.value = mode;
    textMode.classList.toggle("active", mode === "text");
    imageMode.classList.toggle("active", mode === "image");
    imageField.style.display = mode === "image" ? "block" : "none";
  }
  textMode.addEventListener("click", () => setMode("text"));
  imageMode.addEventListener("click", () => setMode("image"));

  const styleCards = document.querySelectorAll(".style-card");
  function selectStyle(card) {
    styleCards.forEach((c) => {
      c.classList.toggle("active", c === card);
      c.setAttribute("aria-pressed", String(c === card));
    });
    styleInput.value = card.dataset.style;
    const isCustom = card.dataset.style === "your-idea";
    customStyleField.classList.toggle("hidden", !isCustom);
    if (isCustom) customStyleEl.focus();
  }
  styleCards.forEach((card) => {
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-pressed", String(card.classList.contains("active")));
    card.addEventListener("click", () => selectStyle(card));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectStyle(card);
      }
    });
  });

  const secOptions = document.querySelectorAll(".sec-option");
  secOptions.forEach((btn) => {
    btn.addEventListener("click", () => {
      secOptions.forEach((b) => b.classList.toggle("active", b === btn));
      durationInput.value = btn.dataset.sec;
      const isCustom = btn.dataset.sec === "custom";
      customDurationField.classList.toggle("hidden", !isCustom);
      if (isCustom) customDurationEl.focus();
    });
  });

  function getDuration() {
    if (durationInput.value !== "custom") return Number(durationInput.value);
    return Number(customDurationEl.value);
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.toggle("hidden", !msg);
  }

  // ---------- API helpers ----------
  async function postJson(url, payload) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new Error("Network error — please check your connection and try again.");
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("The server returned an unexpected response. Please try again.");
    }
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  async function withRetry(fn, attempts = 2) {
    let err;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        err = e;
        if (/safety|describe|Duration|style/i.test(e.message)) break;
        await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      }
    }
    throw err;
  }

  // ---------- Image helpers ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not load an image."));
      img.src = src;
    });
  }

  /** Re-encode any image as a compact JPEG data URL (for uploads + continuity references). */
  async function toJpegDataUrl(src, maxW = 1024) {
    const img = typeof src === "string" ? await loadImage(src) : src;
    const scale = Math.min(1, maxW / img.naturalWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.86);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("Could not read the uploaded image."));
      r.readAsDataURL(file);
    });
  }

  // ---------- Preview states ----------
  function renderProgress(title, detail, pct, thumbs = []) {
    preview.innerHTML = `
      <div class="spinner"></div>
      <h3></h3>
      <p></p>
      <div class="progress-wrap">
        <div class="progress-label"><span class="pl-step"></span><span>${Math.round(pct)}%</span></div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="thumbs"></div>`;
    preview.querySelector("h3").textContent = title;
    preview.querySelector("p").textContent = detail;
    preview.querySelector(".pl-step").textContent = title;
    const box = preview.querySelector(".thumbs");
    thumbs.forEach((src) => {
      if (!src) return;
      const i = document.createElement("img");
      i.src = src;
      i.alt = "";
      box.appendChild(i);
    });
  }

  function renderIdle() {
    preview.innerHTML = `
      <div class="preview-icon">✦</div>
      <h3>Ready to create</h3>
      <p>Enter your prompt and configuration settings to generate your next video.</p>`;
  }

  // ---------- Video rendering ----------
  function pickMimeType() {
    const candidates = [
      "video/mp4;codecs=avc1.42E01E",
      "video/mp4",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    if (typeof MediaRecorder === "undefined") return null;
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  }

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const clamp01 = (t) => Math.max(0, Math.min(1, t));

  function cameraTransform(camera, p) {
    const e = ease(p);
    switch (camera) {
      case "push-in": return { s: 1.04 + 0.22 * e, x: 0, y: 0 };
      case "pull-out": return { s: 1.26 - 0.22 * e, x: 0, y: 0 };
      case "pan-left": return { s: 1.2, x: 0.08 - 0.16 * e, y: 0 };
      case "pan-right": return { s: 1.2, x: -0.08 + 0.16 * e, y: 0 };
      case "tilt-up": return { s: 1.2, x: 0, y: -0.07 + 0.14 * e };
      case "tilt-down": return { s: 1.2, x: 0, y: 0.07 - 0.14 * e };
      default: return { s: 1.08 + 0.07 * e, x: 0.03 - 0.06 * e, y: 0.01 };
    }
  }

  function drawShot(ctx, img, camera, p, alpha) {
    const { s, x, y } = cameraTransform(camera, p);
    const cover = Math.max(WIDTH / img.naturalWidth, HEIGHT / img.naturalHeight) * s;
    const w = img.naturalWidth * cover;
    const h = img.naturalHeight * cover;
    const maxX = (w - WIDTH) / 2;
    const maxY = (h - HEIGHT) / 2;
    const dx = (WIDTH - w) / 2 + Math.max(-maxX, Math.min(maxX, x * WIDTH));
    const dy = (HEIGHT - h) / 2 + Math.max(-maxY, Math.min(maxY, y * HEIGHT));
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, dx, dy, w, h);
    ctx.globalAlpha = 1;
  }

  function drawTimeline(ctx, shots, duration, t) {
    const n = shots.length;
    const L = duration / n;
    const fade = Math.min(0.7, L * 0.35);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    for (let i = 0; i < n; i++) {
      const start = i === 0 ? 0 : i * L - fade / 2;
      const end = i === n - 1 ? duration : (i + 1) * L + fade / 2;
      if (t < start || t > end) continue;
      const p = clamp01((t - start) / (end - start));
      let alpha = 1;
      if (i > 0 && t < start + fade) alpha = clamp01((t - start) / fade);
      drawShot(ctx, shots[i].img, shots[i].camera, p, alpha);
    }
    // Gentle fade from / to black at the very start and end
    const edge = Math.min(0.4, duration * 0.08);
    const black = Math.max(clamp01(1 - t / edge), clamp01(1 - (duration - t) / edge));
    if (black > 0) {
      ctx.fillStyle = `rgba(0,0,0,${black})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }
  }

  function recordVideo(shots, duration, onProgress) {
    return new Promise((resolve, reject) => {
      const mimeType = pickMimeType();
      const canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const ctx = canvas.getContext("2d");
      if (mimeType === null || !canvas.captureStream) {
        reject(new Error("Your browser can't record video. Please use a recent Chrome, Edge, Firefox or Safari."));
        return;
      }
      drawTimeline(ctx, shots, duration, 0);
      onProgress(0, canvas);

      const stream = canvas.captureStream(FPS);
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 8_000_000,
      });
      const chunks = [];
      recorder.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      recorder.onerror = (e) => reject(e.error || new Error("Recording failed."));
      recorder.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        const type = recorder.mimeType || mimeType || "video/webm";
        resolve({ blob: new Blob(chunks, { type }), type });
      };

      let t0 = null;
      let stopped = false;
      const tick = () => {
        if (stopped) return;
        const now = performance.now();
        if (t0 === null) t0 = now;
        const t = Math.min(duration, (now - t0) / 1000);
        drawTimeline(ctx, shots, duration, t);
        onProgress(t / duration, canvas);
        if (t >= duration) {
          stopped = true;
          clearInterval(timer);
          // let the final frame land in the stream before stopping
          setTimeout(() => recorder.state !== "inactive" && recorder.stop(), 120);
        }
      };
      recorder.start(250);
      const timer = setInterval(tick, 1000 / FPS);
      tick();
    });
  }

  // Chrome-produced WebM files lack a duration header; nudge the player so the timeline works.
  function fixWebmDuration(video) {
    video.addEventListener("loadedmetadata", function onMeta() {
      video.removeEventListener("loadedmetadata", onMeta);
      if (video.duration === Infinity || Number.isNaN(video.duration)) {
        video.currentTime = 1e7;
        video.addEventListener("timeupdate", function onTU() {
          video.removeEventListener("timeupdate", onTU);
          video.currentTime = 0;
        });
      }
    });
  }

  function slugify(s) {
    return (s || "video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "video";
  }

  function renderResult({ url, type, title, duration, styleLabel, prompt }) {
    const ext = type.includes("mp4") ? "mp4" : "webm";
    preview.innerHTML = `
      <video controls autoplay loop playsinline></video>
      <div class="result-meta">
        <h3></h3>
        <p class="rm-desc"></p>
        <div class="result-actions">
          <a class="btn-secondary primary" download>⬇ Download video</a>
          <button type="button" class="btn-secondary" id="regenBtn">↻ Generate again</button>
        </div>
      </div>`;
    const video = preview.querySelector("video");
    fixWebmDuration(video);
    video.muted = true;
    video.src = url;
    preview.querySelector("h3").textContent = title;
    preview.querySelector(".rm-desc").textContent = `${duration}s · ${styleLabel} · “${prompt.length > 120 ? prompt.slice(0, 117) + "…" : prompt}”`;
    const a = preview.querySelector("a");
    a.href = url;
    a.download = `${slugify(title)}.${ext}`;
    preview.querySelector("#regenBtn").addEventListener("click", () => form.requestSubmit());
  }

  // ---------- Main generation flow ----------
  async function generate() {
    showError("");
    const prompt = promptEl.value.trim();
    const style = styleInput.value;
    const customStyle = customStyleEl.value.trim();
    const duration = getDuration();
    const mode = modeInput.value;
    const file = imageInput.files && imageInput.files[0];

    if (!prompt) {
      showError("Please describe what you want to see in your video.");
      promptEl.focus();
      return;
    }
    if (!Number.isInteger(duration) || duration < 1 || duration > 60) {
      showError("Please choose a custom duration between 1 and 60 whole seconds.");
      customDurationEl.focus();
      return;
    }
    if (style === "your-idea" && !customStyle) {
      showError("Please describe your own style in the “Your Idea” box.");
      customStyleEl.focus();
      return;
    }
    if (mode === "image" && !file) {
      showError("Please upload a source image, or switch to Text to Video.");
      return;
    }
    if (pickMimeType() === null) {
      showError("Your browser can't record video. Please use a recent Chrome, Edge, Firefox or Safari.");
      return;
    }

    busy = true;
    generateBtn.disabled = true;
    generateBtn.textContent = "Generating…";
    const styleLabel =
      style === "your-idea" ? "Your Idea" : style.charAt(0).toUpperCase() + style.slice(1);

    try {
      let sourceImage = null;
      if (mode === "image" && file) {
        if (!file.type.startsWith("image/")) throw new Error("Please upload an image file.");
        sourceImage = await toJpegDataUrl(await readFile(file), 1280);
      }

      renderProgress("Writing the storyboard", "Planning every shot of your video from your description…", 4);
      const board = await withRetry(() =>
        postJson("/api/storyboard", { prompt, style, customStyle, duration, hasSourceImage: Boolean(sourceImage) })
      );

      const n = board.shots.length;
      const images = new Array(n).fill(null);
      let done = 0;
      const update = () =>
        renderProgress(
          `Creating scenes ${done}/${n}`,
          `“${board.title}” — painting each scene in ${styleLabel} style. This usually takes under a minute.`,
          10 + (done / n) * 75,
          images
        );

      const frame = (i, reference) =>
        withRetry(() =>
          postJson("/api/frame", {
            visual: board.shots[i].visual,
            styleDescriptor: board.styleDescriptor,
            reference,
          })
        ).then((r) => r.image);

      // First frame anchors characters, palette and world for the rest of the video.
      if (sourceImage) {
        images[0] = sourceImage;
      } else {
        update();
        images[0] = await frame(0, null);
      }
      done = 1;
      update();
      const reference = await toJpegDataUrl(images[0], 1024);

      let next = 1;
      const worker = async () => {
        while (next < n) {
          const i = next++;
          images[i] = await frame(i, reference);
          done++;
          update();
        }
      };
      await Promise.all(Array.from({ length: Math.min(FRAME_CONCURRENCY, n - 1) }, worker));

      const loaded = await Promise.all(images.map(loadImage));
      const shots = loaded.map((img, i) => ({ img, camera: board.shots[i].camera }));

      // Render the real video file in real time
      preview.innerHTML = `
        <div class="rendering"></div>
        <div class="progress-wrap">
          <div class="progress-label"><span>Rendering your ${duration}s video — keep this tab open</span><span class="pct">85%</span></div>
          <div class="progress-bar"><div class="progress-fill" style="width:85%"></div></div>
        </div>`;
      const slot = preview.querySelector(".rendering");
      const pctEl = preview.querySelector(".pct");
      const fill = preview.querySelector(".progress-fill");
      slot.style.width = "100%";
      const { blob, type } = await recordVideo(shots, duration, (p, canvas) => {
        if (!canvas.isConnected) slot.appendChild(canvas);
        const pct = Math.round(85 + p * 15);
        pctEl.textContent = `${pct}%`;
        fill.style.width = `${pct}%`;
      });
      if (!blob.size) throw new Error("The video could not be recorded. Please try again.");

      if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
      lastVideoUrl = URL.createObjectURL(blob);
      renderResult({ url: lastVideoUrl, type, title: board.title, duration, styleLabel, prompt });
    } catch (err) {
      console.error(err);
      renderIdle();
      showError(err.message || "Something went wrong. Please try again.");
    } finally {
      busy = false;
      generateBtn.disabled = false;
      generateBtn.textContent = "✦ Generate Video";
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!busy) generate();
  });
})();
