const tabButtons = document.querySelectorAll(".tabBtn");
const tabPanels = { play: document.getElementById("playTab"), analyze: document.getElementById("analyzeTab") };
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  Object.entries(tabPanels).forEach(([k, el]) => el.classList.toggle("active", k === name));
}
