// LLMIntegration.js - ES Module
// Provider connection manager for the LLM assistant (chat panel comes later).
//
// Owns the "LLM ▾" topnav menu with two connection flows:
//  - OpenRouter OAuth PKCE: click → approve on openrouter.ai → redirected back
//    with a code that gets exchanged for a user-controlled API key. No app
//    registration or backend required.
//  - Anthropic API key paste: validated against /v1/models (with the
//    dangerous-direct-browser-access header) before saving.
//
// The connection lives in localStorage and is exposed via getConnection() as
// {provider: 'anthropic'|'openrouter', apiKey} for the future chat panel.

import { buildPortablePrompt } from './LLMChat.js';

const STORAGE_KEY = 'chiselcad-llm-connection';
const VERIFIER_KEY = 'chiselcad-openrouter-verifier';
const ANTHROPIC_KEYS_URL = 'https://platform.claude.com/settings/keys';

export class LLMIntegration {
  constructor(app) {
    this.app = app;
    this._menu = null;
    this._items = null;
    this._notice = null; // {text, ok} — transient status shown in the menu
  }

  /** Must run before CascadeMain.initialize() reads location.search — the
   *  OpenRouter callback returns ?code=..., which would otherwise be
   *  mistaken for a shared-project code parameter. */
  init() {
    this._handleOAuthCallback();
    this._buildMenu();
  }

  /** @returns {{provider: string, apiKey: string}|null} */
  getConnection() {
    try {
      const conn = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return (conn && conn.provider && conn.apiKey) ? conn : null;
    } catch (e) { return null; }
  }

  disconnect() {
    localStorage.removeItem(STORAGE_KEY);
    this._notice = null;
    this._render();
    window.dispatchEvent(new CustomEvent('llm-connection-changed'));
  }

  // ===== OpenRouter OAuth (PKCE) =====

  async _startOpenRouterAuth() {
    const verifier = this._base64url(crypto.getRandomValues(new Uint8Array(32)));
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = this._base64url(new Uint8Array(digest));
    const callback = window.location.origin + window.location.pathname;
    window.location.href = 'https://openrouter.ai/auth'
      + '?callback_url=' + encodeURIComponent(callback)
      + '&code_challenge=' + challenge
      + '&code_challenge_method=S256';
  }

  /** A pending verifier in sessionStorage means this page load is the OAuth
   *  return trip (it's set only between clicking Connect and coming back). */
  _handleOAuthCallback() {
    const verifier = sessionStorage.getItem(VERIFIER_KEY);
    if (!verifier) { return; }
    sessionStorage.removeItem(VERIFIER_KEY);

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) { return; } // user backed out of the approve page

