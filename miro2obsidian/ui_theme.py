"""Shared visual tokens and local HTML shell for the application."""

import base64
import hashlib
import json

from miro2obsidian.desktop_strings import DESKTOP_RU
from miro2obsidian.app_setup import SETUP_SCRIPT

COLORS = {
    "canvas": "#f6f5fa", "surface": "#ffffff", "ink": "#242137",
    "muted": "#625d75", "border": "#e3dfed", "purple": "#6842c2",
    "purple_soft": "#eee8fb", "yellow": "#ffdd57", "rail": "#262237",
    "dots": "#dcd7e7", "note_ink": "#4a386f", "code": "#f2f0f7",
    "hover": "#452389", "button": "#6842c2", "button_hover": "#5432a1",
    "control": "#f0eef5", "control_hover": "#e5e1ed",
}

DARK_COLORS = {
    **COLORS, "canvas": "#1e1e1e", "surface": "#252525", "ink": "#dcddde",
    "muted": "#a9a9ad", "border": "#3f3f3f", "purple": "#b99aff",
    "purple_soft": "#30283f", "rail": "#262626", "dots": "#363636",
    "note_ink": "#dfcffb", "code": "#302938", "hover": "#d9c6ff",
    "button": "#8055d6", "button_hover": "#7045c4",
    "control": "#303030", "control_hover": "#3a3a3a",
}

# Only this fixed script is allowed by the setup page CSP. The cookie holds a
# non-sensitive preference, shared across ephemeral localhost server ports.
THEME_SCRIPT = "const setupRussian = " + json.dumps(DESKTOP_RU, ensure_ascii=True) + ";\n" + """(() => {
  const readPreference = (key, allowed, fallback) => {
    let value;
    try {
      const cookie = document.cookie.split('; ').find(item => item.startsWith(key + '='));
      value = cookie ? cookie.slice(key.length + 1) : localStorage.getItem(key);
    } catch (_) { /* Storage may be blocked inside a Miro iframe. */ }
    return allowed.includes(value) ? value : fallback;
  };
  const writePreference = (key, value) => {
    try { document.cookie = key + '=' + value + '; Path=/; Max-Age=31536000; SameSite=Strict'; } catch (_) {}
    try { localStorage.setItem(key, value); } catch (_) {}
  };
  document.documentElement.dataset.theme = readPreference('miro2obsidian_theme', ['light', 'dark'], 'light');
  let language = readPreference('miro2obsidian_language', ['en', 'ru'], 'en');
  document.documentElement.lang = language;
  document.addEventListener('DOMContentLoaded', () => {
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!['SCRIPT', 'STYLE', 'CODE'].includes(node.parentElement.tagName) &&
          !node.parentElement.closest('[data-raw-output], [data-ui-message]')) {
        texts.push([node, node.textContent]);
      }
    }
    const translate = text => {
      if (Object.hasOwn(setupRussian, text)) return setupRussian[text];
      if (text.startsWith('Error category: ')) return 'Категория ошибки: ' + text.slice(16);
      const team = text.match(/^Miro is connected to team (.*)\\. The connection is saved in your operating system credential store\\.$/);
      if (team) return 'Miro подключён к команде ' + team[1] + '. Подключение сохранено в хранилище учётных данных операционной системы.';
      const sent = text.match(/^Sent to miro2obsidian(?: ✓)? \\((\\d+) items\\)\\.?$/);
      if (sent) return 'Отправлено в miro2obsidian: ' + sent[1] + ' элементов.';
      if (text.startsWith('Export for miro2obsidian failed: ')) return 'Ошибка экспорта для miro2obsidian: ' + text.slice(31);
      if (text.startsWith('Automatic export check failed: ')) return 'Ошибка проверки автоматического экспорта: ' + text.slice(31);
      return text;
    };
    const updateLanguage = () => {
      document.documentElement.lang = language;
      texts.forEach(([node, original]) => { node.textContent = language === 'ru' ? translate(original) : original; });
      document.querySelectorAll('[data-language]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.language === language));
      });
      document.querySelectorAll('[data-ui-message]').forEach(element => {
        element.textContent = language === 'ru' ? translate(element.dataset.uiMessage) : element.dataset.uiMessage;
      });
    };
    document.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => {
      language = button.dataset.language;
      writePreference('miro2obsidian_language', language);
      updateLanguage();
    }));
    updateLanguage();
    window.miro2obsidianUI = {
      text: text => language === 'ru' ? translate(text) : text,
      setMessage: (element, text) => {
        element.dataset.uiMessage = text;
        element.textContent = language === 'ru' ? translate(text) : text;
      },
    };
    const button = document.getElementById('theme-toggle');
    const update = () => button.setAttribute('aria-pressed',
      String(document.documentElement.dataset.theme === 'dark'));
    update();
    button.addEventListener('click', () => {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme;
      writePreference('miro2obsidian_theme', theme);
      update();
    });
  });
})();""" + SETUP_SCRIPT


