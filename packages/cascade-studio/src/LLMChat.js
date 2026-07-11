// LLMChat.js - ES Module
// Collapsible AI assistant strip at the bottom of the code editor panel.
//
// Runs a tool-use agent loop against the provider connected via LLMIntegration:
//  - Anthropic Messages API (direct from the browser, BYO key)
//  - OpenRouter chat completions (OpenAI-style tools; key from the OAuth flow)
//
// Two tools are exposed to the model:
//  - run_cad_code(code): replaces the editor code and evaluates it via
//    CascadeAPI.runCode — errors/logs/history feed back into the loop
//  - capture_view(azimuth?, elevation?): renders the model and returns a
//    downscaled screenshot so the model can visually verify its work

const COLLAPSED_KEY = 'chiselcad-llm-chat-collapsed';
const MODEL_KEY_PREFIX = 'chiselcad-llm-model-'; // + provider
const MAX_LOOP_ITERATIONS = 15;
const SCREENSHOT_MAX_DIM = 768;
const ATTACH_MAX_DIM = 1024;   // user-attached images get a bit more detail
const MAX_ATTACHMENTS = 6;

export class LLMChat {
  constructor(app) {
    this.app = app;
    this._root = null;
    this._transcript = [];   // [{role: 'user'|'assistant'|'activity'|'error', text, images?}]
    this._apiMessages = [];  // provider-format conversation (reset on provider change)
    this._attachments = [];  // [{dataURL, mediaType, name}] pending for the next send
    this._provider = null;   // provider the conversation was started with
    this._busy = false;
    this._abort = null;

    window.addEventListener('llm-connection-changed', () => {
      const conn = this.app.llm && this.app.llm.getConnection();
      if (conn && this._provider && conn.provider !== this._provider) {
        this._apiMessages = [];
        this._provider = null;
        this._pushTranscript('activity', 'Provider changed — conversation reset.');
      }
      this._renderBody();
      this._populateModels();
    });

    window.addEventListener('resize', () => this._syncHeight());
  }

  /** (Re)mount the strip at the bottom of the editor panel. Called from
   *  EditorManager.initPanel — the panel DOM is rebuilt on project load. */
  mount(parentEl) {
    if (this._root) { this._root.remove(); }

    this._root = document.createElement('div');
    this._root.className = 'llm-chat';

    // --- Header: caret, label, status, model select, clear ---
    const header = document.createElement('div');
    header.className = 'llm-chat-header';

    this._caret = document.createElement('button');
    this._caret.className = 'llm-chat-caret';
    this._caret.type = 'button';
    this._caret.title = 'Show/hide the AI assistant';
    header.appendChild(this._caret);

    const label = document.createElement('span');
    label.className = 'llm-chat-label';
    label.textContent = '✦ Assistant';
    header.appendChild(label);

    this._status = document.createElement('span');
    this._status.className = 'llm-chat-status';
    header.appendChild(this._status);

    this._modelSelect = document.createElement('select');
    this._modelSelect.className = 'topnav-select llm-chat-model';
    this._modelSelect.title = 'Model';
    this._modelSelect.addEventListener('change', () => {
      const conn = this._conn();
      if (conn) { localStorage.setItem(MODEL_KEY_PREFIX + conn.provider, this._modelSelect.value); }
    });
    header.appendChild(this._modelSelect);

    this._clearBtn = document.createElement('button');
    this._clearBtn.className = 'llm-chat-caret';
    this._clearBtn.type = 'button';
    this._clearBtn.textContent = '⟲';
    this._clearBtn.title = 'Clear conversation';
    this._clearBtn.addEventListener('click', () => {
      this._transcript = [];
      this._apiMessages = [];
      this._provider = null;
      this._renderLog();
    });
    header.appendChild(this._clearBtn);

    header.addEventListener('click', (e) => {
      if (e.target === header || e.target === label || e.target === this._caret) {
        this._setCollapsed(!this._collapsed());
      }
    });
    this._root.appendChild(header);

    // --- Body: message log + input row (or connect hint) ---
    this._body = document.createElement('div');
    this._body.className = 'llm-chat-body';
    this._root.appendChild(this._body);

    parentEl.appendChild(this._root);

    this._setCollapsed(this._collapsed());
    this._renderBody();
    this._populateModels();
    this._ensureHeightSync();
  }

