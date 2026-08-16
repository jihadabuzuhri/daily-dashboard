// Landing page behaviour. Deliberately tiny and fully independent of the app in
// src/main.js — nothing here reads or writes the app's own state.

const THEME_KEY = 'daily-dashboard:landing-theme';
const root = document.documentElement;

function setTheme(theme) {
  root.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode — in-memory only */ }
}

document.querySelector('#theme-toggle')?.addEventListener('click', () => {
  setTheme(root.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
});

// Follow the OS while the visitor hasn't made an explicit choice here.
matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  if (!stored) root.setAttribute('data-theme', e.matches ? 'light' : 'dark');
});