def theme_script_source() -> str:
    """CSP source expression for the exact inline theme script."""
    digest = base64.b64encode(hashlib.sha256(THEME_SCRIPT.encode()).digest()).decode()
    return f"'sha256-{digest}'"


def theme_css() -> str:
    variables = ";".join(f"--{name.replace('_', '-')}: {value}" for name, value in COLORS.items())
    dark = ";".join(f"--{name.replace('_', '-')}: {value}" for name, value in DARK_COLORS.items())
    return (":root{color-scheme:light;" + variables + "}"
            + ':root[data-theme="dark"]{color-scheme:dark;' + dark + "}") + """
*{box-sizing:border-box}body{margin:0;color:var(--ink);font:15px/1.65 'Segoe UI',system-ui,sans-serif;
background-color:var(--canvas);background-image:radial-gradient(var(--dots) .8px,transparent .8px);background-size:20px 20px}
a{color:var(--purple);text-underline-offset:3px}a:hover{color:var(--hover)}
.app-shell{max-width:1140px;margin:48px auto;padding:0 24px;display:grid;grid-template-columns:260px minmax(0,1fr);gap:28px}
.rail{background:var(--rail);color:#f7f4ff;padding:30px 26px;border-radius:24px;align-self:start;position:sticky;top:32px}
.brand{font-size:18px;font-weight:700;letter-spacing:-.4px}.brand-mark{display:inline-grid;place-items:center;background:var(--yellow);
color:var(--rail);width:36px;height:36px;border-radius:10px;margin-right:10px;transform:rotate(-5deg)}
.rail p{color:#c5bfd7;font-size:14px}.rail .eyebrow{color:#c4b0f3;margin-top:32px}
.journey{list-style:none;padding:0;margin:18px 0 32px}.journey li{padding:12px 14px;margin:6px -2px;border-radius:10px;color:#c5bfd7}
.journey .active{background:#403654;color:#fff;border-left:3px solid var(--yellow)}
.local-tag{display:inline-block;border:1px solid #63596f;border-radius:100px;padding:4px 12px;font-size:12px;color:#e6dff4}
.content{min-width:0}.eyebrow{text-transform:uppercase;letter-spacing:1.8px;font-size:11px;font-weight:700;color:var(--purple)}
.page-header{margin:5px 0 26px}h1{font-size:36px;line-height:1.15;letter-spacing:-1.2px;margin:8px 0 14px}
h2{font-size:22px;letter-spacing:-.5px;margin:0 0 8px}p{margin:10px 0 18px}
section,details,.status-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:28px;
box-shadow:0 6px 24px #29213e05;margin-bottom:18px}
section>p:first-of-type{color:var(--muted)}section ol{list-style:none;counter-reset:setup;padding:0;margin:26px 0}
section ol>li{counter-increment:setup;position:relative;padding:0 0 22px 48px;margin-bottom:20px;border-bottom:1px solid var(--border)}
section ol>li:last-child{border:0;margin-bottom:0;padding-bottom:0}
section ol>li::before{content:counter(setup);position:absolute;left:0;top:1px;width:30px;height:30px;display:grid;
place-items:center;background:var(--purple-soft);color:var(--purple);font-weight:700;border-radius:9px}
section ol>li:first-child>a{display:inline-block;background:var(--yellow);color:#292137;font-weight:650;text-decoration:none;
padding:10px 16px;border-radius:9px;margin:0 0 12px}section ol>li:first-child>a:hover{background:#f4cf3e}
section>p:last-child{background:var(--purple-soft);padding:15px 18px;border-radius:10px;margin-bottom:0;color:var(--note-ink);font-size:14px}
code{font:12px/1.7 Consolas,monospace;background:var(--code);border:1px solid var(--border);border-radius:5px;padding:3px 6px;
overflow-wrap:anywhere}summary{font-weight:650;cursor:pointer;color:var(--purple);padding:2px 0}details[open] summary{margin-bottom:20px}
label{display:block;font-weight:600;margin:18px 0}input{display:block;width:100%;font:inherit;color:var(--ink);background:var(--canvas);
border:1px solid #bbb3cd;border-radius:9px;padding:12px 14px;margin-top:8px}
button{font:600 15px 'Segoe UI',system-ui,sans-serif;background:var(--button);color:#fff;border:0;border-radius:9px;padding:13px 22px;cursor:pointer}
button:hover{background:var(--button-hover)}:focus-visible{outline:3px solid #936ada;outline-offset:4px}
.theme-toggle{display:block;margin-top:20px;background:transparent;border:1px solid #736584;color:#eeeaf5;font-size:13px;padding:9px 14px}
.theme-toggle[aria-pressed="true"]{background:#403654;border-color:#b99aff}
.language-switch{display:flex;gap:8px;margin-top:14px}.language-switch button{background:transparent;border:1px solid #736584;
color:#eeeaf5;padding:7px 14px;font-size:13px}.language-switch button[aria-pressed="true"]{background:#403654;border-color:#b99aff}
.page-footer{color:var(--muted);font-size:12px;padding:0 4px 28px}
[hidden]{display:none!important}.setup-nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.setup-nav button{background:var(--control);color:var(--ink);padding:10px 14px}
.setup-nav [aria-current="step"]{background:var(--button);color:#fff}
.copy-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;margin:18px 0}
.copy-row label{grid-column:1/-1;margin:0}.copy-row input{margin:0;font-size:14px;min-width:0}
.copy-row button{padding:12px 16px}.setup-nav~section p{max-width:70ch}
@media(max-width:800px){.app-shell{grid-template-columns:1fr;margin:20px auto;gap:20px}.rail{position:static;padding:20px 24px}
.rail .eyebrow,.journey,.rail p{display:none}.local-tag{margin-top:14px}h1{font-size:30px}}
@media(max-width:440px){.app-shell{padding:0 12px}section,details,.status-card{padding:20px}section ol>li{padding-left:40px}
.copy-row{grid-template-columns:minmax(0,1fr)}.copy-row button{justify-self:start}}
"""