  /** Match the expanded body height to the console panel's height so the
   *  strip's top seam lines up with the console across the layout split.
   *  Tracks splitter drags via the console container's resize callback. */
  _ensureHeightSync() {
    const tryAttach = (attempts) => {
      const cc = this.app.console && this.app.console.goldenContainer;
      if (cc) {
        if (cc !== this._syncedContainer) {
          this._syncedContainer = cc;
          cc.on('resize', () => this._syncHeight());
        }
        this._syncHeight();
      } else if (attempts > 0) {
        setTimeout(() => tryAttach(attempts - 1), 100);
      }
    };
    tryAttach(20);
  }

  _syncHeight() {
    if (!this._body || this._collapsed()) { return; }
    const cc = this.app.console && this.app.console.goldenContainer;
    const consoleH = cc ? cc.height : 0;
    // Fallback when the console panel is missing/closed: a modest fixed height
    this._body.style.height = (consoleH > 40 ? consoleH : 180) + 'px';
    if (this._log) { this._log.scrollTop = this._log.scrollHeight; }
  }

  // ===== UI state =====

  _conn() { return this.app.llm ? this.app.llm.getConnection() : null; }
  _collapsed() { return localStorage.getItem(COLLAPSED_KEY) === '1'; }

  _setCollapsed(collapsed) {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    this._caret.textContent = collapsed ? '▸' : '▾';
    this._body.style.display = collapsed ? 'none' : '';
    this._modelSelect.style.display = collapsed ? 'none' : '';
    this._clearBtn.style.display = collapsed ? 'none' : '';
    if (!collapsed) { this._syncHeight(); }
  }