    // Strip ?code= synchronously so initialize() doesn't parse it as a project
    params.delete('code');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);

    this._exchangeCode(code, verifier);
  }

  async _exchangeCode(code, verifier) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/auth/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      });
      if (!resp.ok) { throw new Error('key exchange failed (HTTP ' + resp.status + ')'); }
      const data = await resp.json();
      if (!data.key) { throw new Error('no key in exchange response'); }
      this._save({ provider: 'openrouter', apiKey: data.key });
      this._notice = { text: 'OpenRouter connected — ready to rock.', ok: true };
    } catch (e) {
      this._notice = { text: 'OpenRouter connect failed: ' + e.message, ok: false };
    }
    this._render();
    if (this._menu) { this._menu.open = true; } // surface the result
  }

  _base64url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // ===== Anthropic key validation =====

  async _validateAndSaveAnthropicKey(key) {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (resp.status === 401) { throw new Error('Invalid API key'); }
    if (!resp.ok) { throw new Error('Validation failed (HTTP ' + resp.status + ')'); }
    this._save({ provider: 'anthropic', apiKey: key });
  }

  _save(conn) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...conn, connectedAt: new Date().toISOString() }));
    window.dispatchEvent(new CustomEvent('llm-connection-changed'));
  }

  // ===== Menu UI =====

  _buildMenu() {
    const actions = document.querySelector('.topnav-actions');
    if (!actions) { return; }

    this._menu = document.createElement('details');
    this._menu.id = 'llmMenu';
    this._menu.className = 'topnav-menu';

    this._summary = document.createElement('summary');
    this._summary.title = 'Connect an LLM provider for the AI assistant';
    this._menu.appendChild(this._summary);

    this._items = document.createElement('div');
    this._items.className = 'topnav-menu-items llm-menu-items';
    this._menu.appendChild(this._items);

    actions.appendChild(this._menu);

    // Close on outside click / Escape, matching the File menu. Item clicks
    // deliberately don't auto-close — the key-entry form lives in here.
    document.addEventListener('mousedown', (e) => {
      if (this._menu.open && !this._menu.contains(e.target)) { this._menu.open = false; }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._menu.open) { this._menu.open = false; }
    });

    this._render();
  }

  _render() {
    if (!this._items) { return; }
    const conn = this.getConnection();
    this._summary.textContent = (conn ? '● ' : '') + 'LLM ▾';
    this._items.innerHTML = '';

    // Status row
    const status = document.createElement('div');
    status.className = 'llm-menu-status' + (conn ? ' llm-connected' : '');
    status.textContent = conn
      ? '● ' + (conn.provider === 'anthropic' ? 'Anthropic' : 'OpenRouter') + ' — ' + this._maskKey(conn.apiKey)
      : '○ Not connected';
    this._items.appendChild(status);

    if (this._notice) {
      const notice = document.createElement('div');
      notice.className = 'llm-menu-notice' + (this._notice.ok ? ' llm-notice-ok' : ' llm-notice-err');
      notice.textContent = this._notice.text;
      this._items.appendChild(notice);
    }

    this._sep();

    this._item('Connect with OpenRouter…',
      'Approve on openrouter.ai — a key for this app is issued to your account',
      () => this._startOpenRouterAuth());

    this._item('Use Anthropic API key…',
      'Paste a key from ' + ANTHROPIC_KEYS_URL + ' (stored locally in this browser)',
      () => {
        const showing = this._keyForm.style.display !== 'none';
        this._keyForm.style.display = showing ? 'none' : '';
        if (!showing) { this._keyForm.querySelector('input').focus(); }
      });
    this._keyForm = this._buildKeyForm();
    this._items.appendChild(this._keyForm);

    this._sep();
    this._item('Copy prompt for any AI',
      'Copies a system prompt with the full CascadeStudio API reference — paste it '
      + 'into ChatGPT, Claude, Gemini, etc., then paste the code it writes back into '
      + 'the editor. No account or connection needed.',
      async () => {
        try {
          await navigator.clipboard.writeText(buildPortablePrompt());
          this._notice = { text: 'Prompt copied — paste it into any chat agent, then paste the code it writes back into the editor.', ok: true };
        } catch (e) {
          this._notice = { text: 'Copy failed: ' + e.message, ok: false };
        }
        this._render();
        if (this._menu) { this._menu.open = true; }
      });

    if (conn) {
      this._sep();
      this._item('Disconnect', 'Forget the stored key', () => this.disconnect());
    }

    this._sep();
    const privacy = document.createElement('div');
    privacy.className = 'llm-menu-privacy';
    privacy.textContent = '🔒 Your key stays in this browser (localStorage) and is only ever '
      + 'sent directly to your chosen provider’s API. Chisel CAD has no server — '
      + 'nothing is uploaded, logged, or shared. Disconnect anytime to erase it.';
    this._items.appendChild(privacy);
  }

  _buildKeyForm() {
    const form = document.createElement('div');
    form.className = 'llm-key-form';
    form.style.display = 'none';

    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = 'sk-ant-api03-…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    form.appendChild(input);

    const row = document.createElement('div');
    row.className = 'llm-key-row';

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    row.appendChild(save);

    const getKey = document.createElement('a');
    getKey.href = ANTHROPIC_KEYS_URL;
    getKey.target = '_blank';
    getKey.rel = 'noopener';
    getKey.textContent = 'Get a key ↗';
    row.appendChild(getKey);

    const msg = document.createElement('span');
    msg.className = 'llm-key-msg';
    row.appendChild(msg);

    form.appendChild(row);

    const submit = async () => {
      const key = input.value.trim();
      if (!key) { return; }
      msg.textContent = 'Validating…';
      save.disabled = true;
      try {
        await this._validateAndSaveAnthropicKey(key);
        this._notice = { text: 'Anthropic connected — ready to rock.', ok: true };
        this._render();
        if (this._menu) { this._menu.open = true; }
      } catch (e) {
        msg.textContent = e.message;
        save.disabled = false;
      }
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { submit(); } });

    return form;
  }

  _item(text, title, onClick) {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = text;
    a.title = title;
    a.addEventListener('click', (e) => { e.preventDefault(); onClick(); });
    this._items.appendChild(a);
    return a;
  }

  _sep() {
    const s = document.createElement('div');
    s.className = 'topnav-menu-sep';
    this._items.appendChild(s);
  }

  _maskKey(key) {
    return key.length > 12 ? key.slice(0, 7) + '…' + key.slice(-4) : '…';
  }
}
