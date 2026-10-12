const aboutOverlay = document.getElementById("about-overlay");
const aboutClose = document.getElementById("about-close");
const aboutVersion = document.getElementById("about-version");
const aboutCopy = document.getElementById("about-copy");
const destinationsPref = document.getElementById("pref-destinations");
const DESTINATIONS_KEY = "maia3.showDestinations";
const ABOUT_REPO = "https://github.com/outusuke/maia3-tauri";
let aboutOpener = null;

try { destinationsPref.checked = localStorage.getItem(DESTINATIONS_KEY) !== "0"; } catch {}
document.documentElement.classList.toggle("noDestinations", !destinationsPref.checked);
destinationsPref.addEventListener("change", () => {
  document.documentElement.classList.toggle("noDestinations", !destinationsPref.checked);
  try { localStorage.setItem(DESTINATIONS_KEY, destinationsPref.checked ? "1" : "0"); } catch {}
});

const themeSelect = document.getElementById("theme-select");

function showTheme() {
  const current = window.maiaTheme.get();
  for (const btn of themeSelect.querySelectorAll("button")) {
    const on = btn.dataset.value === current;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-checked", String(on));
  }
}

themeSelect.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-value]");
  if (!btn) return;
  window.maiaTheme.set(btn.dataset.value);
  showTheme();
});
showTheme();

async function loadAboutVersion() {
  try { aboutVersion.textContent = `Version ${await window.__TAURI__.core.invoke("app_version")}`; } catch {}
}

function openAbout() {
  aboutOpener = document.activeElement;
  aboutOverlay.classList.add("show");
  aboutClose.focus();
}

function closeAbout() {
  aboutOverlay.classList.remove("show");
  if (aboutOpener) aboutOpener.focus();
}

for (const btn of document.querySelectorAll(".aboutOpen")) btn.addEventListener("click", openAbout);
aboutClose.addEventListener("click", closeAbout);
aboutOverlay.addEventListener("click", (e) => { if (e.target === aboutOverlay) closeAbout(); });

// capture phase so the board shortcuts (arrows, F, U) don't fire behind the dialog
document.addEventListener("keydown", (e) => {
  if (!aboutOverlay.classList.contains("show")) return;
  if (e.key === "Escape") closeAbout();
  if (e.key !== "Tab") e.stopPropagation();
}, true);

aboutCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ABOUT_REPO);
    aboutCopy.textContent = "Copied!";
    setTimeout(() => { aboutCopy.textContent = "Copy link"; }, 1200);
  } catch {}
});

loadAboutVersion();