  _renderBody() {
    if (!this._body) { return; }
    this._body.innerHTML = '';

    if (!this._conn()) {
      const hint = document.createElement('div');
      hint.className = 'llm-chat-hint';
      hint.textContent = 'Connect a provider to prompt for objects or changes — ';
      const link = document.createElement('a');
      link.href = '#';
      link.textContent = 'open the LLM ▾ menu';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const menu = document.getElementById('llmMenu');
        if (menu) { menu.open = true; }
      });
      hint.appendChild(link);
      this._body.appendChild(hint);
      this._log = null;
      return;
    }

    this._log = document.createElement('div');
    this._log.className = 'llm-chat-log';
    this._body.appendChild(this._log);

    // Pending image attachments (thumbnails with a remove ✕)
    this._attachRow = document.createElement('div');
    this._attachRow.className = 'llm-chat-attach-row';
    this._body.appendChild(this._attachRow);

    const inputRow = document.createElement('div');
    inputRow.className = 'llm-chat-input-row';

    // Hidden file input + visible attach button
    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = 'image/*';
    this._fileInput.multiple = true;
    this._fileInput.style.display = 'none';
    this._fileInput.addEventListener('change', () => {
      this._addAttachmentFiles(this._fileInput.files);
      this._fileInput.value = '';
    });
    inputRow.appendChild(this._fileInput);

    this._attachBtn = document.createElement('button');
    this._attachBtn.className = 'llm-chat-attach-btn';
    this._attachBtn.type = 'button';
    // Icon is drawn in CSS (square + dot "lens") — font glyphs never center
    this._attachBtn.title = 'Attach image — or paste / drag one in';
    this._attachBtn.setAttribute('aria-label', 'Attach image');
    this._attachBtn.addEventListener('click', () => this._fileInput.click());
    inputRow.appendChild(this._attachBtn);

    this._input = document.createElement('textarea');
    this._input.className = 'llm-chat-input';
    this._input.rows = 1;
    this._input.placeholder = 'Describe an object or a change… (Enter to send)';
    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._onSend();
      }
    });
    // Pasted images become attachments (text pastes flow through untouched)
    this._input.addEventListener('paste', (e) => {
      const items = Array.from((e.clipboardData && e.clipboardData.items) || [])
        .filter(i => i.kind === 'file' && i.type.startsWith('image/'));
      if (!items.length) { return; }
      e.preventDefault();
      this._addAttachmentFiles(items.map(i => i.getAsFile()).filter(Boolean));
    });
    inputRow.appendChild(this._input);

    this._sendBtn = document.createElement('button');
    this._sendBtn.className = 'llm-chat-send';
    this._sendBtn.type = 'button';
    this._sendBtn.textContent = 'Send';
    this._sendBtn.addEventListener('click', () => this._onSend());
    inputRow.appendChild(this._sendBtn);

    this._body.appendChild(inputRow);

    // Drag-and-drop images onto the chat body. stopPropagation keeps the
    // window-level drop handler (theme/STEP import) from also claiming them.
    const dtHasImages = (dt) => dt && Array.from(dt.items || [])
      .some(i => i.kind === 'file' && i.type.startsWith('image/'));
    this._body.addEventListener('dragover', (e) => {
      if (!dtHasImages(e.dataTransfer)) { return; }
      e.preventDefault();
      e.stopPropagation();
      this._body.classList.add('llm-drop-hover');
    });
    this._body.addEventListener('dragleave', () => this._body.classList.remove('llm-drop-hover'));
    this._body.addEventListener('drop', (e) => {
      this._body.classList.remove('llm-drop-hover');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
        .filter(f => f.type.startsWith('image/'));
      if (!files.length) { return; } // non-image drop: let the window handler have it
      e.preventDefault();
      e.stopPropagation();
      this._addAttachmentFiles(files);
    });

    this._renderAttachRow();
    this._renderLog();
  }

  // ===== Image attachments =====

  async _addAttachmentFiles(files) {
    const images = Array.from(files || []).filter(f => f && f.type && f.type.startsWith('image/'));
    for (const f of images) {
      if (this._attachments.length >= MAX_ATTACHMENTS) {
        this._setStatus('attachment limit (' + MAX_ATTACHMENTS + ') reached');
        break;
      }
      try {
        const raw = await readFileAsDataURL(f);
        const dataURL = await normalizeAttachment(raw, ATTACH_MAX_DIM);
        if (!dataURL) { throw new Error('unreadable image'); }
        this._attachments.push({
          dataURL,
          mediaType: dataURL.slice(5, dataURL.indexOf(';')),
          name: f.name || 'image',
        });
      } catch (e) {
        this._setStatus('could not read ' + (f.name || 'image'));
      }
    }
    this._renderAttachRow();
  }

  _renderAttachRow() {
    if (!this._attachRow) { return; }
    this._attachRow.innerHTML = '';
    this._attachRow.style.display = this._attachments.length ? 'flex' : 'none';
    this._attachments.forEach((a, i) => {
      const chip = document.createElement('div');
      chip.className = 'llm-chat-attach-chip';
      const img = document.createElement('img');
      img.src = a.dataURL;
      img.title = a.name;
      chip.appendChild(img);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.title = 'Remove ' + a.name;
      x.addEventListener('click', () => {
        this._attachments.splice(i, 1);
        this._renderAttachRow();
      });
      chip.appendChild(x);
      this._attachRow.appendChild(chip);
    });
    if (this._log) { this._log.scrollTop = this._log.scrollHeight; }
  }

  _renderLog() {
    if (!this._log) { return; }
    this._log.innerHTML = '';
    for (const entry of this._transcript) {
      const div = document.createElement('div');
      div.className = 'llm-chat-msg llm-msg-' + entry.role;
      div.textContent = entry.text;
      for (const url of entry.images || []) {
        const img = document.createElement('img');
        img.className = 'llm-chat-msg-img';
        img.src = url;
        div.appendChild(img);
      }
      this._log.appendChild(div);
    }
    this._log.scrollTop = this._log.scrollHeight;
  }

  _pushTranscript(role, text, images) {
    if (!text && !(images && images.length)) { return; }
    this._transcript.push({ role, text, images });
    this._renderLog();
  }

  _setStatus(text) { if (this._status) { this._status.textContent = text || ''; } }

  _setBusy(busy) {
    this._busy = busy;
    if (this._sendBtn) {
      this._sendBtn.textContent = busy ? 'Stop' : 'Send';
      this._sendBtn.classList.toggle('llm-chat-stop', busy);
    }
    if (this._input) { this._input.disabled = busy; }
    if (this._attachBtn) { this._attachBtn.disabled = busy; }
    if (!busy) { this._setStatus(''); }
  }

  // ===== Model list =====

  async _populateModels() {
    if (!this._modelSelect) { return; }
    const conn = this._conn();
    this._modelSelect.innerHTML = '';
    if (!conn) { return; }

    let ids = [];
    try {
      if (conn.provider === 'anthropic') {
        const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          headers: {
            'x-api-key': conn.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        });
        if (resp.ok) { ids = (await resp.json()).data.map(m => m.id); }
      } else {
        const resp = await fetch('https://openrouter.ai/api/v1/models');
        if (resp.ok) {
          ids = (await resp.json()).data
            .filter(m => m.id.startsWith('anthropic/'))
            .filter(m => !m.supported_parameters || m.supported_parameters.includes('tools'))
            .map(m => m.id);
        }
      }
    } catch (e) { /* fall through to defaults */ }

    if (!ids.length) {
      ids = conn.provider === 'anthropic'
        ? ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']
        : ['anthropic/claude-sonnet-4'];
    }

    const saved = localStorage.getItem(MODEL_KEY_PREFIX + conn.provider);
    const preferred = (saved && ids.includes(saved)) ? saved
      : ids.find(id => id.includes('opus')) || ids[0];

    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id.replace(/^anthropic\//, '');
      this._modelSelect.appendChild(opt);
    }
    this._modelSelect.value = preferred;
  }

  // ===== Agent loop =====

  async _onSend() {
    if (this._busy) {
      if (this._abort) { this._abort.abort(); }
      return;
    }
    const conn = this._conn();
    if (!conn) { return; }
    const prompt = this._input.value.trim();
    const atts = this._attachments.slice();
    if (!prompt && !atts.length) { return; }
    if (!window.CascadeAPI || !window.CascadeAPI.isReady()) {
      this._setStatus('engine still loading…');
      return;
    }

    this._input.value = '';
    this._attachments = [];
    this._renderAttachRow();
    this._pushTranscript('user', prompt, atts.map(a => a.dataURL));
    this._provider = conn.provider;
    this._abort = new AbortController();
    this._setBusy(true);

    try {
      if (conn.provider === 'anthropic') {
        await this._runAnthropicLoop(conn, prompt, atts);
      } else {
        await this._runOpenRouterLoop(conn, prompt, atts);
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        this._pushTranscript('activity', '■ Stopped.');
      } else {
        this._pushTranscript('error', 'Error: ' + e.message);
      }
    }
    this._setBusy(false);
    this._abort = null;
  }

  _userTurnText(prompt) {
    const code = window.CascadeAPI.getCode();
    return '[Current editor code]\n```js\n' + code + '\n```\n\n[Request]\n' + prompt;
  }

  // --- Anthropic Messages API ---

  async _runAnthropicLoop(conn, prompt, atts = []) {
    const text = this._userTurnText(prompt || 'See the attached image(s).');
    this._apiMessages.push({
      role: 'user',
      content: atts.length
        ? [
            // Images lead, text follows — the layout Anthropic recommends
            ...atts.map(a => ({
              type: 'image',
              source: { type: 'base64', media_type: a.mediaType, data: a.dataURL.split(',')[1] },
            })),
            { type: 'text', text },
          ]
        : text,
    });

    for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
      this._setStatus('thinking…');
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: this._abort.signal,
        headers: {
          'x-api-key': conn.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this._modelSelect.value,
          max_tokens: 16000,
          system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
          tools: ANTHROPIC_TOOLS,
          messages: this._apiMessages,
        }),
      });
      if (!resp.ok) { throw new Error(await extractApiError(resp)); }
      const msg = await resp.json();

      // Append the full content verbatim — required for tool_use round-trips
      this._apiMessages.push({ role: 'assistant', content: msg.content });

      for (const block of msg.content) {
        if (block.type === 'text' && block.text.trim()) { this._pushTranscript('assistant', block.text); }
      }

      if (msg.stop_reason === 'refusal') {
        this._pushTranscript('error', 'The model declined this request.');
        return;
      }
      if (msg.stop_reason !== 'tool_use') {
        if (msg.stop_reason === 'max_tokens') { this._pushTranscript('activity', '(response truncated at max_tokens)'); }
        return;
      }

      const results = [];
      for (const block of msg.content) {
        if (block.type !== 'tool_use') { continue; }
        const out = await this._executeTool(block.name, block.input);
        if (out.imageDataURL) {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: out.imageDataURL.split(',')[1] } },
              { type: 'text', text: out.text },
            ],
          });
        } else {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: out.text, is_error: !!out.isError });
        }
      }
      this._apiMessages.push({ role: 'user', content: results });
    }
    this._pushTranscript('activity', '(stopped after ' + MAX_LOOP_ITERATIONS + ' tool iterations)');
  }

  // --- OpenRouter (OpenAI-style chat completions) ---

  async _runOpenRouterLoop(conn, prompt, atts = []) {
    if (!this._apiMessages.length) {
      this._apiMessages.push({ role: 'system', content: buildSystemPrompt() });
    }
    const text = this._userTurnText(prompt || 'See the attached image(s).');
    this._apiMessages.push({
      role: 'user',
      content: atts.length
        ? [
            { type: 'text', text },
            ...atts.map(a => ({ type: 'image_url', image_url: { url: a.dataURL } })),
          ]
        : text,
    });

    for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
      this._setStatus('thinking…');
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: this._abort.signal,
        headers: {
          'Authorization': 'Bearer ' + conn.apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': window.location.origin,
          'X-Title': 'Chisel CAD',
        },
        body: JSON.stringify({
          model: this._modelSelect.value,
          max_tokens: 16000,
          tools: OPENROUTER_TOOLS,
          messages: this._apiMessages,
        }),
      });
      if (!resp.ok) { throw new Error(await extractApiError(resp)); }
      const data = await resp.json();
      const m = data.choices && data.choices[0] && data.choices[0].message;
      if (!m) { throw new Error('empty completion response'); }

      this._apiMessages.push(m);
      if (m.content && String(m.content).trim()) { this._pushTranscript('assistant', String(m.content)); }

      if (!m.tool_calls || !m.tool_calls.length) { return; }

      // Tool-role messages can't carry images in this format — screenshots
      // are attached as a follow-up user message instead
      const pendingImages = [];
      for (const call of m.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) { /* leave empty */ }
        const out = await this._executeTool(call.function.name, args);
        if (out.imageDataURL) { pendingImages.push(out.imageDataURL); }
        this._apiMessages.push({ role: 'tool', tool_call_id: call.id, content: out.text });
      }
      if (pendingImages.length) {
        this._apiMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: '(screenshot from capture_view)' },
            ...pendingImages.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        });
      }
    }
    this._pushTranscript('activity', '(stopped after ' + MAX_LOOP_ITERATIONS + ' tool iterations)');
  }

  // ===== Tool execution =====

  async _executeTool(name, input) {
    if (name === 'run_cad_code') {
      this._setStatus('running code…');
      this._pushTranscript('activity', '▸ running code…');
      try {
        const result = await window.CascadeAPI.runCode(String(input.code || ''));
        const summary = result.success
          ? '✓ ok — ' + result.historySteps.length + ' step' + (result.historySteps.length === 1 ? '' : 's')
          : '✗ ' + result.errors.length + ' error' + (result.errors.length === 1 ? '' : 's');
        this._transcript[this._transcript.length - 1].text = '▸ ran code — ' + summary;
        this._renderLog();
        return {
          text: JSON.stringify({
            success: result.success,
            errors: result.errors.map(e => truncate(String(e && e.message || e), 1000)),
            logs: result.logs.slice(-30).map(l => truncate(String(l), 500)),
            historySteps: result.historySteps.map(s => s.fnName + '@L' + s.lineNumber),
          }),
          isError: !result.success,
        };
      } catch (e) {
        this._transcript[this._transcript.length - 1].text = '▸ ran code — ✗ ' + e.message;
        this._renderLog();
        return { text: 'Evaluation failed: ' + e.message, isError: true };
      }
    }

    if (name === 'capture_view') {
      this._setStatus('capturing view…');
      if (typeof input.azimuth === 'number' || typeof input.elevation === 'number') {
        window.CascadeAPI.setCameraAngle(input.azimuth || 0, input.elevation || 0);
      }
      const dataURL = window.CascadeAPI.screenshot();
      if (!dataURL) { return { text: 'No viewport available.', isError: true }; }
      const scaled = await downscaleImage(dataURL, SCREENSHOT_MAX_DIM);
      this._pushTranscript('activity', '▸ captured view'
        + (typeof input.azimuth === 'number' ? ' (az ' + input.azimuth + '°, el ' + (input.elevation || 0) + '°)' : ''));
      return { text: 'Screenshot of the current 3D view attached.', imageDataURL: scaled };
    }

    return { text: 'Unknown tool: ' + name, isError: true };
  }
}