def html_page(body: str) -> str:
    """Wrap trusted application HTML; callers must escape user-provided content."""
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Miro Full Exporter · Setup</title><style>' + theme_css() + '</style>'
        '<script>' + THEME_SCRIPT + '</script></head><body>'
        '<div class="app-shell"><aside class="rail" aria-label="Setup overview">'
        '<div class="brand">Miro Full Exporter</div>'
        '<p>Maximum public-API data, saved on your computer.</p>'
        '<ul class="journey"><li class="active">01 &nbsp; Connect Miro</li>'
        '<li>02 &nbsp; Choose a board</li><li>03 &nbsp; Export board data</li></ul>'
        '<span class="local-tag">Runs on your computer</span>'
        '<button id="theme-toggle" class="theme-toggle" type="button" aria-pressed="false">'
        '☾ Obsidian dark theme</button>'
        '<div class="language-switch" role="group" aria-label="Language / Язык">'
        '<button type="button" data-language="en" aria-pressed="true" lang="en">EN</button>'
        '<button type="button" data-language="ru" aria-pressed="false" lang="ru">RU</button>'
        '</div></aside><main class="content">'
        '<header class="page-header">'
        '<h1>Bring your boards home.</h1><p>Connect Miro to export board data and attachments to your computer.</p></header>'
        + body + '<footer class="page-footer">Miro Full Exporter · Local setup</footer>'
        '</main></div></body></html>'
    )
