/* lirrly.com — hand-rolled motion. No libraries.
   Everything pauses off-screen / when the tab hides, and collapses to
   static states under prefers-reduced-motion. */
(() => {
  "use strict";

  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FINE = matchMedia("(pointer: fine)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let hidden = document.hidden;
  document.addEventListener("visibilitychange", () => (hidden = document.hidden));

  /* Wait helper that respects tab visibility + an on-screen flag. */
  async function hold(ms, isOn) {
    await sleep(ms);
    while (hidden || (isOn && !isOn())) await sleep(300);
  }

  /* ---------- Scroll reveals ---------- */
  const revealed = document.querySelectorAll("[data-reveal]");
  if (!RM && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" }
    );
    revealed.forEach((el) => io.observe(el));
  } else {
    revealed.forEach((el) => el.classList.add("is-in"));
  }

  /* ---------- Nav condense ---------- */
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("is-scrolled", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- On-screen flags for the animated stages ---------- */
  function onScreenFlag(el) {
    let on = true;
    if ("IntersectionObserver" in window && el) {
      on = false;
      new IntersectionObserver((e) => (on = e[0].isIntersecting), { threshold: 0.1 }).observe(el);
    }
    return () => on;
  }

  /* ---------- Hero waveform canvas ---------- */
  const wave = $("#wave");
  const waveOn = onScreenFlag(wave);
  let amp = 0.3; // eased
  let ampTarget = 0.3;
  let pointerX = -1;
  if (wave) {
    const ctx = wave.getContext("2d");
    let W = 0;
    let H = 0;
    let grad = null;
    const fit = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      W = wave.clientWidth;
      H = wave.clientHeight;
      wave.width = W * dpr;
      wave.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, "#ffd5a4");
      grad.addColorStop(0.28, "#ffab9a");
      grad.addColorStop(0.55, "#ffc1f4");
      grad.addColorStop(0.8, "#dba0ff");
      grad.addColorStop(1, "#ffd5a4");
    };
    fit();
    new ResizeObserver(fit).observe(wave);
    wave.parentElement.addEventListener("pointermove", (e) => {
      const r = wave.getBoundingClientRect();
      pointerX = (e.clientX - r.left) / r.width;
    });
    wave.parentElement.addEventListener("pointerleave", () => (pointerX = -1));

    const BAR_W = 3;
    const GAP = 6;
    const draw = (t) => {
      if (!hidden && waveOn()) {
        amp += (ampTarget - amp) * 0.06;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = grad;
        const n = Math.floor(W / (BAR_W + GAP));
        const mid = H / 2;
        for (let i = 0; i < n; i++) {
          const x = i * (BAR_W + GAP);
          const u = i / n;
          let h =
            Math.sin(u * 9 + t / 520) * 0.35 +
            Math.sin(u * 23 - t / 310) * 0.28 +
            Math.sin(u * 4 + t / 900) * 0.37;
          h = (Math.abs(h) * 0.85 + 0.15) * amp;
          if (pointerX >= 0) {
            const d = Math.abs(u - pointerX);
            h += Math.max(0, 0.5 - d * 3.2) * 0.8;
          }
          const bh = Math.max(3, Math.min(1, h) * (H * 0.86));
          ctx.beginPath();
          ctx.roundRect(x, mid - bh / 2, BAR_W, bh, 2);
          ctx.fill();
        }
      }
      if (!RM) requestAnimationFrame(draw);
    };
    if (RM) {
      amp = 0.55;
      draw(0);
    } else {
      requestAnimationFrame(draw);
    }
  }

  /* ---------- Hero story: field + pill + wave, one state machine ---------- */
  const typed = $("#typed");
  const field = $("#typefield");
  const pill = $("#pill");
  const pillmsg = $("#pillmsg");
  const heroOn = wave ? waveOn : () => true;

  const typeInto = async (el, text, cps = 34, isOn) => {
    for (const ch of text) {
      el.textContent += ch;
      await hold(1000 / cps + Math.random() * 26, isOn);
    }
  };
  const setPill = (state, msg) => {
    if (msg) pillmsg.textContent = msg;
    pill.dataset.state = state;
  };
  const fadeSwap = async (el, fn) => {
    el.style.transition = "opacity .25s ease";
    el.style.opacity = "0";
    await sleep(270);
    fn();
    el.style.opacity = "1";
  };

  async function heroLoop() {
    const EN_RAW = "ok so um, move the meeting to thursday";
    const AR = "خلّنا نأجل الاجتماع للخميس، وأرسل لهم تأكيد.";
    for (;;) {
      // idle
      field.dir = "ltr";
      typed.textContent = "";
      setPill("idle");
      ampTarget = 0.28;
      await hold(1400, heroOn);
      // listening (EN)
      setPill("listening");
      ampTarget = 1;
      await typeInto(typed, EN_RAW, 30, heroOn);
      await hold(500, heroOn);
      // polishing
      setPill("msg", "Polishing…");
      ampTarget = 0.4;
      typed.textContent = "";
      const strike = document.createElement("s");
      strike.textContent = "um,";
      typed.append("ok so ", strike, " move the meeting to thursday");
      await hold(850, heroOn);
      await fadeSwap(typed, () => (typed.textContent = "Move the meeting to Thursday."));
      setPill("msg", "Done ✓");
      await hold(1500, heroOn);
      // clear
      await fadeSwap(typed, () => (typed.textContent = ""));
      setPill("idle");
      ampTarget = 0.28;
      await hold(900, heroOn);
      // listening (AR) — dialect preserved
      field.dir = "rtl";
      setPill("listening");
      ampTarget = 1;
      await typeInto(typed, AR, 26, heroOn);
      await hold(500, heroOn);
      setPill("msg", "Done ✓");
      ampTarget = 0.35;
      await hold(1600, heroOn);
      await fadeSwap(typed, () => (typed.textContent = ""));
    }
  }
  if (typed && pill) {
    if (RM) {
      typed.textContent = "Move the meeting to Thursday.";
      setPill("msg", "Done ✓");
    } else {
      heroLoop();
    }
  }

  /* ---------- Arabic section typing ---------- */
  const artyped = $("#artyped");
  if (artyped) {
    const arOn = onScreenFlag(artyped);
    const LINES = [
      "أبغى أرسل لهم رسالة بلهجتي، مو مترجمة ترجمة رسمية.",
      "وش رايك نطلع بكرة العصر؟ أنا جاهز تقريباً.",
    ];
    if (RM) {
      artyped.textContent = LINES[0];
    } else {
      (async () => {
        let i = 0;
        for (;;) {
          await hold(600, arOn);
          await typeInto(artyped, LINES[i % LINES.length], 24, arOn);
          await hold(4200, arOn);
          while (artyped.textContent.length) {
            artyped.textContent = artyped.textContent.slice(0, -2);
            await hold(14, arOn);
          }
          i++;
        }
      })();
    }
  }

  /* ---------- Transforms demo ---------- */
  const tsel = $("#tsel");
  const tpill = $("#tpill");
  const tname = $("#tname");
  const tchips = $("#tchips");
  if (tsel && tpill) {
    const BASE = "ok so i need the report by tmrw morning";
    const CYCLES = [
      { t: "formal", name: "Make formal", out: "Could you please share the report by tomorrow morning?", ar: false },
      { t: "rewrite", name: "Rewrite", out: "I need the report by tomorrow morning.", ar: false },
      { t: "translate", name: "Translate", out: "أحتاج التقرير بكرة الصبح، لو سمحت.", ar: true },
    ];
    const tOn = onScreenFlag(tsel);
    const setBase = () => {
      tsel.classList.remove("is-selected");
      tsel.removeAttribute("dir");
      tsel.removeAttribute("lang");
      tsel.textContent = BASE;
    };
    const chipLive = (key) => {
      tchips?.querySelectorAll("li").forEach((li) => li.classList.toggle("is-live", li.dataset.t === key));
    };
    if (RM) {
      setBase();
      tsel.classList.add("is-selected");
      tname.textContent = "Make formal";
      tpill.classList.add("is-on");
      chipLive("formal");
    } else {
      (async () => {
        for (;;) {
          for (const c of CYCLES) {
            setBase();
            chipLive(null);
            await hold(1500, tOn);
            tsel.classList.add("is-selected");
            await hold(750, tOn);
            tname.textContent = c.name;
            tpill.classList.add("is-on");
            chipLive(c.t);
            await hold(1000, tOn);
            tsel.classList.add("is-swap");
            await hold(320, tOn);
            tsel.textContent = c.out;
            if (c.ar) {
              tsel.dir = "rtl";
              tsel.lang = "ar";
            }
            tsel.classList.remove("is-selected", "is-swap");
            await hold(420, tOn);
            tpill.classList.remove("is-on");
            await hold(2300, tOn);
          }
        }
      })();
    }
  }

  /* ---------- Magnetic buttons ---------- */
  if (FINE && !RM) {
    document.querySelectorAll("[data-magnet]").forEach((btn) => {
      btn.addEventListener("pointermove", (e) => {
        const r = btn.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        btn.style.setProperty("--mx", `${Math.max(-4, Math.min(4, dx * 0.12))}px`);
        btn.style.setProperty("--my", `${Math.max(-3, Math.min(3, dy * 0.18))}px`);
      });
      btn.addEventListener("pointerleave", () => {
        btn.style.setProperty("--mx", "0px");
        btn.style.setProperty("--my", "0px");
      });
    });
  }

  /* ---------- Screenshot window tilt ---------- */
  const win = $("#tiltwin");
  if (win && FINE && !RM) {
    win.addEventListener("pointermove", (e) => {
      const r = win.getBoundingClientRect();
      const rx = ((e.clientY - r.top) / r.height - 0.5) * -3.2;
      const ry = ((e.clientX - r.left) / r.width - 0.5) * 3.2;
      win.style.transform = `perspective(1100px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    });
    win.addEventListener("pointerleave", () => {
      win.style.transition = "transform .6s cubic-bezier(.22,1,.36,1)";
      win.style.transform = "none";
      setTimeout(() => (win.style.transition = ""), 620);
    });
  }

  /* ---------- GitHub stars (graceful; skipped on local previews) ---------- */
  const stars = $("#stars");
  const repostars = $("#repostars");
  const isProd = /(^|\.)lirrly\.com$/.test(location.hostname) || location.hostname.endsWith("github.io");
  if (isProd)
  fetch("https://api.github.com/repos/m55h11r11/wispralt")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => {
      const n = d.stargazers_count;
      if (typeof n !== "number") return;
      const fmt = Intl.NumberFormat("en", { notation: "compact" }).format(n);
      if (stars) {
        stars.textContent = `★ ${fmt}`;
        stars.hidden = false;
      }
      if (repostars) repostars.textContent = `★ ${fmt}`;
    })
    .catch(() => {});
})();