// ===== Tool schemas =====

const TOOL_DEFS = [
  {
    name: 'run_cad_code',
    description: 'Replace the Chisel CAD editor code with `code` and evaluate it. '
      + 'The code must be the COMPLETE script — it replaces the entire editor content. '
      + 'Returns success, errors, recent console logs, and the modeling history steps. '
      + 'Iterate on errors until the model builds cleanly.',
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The complete CascadeStudio JavaScript to evaluate.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'capture_view',
    description: 'Render the current 3D model and return a screenshot for visual verification. '
      + 'Optionally set the camera angle first: azimuth 0=front, 90=right, 180=back; '
      + 'elevation 0=level, 90=top. Omit both to auto-fit the camera. '
      + 'Use this after run_cad_code succeeds to check proportions and placement.',
    schema: {
      type: 'object',
      properties: {
        azimuth: { type: 'number', description: 'Camera azimuth in degrees (0=front, 90=right).' },
        elevation: { type: 'number', description: 'Camera elevation in degrees (0=level, 90=top).' },
      },
    },
  },
];

const ANTHROPIC_TOOLS = TOOL_DEFS.map(t => ({
  name: t.name, description: t.description, input_schema: t.schema,
}));

const OPENROUTER_TOOLS = TOOL_DEFS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.schema },
}));

// ===== System prompt =====

/** Paste-friendly variant for external chat agents (no tool calling): same
 *  API reference, but a copy/paste workflow instead of run_cad_code. Used by
 *  the "Copy prompt" item in the LLM ▾ menu. */
export function buildPortablePrompt() {
  const quickstart = window.CascadeAPI ? window.CascadeAPI.getQuickStart() : {};
  return [
    'You are helping me model parts in Chisel CAD, a browser-based parametric CAD',
    'environment scripted with CascadeStudio JavaScript.',
    '',
    'Workflow: I describe an object or a change; you reply with code. I paste it',
    'into the Chisel CAD editor, run it, and report back errors, measurements, or',
    'screenshots so you can iterate.',
    '',
    'Rules:',
    '- Always reply with ONE complete script in a single code block — it replaces',
    '  the entire editor content, so never send fragments or diffs.',
    '- When I share my current code, preserve its names, parameters, and structure',
    '  unless my request implies otherwise.',
    '- Define key dimensions as named constants at the top so they are easy to tweak.',
    '- Keep explanations brief — a sentence or two outside the code block.',
    '',
    'CascadeStudio API reference:',
    JSON.stringify(quickstart, null, 1),
  ].join('\n');
}

function buildSystemPrompt() {
  const quickstart = window.CascadeAPI ? window.CascadeAPI.getQuickStart() : {};
  return [
    'You are the modeling assistant built into Chisel CAD, a browser-based parametric',
    'CAD environment. Users describe objects or changes; you write CascadeStudio',
    'JavaScript and run it with the run_cad_code tool.',
    '',
    'Rules:',
    '- ALWAYS apply changes via run_cad_code — never just print code in chat. The',
    '  tool replaces the entire editor content, so send the complete script.',
    '- Each user message includes the current editor code. Preserve it (names,',
    '  parameters, structure) unless the request implies otherwise.',
    '- After a successful run, use capture_view to visually verify the geometry',
    '  before declaring success. Check proportions, placement, and orientation.',
    '- If a run reports errors, fix them and run again.',
    '- Users may attach images (reference drawings, photos, screenshots). Infer',
    '  geometry, proportions, and dimensions from them when present.',
    '- Keep chat replies brief: a sentence or two about what you built or changed.',
    '',
    'CascadeStudio API reference:',
    JSON.stringify(quickstart, null, 1),
  ].join('\n');
}

// ===== Helpers =====

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }

async function extractApiError(resp) {
  let detail = '';
  try {
    const body = await resp.json();
    detail = (body.error && (body.error.message || body.error.type)) || JSON.stringify(body);
  } catch (e) { /* non-JSON body */ }
  return 'HTTP ' + resp.status + (detail ? ' — ' + truncate(detail, 300) : '');
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Prepare a user-attached image for the API: downscale to maxDim and
 *  re-encode any format the providers don't accept (BMP, TIFF, …) — JPEG
 *  stays JPEG so photos don't balloon into PNGs. Resolves null on failure. */
function normalizeAttachment(dataURL, maxDim) {
  return new Promise((resolve) => {
    const srcType = dataURL.slice(5, dataURL.indexOf(';'));
    const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(srcType);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (supported && scale >= 1) { resolve(dataURL); return; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL(srcType === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9));
    };
    img.onerror = () => resolve(supported ? dataURL : null);
    img.src = dataURL;
  });
}

/** Downscale a dataURL image so screenshots don't blow up token usage. */
function downscaleImage(dataURL, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      if (scale >= 1) { resolve(dataURL); return; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}
