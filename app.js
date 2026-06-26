/* ============================================================================
 * Power Apps (Canvas) Form YAML Cleaner
 * ----------------------------------------------------------------------------
 * Pure logic (parser + cleaner + markdown generator) lives at the top and is
 * exported for Node-based testing. DOM wiring is guarded at the bottom so the
 * same file works in the browser and under `node`.
 * ========================================================================== */

/* ----------------------------------------------------------------------------
 * 1. A small, focused YAML parser for the Power Apps .pa.yaml dialect
 * --------------------------------------------------------------------------*/

// Parse indentation-based YAML into nested JS maps/arrays/strings.
// Handles: `key: value`, nested maps, `- ` lists, and block scalars (| >, with
// chomping indicators -, +). Values keep their leading `=` (Power Fx formulas).
function parseYaml(text) {
  const rawLines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '  ').split('\n');

  // Pre-tokenise: keep blank/comment markers, record indent + content for the rest.
  const lines = rawLines.map((l) => {
    if (/^\s*$/.test(l)) return { blank: true, raw: l };
    const indent = l.match(/^ */)[0].length;
    const content = l.slice(indent);
    if (content.startsWith('#')) return { blank: true, raw: l };
    return { blank: false, indent, content, raw: l };
  });

  let i = 0;

  function nextSignificant() {
    while (i < lines.length && lines[i].blank) i++;
    return i < lines.length ? lines[i] : null;
  }

  function parseNode(minIndent) {
    const ln = nextSignificant();
    if (!ln || ln.indent < minIndent) return null;
    if (ln.content.startsWith('- ') || ln.content === '-') return parseList(ln.indent);
    return parseMap(ln.indent);
  }

  function parseMap(indent) {
    const map = {};
    while (true) {
      const ln = nextSignificant();
      if (!ln || ln.indent !== indent) break;
      if (ln.content.startsWith('- ') || ln.content === '-') break;

      const colon = ln.content.indexOf(':');
      if (colon === -1) { i++; continue; } // not a mapping line we understand
      const key = ln.content.slice(0, colon).trim();
      let rest = ln.content.slice(colon + 1).trim();
      i++;

      if (rest === '' ) {
        // Either a nested block, or an explicitly empty value.
        const child = nextSignificant();
        if (child && child.indent > indent) {
          map[key] = parseNode(indent + 1);
        } else {
          map[key] = '';
        }
      } else if (/^[|>][+-]?$/.test(rest)) {
        map[key] = parseBlockScalar(indent);
      } else {
        map[key] = rest;
      }
    }
    return map;
  }

  function parseList(indent) {
    const arr = [];
    while (true) {
      const ln = nextSignificant();
      if (!ln || ln.indent !== indent) break;
      if (!(ln.content.startsWith('- ') || ln.content === '-')) break;

      // Rewrite the dash line into a normal line at indent+2 and parse the item
      // as a node beginning there. This handles `- Name:` followed by an
      // indented child map.
      if (ln.content === '-') {
        i++;
        arr.push(parseNode(indent + 2));
        continue;
      }
      ln.content = ln.content.slice(2);
      ln.indent = indent + 2;
      arr.push(parseNode(indent + 2));
    }
    return arr;
  }

  // Collect a block scalar: every following line more indented than the key.
  function parseBlockScalar(keyIndent) {
    const collected = [];
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.blank) { collected.push(''); i++; continue; }
      if (ln.indent > keyIndent) { collected.push(' '.repeat(ln.indent) + ln.content); i++; }
      else break;
    }
    // Trim trailing blank lines that belong after the block.
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    if (!collected.length) return '';
    const minIndent = Math.min(...collected.filter((l) => l !== '').map((l) => l.match(/^ */)[0].length));
    return collected.map((l) => (l === '' ? '' : l.slice(minIndent))).join('\n');
  }

  return parseNode(0);
}

/* ----------------------------------------------------------------------------
 * 2. Normalise the parsed tree into Control nodes
 * --------------------------------------------------------------------------*/

// A single-key map like { RequestForm: {...} } -> { name, body }.
function entryNameBody(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    // Some pastes may wrap the control props directly; pick the first key.
    if (!keys.length) return null;
  }
  const name = keys[0];
  return { name, body: obj[name] };
}

function normalizeNode(entry) {
  const nb = entryNameBody(entry);
  if (!nb) return null;
  const { name, body } = nb;
  const b = body && typeof body === 'object' ? body : {};
  const props = [];
  if (b.Properties && typeof b.Properties === 'object') {
    for (const k of Object.keys(b.Properties)) props.push([k, b.Properties[k]]);
  }
  const node = {
    name,
    control: typeof b.Control === 'string' ? b.Control : null,
    variant: typeof b.Variant === 'string' ? b.Variant : null,
    layout: typeof b.Layout === 'string' ? b.Layout : null,
    isLocked: b.IsLocked,
    metadataKey: typeof b.MetadataKey === 'string' ? b.MetadataKey : null,
    props,
    children: [],
  };
  if (Array.isArray(b.Children)) {
    node.children = b.Children.map(normalizeNode).filter(Boolean);
  }
  // Also descend into named-map nesting (e.g. `Screens: { EditScreen: {...} }`)
  // where children are expressed as named sub-maps instead of a Children list.
  const RESERVED = new Set(['Control', 'Variant', 'Layout', 'IsLocked', 'MetadataKey', 'Properties', 'Children']);
  for (const k of Object.keys(b)) {
    if (RESERVED.has(k)) continue;
    const v = b[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const child = normalizeNode({ [k]: v });
      if (child) node.children.push(child);
    }
  }
  return node;
}

// Parse text -> array of top-level normalized nodes (forms and/or cards).
function parseForm(text) {
  const tree = parseYaml(text);
  if (!tree) return [];
  const entries = Array.isArray(tree) ? tree : [tree];
  return entries.map(normalizeNode).filter(Boolean);
}

/* ----------------------------------------------------------------------------
 * 3. Classification helpers
 * --------------------------------------------------------------------------*/

function baseControl(control) {
  if (!control) return '';
  return control.split('@')[0]; // "Classic/ComboBox@2.4.0" -> "Classic/ComboBox"
}
function shortControl(control) {
  const b = baseControl(control);
  return b.split('/').pop(); // "Classic/ComboBox" -> "ComboBox"
}

function isForm(node) {
  return baseControl(node.control).startsWith('Form');
}
function isDataCard(node) {
  const b = baseControl(node.control);
  return b === 'TypedDataCard' || b.endsWith('DataCard') || (!!node.variant && node.props.some(([k]) => k === 'DataField'));
}

// Controls that are pure presentation / helpers inside a data card.
const JUNK_METADATA = new Set(['FieldName', 'ErrorMessage', 'FieldRequired', 'HourMinuteSeparator', 'StartOfWeek']);
const JUNK_CONTROLS = new Set(['Label', 'Rectangle', 'Icon', 'Classic/Icon', 'Image', 'HtmlViewer', 'Shape', 'Circle']);

function isJunkControl(node) {
  if (node.metadataKey && JUNK_METADATA.has(node.metadataKey)) return true;
  const b = baseControl(node.control);
  if (JUNK_CONTROLS.has(b) || b === 'Label') return true;
  return false;
}

function isButton(node) {
  const b = baseControl(node.control);
  return b === 'Button' || b.endsWith('/Button') || b.endsWith('Button');
}

// --- Recursive discovery so a whole-screen paste still works (#3) ----------
// All Form controls anywhere in the tree.
function collectForms(nodes) {
  const forms = [];
  const walk = (n) => {
    if (isForm(n)) { forms.push(n); return; }
    for (const c of n.children || []) walk(c);
  };
  for (const n of nodes) walk(n);
  return forms;
}
// Data cards inside a single form (direct or nested under containers).
function collectCards(node) {
  const cards = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (isDataCard(c)) cards.push(c);
      else walk(c);
    }
  };
  walk(node);
  return cards;
}
// Data cards that are NOT inside any form (e.g. a single pasted card).
function collectStandaloneCards(nodes) {
  const cards = [];
  const walk = (n) => {
    for (const c of n.children || []) {
      if (isForm(c)) continue;
      if (isDataCard(c)) cards.push(c);
      else walk(c);
    }
  };
  for (const n of nodes) {
    if (isForm(n)) continue;
    if (isDataCard(n)) cards.push(n);
    else walk(n);
  }
  return cards;
}

// Walk a node tree and collect every button control, remembering the data card
// it lives inside (if any). Returns [{ button, card }] where card is the
// enclosing DataCard node or null when the button sits directly on the form.
function collectButtons(node, card, acc) {
  acc = acc || [];
  for (const c of node.children || []) {
    const childCard = isDataCard(c) ? c : card;
    if (isButton(c)) acc.push({ button: c, card });
    collectButtons(c, childCard, acc);
  }
  return acc;
}

// Map a card Variant to a friendly control-type label for the table.
function variantToType(variant, fallbackControl) {
  if (!variant) return shortControl(fallbackControl) || '—';
  const map = {
    ClassicComboBoxEdit: 'ComboBox',
    ClassicTextualEdit: 'Text',
    ClassicTextualMultilineEdit: 'Multiline Text',
    ClassicDateEdit: 'Date',
    ClassicDateTimeEdit: 'Date & Time',
    ClassicToggleEdit: 'Toggle (Yes/No)',
    ClassicAttachmentsEdit: 'Attachments',
    ClassicDropDownEdit: 'Dropdown',
    ClassicNumberEdit: 'Number',
    ClassicSliderEdit: 'Slider',
    ClassicRatingEdit: 'Rating',
    ClassicPenEdit: 'Pen / Signature',
    ClassicAllowedValuesEdit: 'Allowed Values',
    ClassicPercentageEdit: 'Percentage',
    ClassicCurrencyEdit: 'Currency',
    ClassicURLEdit: 'URL',
    ClassicEmailEdit: 'Email',
    ClassicRichTextEdit: 'Rich Text',
    ClassicLookupEdit: 'Lookup',
  };
  if (map[variant]) return map[variant];
  // Strip Classic/Edit decoration for unknown variants.
  return variant.replace(/^Classic/, '').replace(/Edit$/, '') || shortControl(fallbackControl);
}

/* ----------------------------------------------------------------------------
 * 4. Property filtering
 * --------------------------------------------------------------------------*/

// Functional properties worth keeping (whitelist used when hiding cosmetics).
const FUNCTIONAL_PROPS = new Set([
  // Form-level
  'DataSource', 'Item', 'DefaultMode', 'Layout',
  // Data binding / behaviour
  'DataField', 'DisplayName', 'Default', 'DefaultSelectedItems', 'DefaultDate',
  'DefaultSelected', 'Required', 'Update', 'Visible', 'Items', 'SelectMultiple',
  'DisplayMode', 'Text', 'Value', 'MaxLength', 'HintText', 'InputTextPlaceholder',
  'Mode', 'DelayOutput', 'IsEditable', 'Reset', 'DisplayFields', 'SearchFields',
  'Min', 'Max', 'IsSearchable', 'AllowEmptySelection', 'ValidationState',
]);

// Cosmetic properties always dropped (used as an extra guard / blacklist).
const COSMETIC_PROPS = new Set([
  'X', 'Y', 'Width', 'Height', 'Color', 'BorderColor', 'BorderThickness',
  'FocusedBorderThickness', 'FocusedBorderColor', 'BorderStyle', 'Fill', 'HoverFill',
  'PressedFill', 'HoverColor', 'PressedColor', 'HoverBorderColor', 'PressedBorderColor',
  'SelectionColor', 'SelectionFill', 'ChevronFill', 'ChevronHoverFill', 'ChevronBackground',
  'ChevronDisabledBackground', 'IconFill', 'ItemColor', 'ItemHoverColor', 'ItemHoverFill',
  'Font', 'FontWeight', 'FontSize', 'Size', 'Align', 'VerticalAlign', 'LineHeight',
  'PaddingTop', 'PaddingBottom', 'PaddingLeft', 'PaddingRight', 'RadiusTopLeft',
  'RadiusTopRight', 'RadiusBottomLeft', 'RadiusBottomRight', 'AutoHeight', 'Wrap',
  'Live', 'ZIndex', 'DisabledFill', 'DisabledColor', 'DisabledBorderColor', 'Tooltip',
  'TabIndex', 'ContentLanguage', 'FocusedBorderColor', 'HoverBorderThickness', 'Transparency',
  'StartYear', 'EndYear', 'DisplayMode', // DisplayMode is plumbing; drop unless wanted
]);

// Collapse a long literal array value (e.g. hour/minute lists) to a summary (#4).
function collapseEnum(value, opts) {
  if (!opts || !opts.collapseEnums || typeof value !== 'string') return value;
  const m = value.match(/^=\s*\[(.*)\]\s*$/);
  if (!m) return value;
  const items = m[1].split(',').map((s) => s.trim()).filter((s) => s.length);
  if (items.length <= 6) return value;
  if (!items.every((it) => /^"[^"]*"$|^'[^']*'$|^-?\d+(\.\d+)?$/.test(it))) return value;
  return `=[${items[0]} … ${items[items.length - 1]}] (${items.length} values)`;
}

function isOnHandler(key) { return /^On[A-Z]/.test(key); }
function isPassthrough(value) {
  if (typeof value !== 'string') return false;
  return /^=\s*Parent\.[A-Za-z0-9_]+\s*$/.test(value) || /^=\s*Self\.[A-Za-z0-9_]+\s*$/.test(value);
}

// Decide whether to keep a property given the active options.
function keepProp(key, value, opts) {
  if (opts.hidePassthrough && isPassthrough(value)) {
    // Always keep On* handlers even if they look like passthrough.
    if (!isOnHandler(key)) return false;
  }
  if (!opts.includeEvents && isOnHandler(key)) return false;
  if (!opts.includeVisible && key === 'Visible') return false;
  if (!opts.includeUpdate && key === 'Update') return false;
  if (!opts.includeDelayOutput && key === 'DelayOutput') return false;
  if (!opts.hideCosmetic) return true; // keep everything else
  // Hiding cosmetics: whitelist functional + On* handlers.
  if (isOnHandler(key)) return true;
  if (FUNCTIONAL_PROPS.has(key)) return true;
  return false;
}

function filterProps(props, opts) {
  return props.filter(([k, v]) => keepProp(k, v, opts));
}

/* ----------------------------------------------------------------------------
 * 5. Cleaned YAML output
 * --------------------------------------------------------------------------*/

// Recursively build a filtered copy of a node honouring the options.
function cleanNode(node, opts) {
  const clone = {
    name: node.name,
    control: node.control,
    variant: node.variant,
    layout: node.layout,
    metadataKey: node.metadataKey,
    props: filterProps(node.props, opts),
    children: [],
  };
  let children = node.children;
  if (opts.hideJunkControls) children = children.filter((c) => !isJunkControl(c));
  clone.children = children.map((c) => cleanNode(c, opts));
  return clone;
}

function emitScalar(value) {
  if (typeof value !== 'string') return String(value);
  if (value.indexOf('\n') !== -1) return null; // signal block scalar
  return value;
}

// Serialize a cleaned node back into Power Apps style YAML.
function serializeNode(node, dashIndent, lines, opts) {
  const pad = ' '.repeat(dashIndent);
  lines.push(`${pad}- ${node.name}:`);
  const keyIndent = dashIndent + 4;
  const kpad = ' '.repeat(keyIndent);
  if (node.control) lines.push(`${kpad}Control: ${node.control}`);
  if (node.variant) lines.push(`${kpad}Variant: ${node.variant}`);
  if (node.layout) lines.push(`${kpad}Layout: ${node.layout}`);
  if (node.props.length) {
    lines.push(`${kpad}Properties:`);
    const ppad = ' '.repeat(keyIndent + 2);
    for (const [k, v0] of node.props) {
      const v = collapseEnum(v0, opts);
      const scalar = emitScalar(v);
      if (scalar === null) {
        lines.push(`${ppad}${k}: |-`);
        const bpad = ' '.repeat(keyIndent + 4);
        for (const bl of String(v).split('\n')) lines.push(bl === '' ? '' : bpad + bl);
      } else {
        lines.push(`${ppad}${k}: ${scalar}`);
      }
    }
  }
  if (node.children.length) {
    lines.push(`${kpad}Children:`);
    for (const c of node.children) serializeNode(c, keyIndent + 2, lines, opts);
  }
}

function buildCleanedYaml(nodes, opts) {
  // Focus on the forms and standalone cards we found, so pasting a whole screen
  // yields the cleaned form (not the screen chrome). Fall back to the raw nodes
  // if nothing form-like is present.
  const forms = collectForms(nodes);
  const standalone = collectStandaloneCards(nodes);
  const targets = forms.length || standalone.length ? [...forms, ...standalone] : nodes;
  const cleaned = targets.map((n) => cleanNode(n, opts));
  const lines = [];
  for (const n of cleaned) serializeNode(n, 0, lines, opts);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/* ----------------------------------------------------------------------------
 * 6. Markdown documentation output
 * --------------------------------------------------------------------------*/

function getProp(node, key) {
  const found = node.props.find(([k]) => k === key);
  return found ? found[1] : undefined;
}

// Extract the SharePoint list name from a DataSource formula.
function extractDataSource(formula) {
  if (!formula) return null;
  let v = String(formula).replace(/^=/, '').trim();
  // =[@'Tracker'] / =[@Tracker] / ='Ride Along' / =Tracker
  let m = v.match(/'([^']+)'/);
  if (m) return m[1];
  m = v.match(/\[@\s*([A-Za-z0-9_]+)\s*\]/);
  if (m) return m[1];
  m = v.match(/^([A-Za-z0-9_]+)$/);
  if (m) return m[1];
  return v;
}

// Strip the _DataCardN suffix to recover the designer's field label.
function cardLabel(name) {
  return name.replace(/_DataCard\d*$/i, '').replace(/_+$/,'').trim();
}

// Extract the bound SharePoint column from a Default formula (=ThisItem.X).
function extractBoundColumn(node) {
  const def = getProp(node, 'Default');
  if (!def) return null;
  const m = String(def).match(/ThisItem\.(?:'([^']+)'|([A-Za-z0-9_]+))/);
  if (m) return m[1] || m[2];
  return null;
}

function stripFormula(v) {
  return typeof v === 'string' ? v.replace(/^=/, '').trim() : v;
}
function unquote(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  const m = s.match(/^"(.*)"$/) || s.match(/^'(.*)'$/);
  return m ? m[1] : s;
}

// Filtered [key, value] pairs of an input control's notable (non-default) props.
function controlPropPairs(node, opts) {
  const out = [];
  for (const [k, v0] of node.props) {
    if (k === 'DisplayMode') continue;
    if (opts.hidePassthrough && isPassthrough(v0) && !isOnHandler(k)) continue;
    if (COSMETIC_PROPS.has(k)) continue;
    if (!FUNCTIONAL_PROPS.has(k) && !isOnHandler(k)) continue;
    if (k === 'Default' || k === 'DefaultSelectedItems' || k === 'DefaultDate') {
      if (isPassthrough(v0)) continue; // plumbing wiring to the card
    }
    if (k === 'Update' && !opts.includeUpdate) continue;
    if (k === 'Visible' && !opts.includeVisible) continue;
    if (k === 'DelayOutput' && !opts.includeDelayOutput) continue;
    if (isOnHandler(k) && !opts.includeEvents) continue;
    const v = collapseEnum(v0, opts);
    let val = String(stripFormula(v)).replace(/\s+/g, ' ').trim();
    if (opts.truncate && val.length > 80) val = val.slice(0, 77) + '…';
    out.push([k, val]);
  }
  return out;
}

// Build a compact "key: value" summary of an input control's notable props.
function controlPropSummary(node, opts) {
  return controlPropPairs(node, opts).map(([k, v]) => `${k}: ${v}`);
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildCardMarkdown(card, opts, idx) {
  const label = cardLabel(card.name);
  const field = unquote(stripFormula(getProp(card, 'DataField'))) || '';
  const bound = extractBoundColumn(card);
  const required = getProp(card, 'Required');
  const visible = getProp(card, 'Visible');
  const type = variantToType(card.variant, card.control);

  let inputs = card.children.filter((c) => !isJunkControl(c) && !isButton(c));
  // Build a per-control description.
  const controlDescr = inputs.map((c) => {
    const props = controlPropSummary(c, opts);
    const name = shortControl(c.control);
    let s = `**${c.name}** (${name})`;
    if (props.length) s += ': ' + props.join('; ');
    return s;
  });

  const cells = [];
  cells.push(String(idx));
  cells.push(mdEscape(label || card.name));
  cells.push(field ? '`' + mdEscape(field) + '`' : '—');
  if (opts.mdShowBound) cells.push(bound ? mdEscape(bound) : '—');
  cells.push(mdEscape(type));
  if (opts.mdShowRequired) cells.push(required === '=true' ? 'Yes' : required === '=false' ? 'No' : '—');
  if (opts.includeVisible) {
    let vis = '—';
    if (visible !== undefined && visible !== '=true') vis = '`' + mdEscape(stripFormula(visible)) + '`';
    else if (visible === '=true') vis = 'Yes';
    cells.push(vis);
  }
  cells.push(controlDescr.length ? controlDescr.map(mdEscape).join('<br>') : '—');
  return '| ' + cells.join(' | ') + ' |';
}

function buildButtonsMarkdown(buttons, opts) {
  const out = [];
  out.push(`### Buttons (${buttons.length})`);
  out.push('');
  const headers = ['#', 'Button', 'In Data Card', 'Text'];
  headers.push('OnSelect');
  headers.push('DisplayMode');
  if (opts.includeVisible) headers.push('Visible');
  headers.push('Other');
  out.push('| ' + headers.join(' | ') + ' |');
  out.push('| ' + headers.map(() => '---').join(' | ') + ' |');
  buttons.forEach((entry, idx) => {
    const b = entry.button;
    const cardName = entry.card ? cardLabel(entry.card.name) : '—';
    const text = unquote(stripFormula(getProp(b, 'Text')));
    const onSelect = getProp(b, 'OnSelect');
    const displayMode = getProp(b, 'DisplayMode');
    const visible = getProp(b, 'Visible');
    const other = controlPropSummary(b, opts).filter((s) => !/^(Text|OnSelect|Visible|DisplayMode):/.test(s));
    const cells = [String(idx + 1), mdEscape(b.name), mdEscape(cardName), text ? mdEscape(text) : '—'];
    cells.push(onSelect ? '`' + mdEscape(stripFormula(onSelect)) + '`' : '—');
    cells.push(displayMode ? '`' + mdEscape(stripFormula(displayMode)) + '`' : '—');
    if (opts.includeVisible) {
      let vis = '—';
      if (visible !== undefined && visible !== '=true') vis = '`' + mdEscape(stripFormula(visible)) + '`';
      else if (visible === '=true') vis = 'Yes';
      cells.push(vis);
    }
    cells.push(other.length ? mdEscape(other.join('; ')) : '—');
    out.push('| ' + cells.join(' | ') + ' |');
  });
  out.push('');
  return out;
}

// Diagnostics: required / hidden / conditional fields and duplicate bindings (#2).
function buildDiagnostics(cards, opts) {
  const out = ['### Diagnostics', ''];
  const required = cards.filter((c) => getProp(c, 'Required') === '=true').map((c) => cardLabel(c.name));
  const hidden = cards.filter((c) => getProp(c, 'Visible') === '=false').map((c) => cardLabel(c.name));
  const conditional = cards
    .filter((c) => { const v = getProp(c, 'Visible'); return v !== undefined && v !== '=true' && v !== '=false'; })
    .map((c) => `${cardLabel(c.name)} — \`${mdEscape(stripFormula(getProp(c, 'Visible')))}\``);
  const byField = {};
  for (const c of cards) {
    const f = unquote(stripFormula(getProp(c, 'DataField')) || '');
    if (!f) continue;
    (byField[f] = byField[f] || []).push(cardLabel(c.name));
  }
  const dups = Object.entries(byField).filter(([, v]) => v.length > 1);

  out.push(`- **Required fields (${required.length}):** ${required.length ? required.map(mdEscape).join(', ') : '—'}`);
  out.push(`- **Hidden cards (${hidden.length}):** ${hidden.length ? hidden.map(mdEscape).join(', ') : '—'}`);
  if (conditional.length) {
    out.push(`- **Conditionally visible (${conditional.length}):**`);
    conditional.forEach((c) => out.push(`  - ${c}`));
  }
  if (dups.length) {
    out.push('- **⚠️ Duplicate field bindings:**');
    dups.forEach(([f, names]) => out.push(`  - \`${mdEscape(f)}\` → ${names.map(mdEscape).join(', ')}`));
  }
  out.push('');
  return out;
}

// Build a documentation section for one set of cards (a form or standalone).
function buildFormSection(title, dataSource, cards, buttons, opts) {
  const out = [];
  out.push(`## ${title}`);
  out.push('');
  if (opts.mdShowDataSource && dataSource) {
    out.push(`**Data source (SharePoint list):** \`${mdEscape(dataSource)}\``);
    out.push('');
  }
  out.push(`**Cards:** ${cards.length}`);
  out.push('');

  const headers = ['#', 'Card', 'Field'];
  if (opts.mdShowBound) headers.push('Bound Column');
  headers.push('Type');
  if (opts.mdShowRequired) headers.push('Required');
  if (opts.includeVisible) headers.push('Visible');
  headers.push('Input Control(s) & Key Properties');
  out.push('| ' + headers.join(' | ') + ' |');
  out.push('| ' + headers.map(() => '---').join(' | ') + ' |');
  cards.forEach((c, idx) => out.push(buildCardMarkdown(c, opts, idx + 1)));
  out.push('');

  if (buttons && buttons.length) out.push(...buildButtonsMarkdown(buttons, opts));
  if (opts.includeDiagnostics) out.push(...buildDiagnostics(cards, opts));
  return out;
}

function buildMarkdown(nodes, opts) {
  const out = [];
  const forms = collectForms(nodes);
  for (const form of forms) {
    const cards = collectCards(form);
    if (!cards.length) continue;
    const dataSource = extractDataSource(getProp(form, 'DataSource'));
    const buttons = collectButtons(form, null, []);
    out.push(...buildFormSection(form.name, dataSource, cards, buttons, opts));
  }

  const standalone = collectStandaloneCards(nodes);
  if (standalone.length) {
    const buttons = [];
    for (const c of standalone) collectButtons(c, c, buttons);
    out.push(...buildFormSection('Data Cards', null, standalone, buttons, opts));
  }

  if (!out.length) return '_No forms or data cards found in the pasted YAML._\n';
  return out.join('\n').trim() + '\n';
}

/* ----------------------------------------------------------------------------
 * 6c. JSON export (#5)
 * --------------------------------------------------------------------------*/

function controlToObj(node, opts) {
  const props = {};
  for (const [k, v] of controlPropPairs(node, opts)) props[k] = v;
  return { name: node.name, type: shortControl(node.control), properties: props };
}

function cardToObj(card, opts) {
  const visible = getProp(card, 'Visible');
  const obj = {
    name: card.name,
    label: cardLabel(card.name),
    dataField: unquote(stripFormula(getProp(card, 'DataField'))) || null,
    boundColumn: extractBoundColumn(card) || null,
    type: variantToType(card.variant, card.control),
    required: getProp(card, 'Required') === '=true',
    visible: visible === undefined ? true : stripFormula(visible),
    controls: card.children.filter((c) => !isJunkControl(c) && !isButton(c)).map((c) => controlToObj(c, opts)),
  };
  return obj;
}

function buttonToObj(entry) {
  const b = entry.button;
  return {
    name: b.name,
    inDataCard: entry.card ? cardLabel(entry.card.name) : null,
    text: unquote(stripFormula(getProp(b, 'Text'))) || null,
    onSelect: getProp(b, 'OnSelect') ? stripFormula(getProp(b, 'OnSelect')) : null,
    displayMode: getProp(b, 'DisplayMode') ? stripFormula(getProp(b, 'DisplayMode')) : null,
    visible: getProp(b, 'Visible') === undefined ? true : stripFormula(getProp(b, 'Visible')),
  };
}

function buildJson(nodes, opts) {
  const forms = collectForms(nodes).map((form) => ({
    name: form.name,
    dataSource: extractDataSource(getProp(form, 'DataSource')),
    cards: collectCards(form).map((c) => cardToObj(c, opts)),
    buttons: collectButtons(form, null, []).map(buttonToObj),
  }));
  const result = { forms };
  const standalone = collectStandaloneCards(nodes);
  if (standalone.length) result.dataCards = standalone.map((c) => cardToObj(c, opts));
  return JSON.stringify(result, null, 2) + '\n';
}

/* ----------------------------------------------------------------------------
 * 6b. Tiny Markdown -> HTML renderer (handles the subset we emit:
 *     headings, **bold**, `code`, tables, <br>, paragraphs)
 * --------------------------------------------------------------------------*/

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdInline(s) {
  let h = escHtml(s);
  h = h.replace(/&lt;br&gt;/g, '<br>');        // restore intentional line breaks
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return h;
}

function splitRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function renderTable(lines) {
  const rows = lines.map(splitRow);
  const header = rows[0] || [];
  const body = rows.slice(2); // row 1 is the |---|---| separator
  let html = '<table><thead><tr>' + header.map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of body) html += '<tr>' + r.map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>';
  return html + '</tbody></table>';
}

function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let para = [];
  let i = 0;
  const flush = () => { if (para.length) { html += '<p>' + para.map(mdInline).join('<br>') + '</p>'; para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) { flush(); const lvl = head[1].length; html += `<h${lvl}>${mdInline(head[2])}</h${lvl}>`; i++; continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      const tbl = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { tbl.push(lines[i]); i++; }
      html += renderTable(tbl);
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return html;
}

/* ----------------------------------------------------------------------------
 * 7. Top-level convenience
 * --------------------------------------------------------------------------*/

// Rough token estimate (~4 chars/token) for the AI-context use case (#1).
function approxTokens(text) { return Math.max(1, Math.round(String(text).length / 4)); }
function statsFor(text, originalLen) {
  const chars = String(text).length;
  const reduction = originalLen > 0 ? Math.round((1 - chars / originalLen) * 100) : 0;
  return { chars, tokens: approxTokens(text), reduction };
}

function processYaml(text, opts) {
  const nodes = parseForm(text);
  const cleanedYaml = buildCleanedYaml(nodes, opts);
  const markdown = buildMarkdown(nodes, opts);
  const json = buildJson(nodes, opts);
  const sources = collectForms(nodes)
    .map((f) => extractDataSource(getProp(f, 'DataSource')))
    .filter(Boolean);
  const originalLen = String(text).length;
  const stats = {
    original: { chars: originalLen, tokens: approxTokens(text) },
    yaml: statsFor(cleanedYaml, originalLen),
    markdown: statsFor(markdown, originalLen),
    json: statsFor(json, originalLen),
  };
  return { nodes, cleanedYaml, markdown, json, sources, stats };
}

/* ----------------------------------------------------------------------------
 * 8. Exports (Node) / DOM wiring (browser)
 * --------------------------------------------------------------------------*/

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseYaml, parseForm, processYaml, buildCleanedYaml, buildMarkdown, buildJson,
    extractDataSource, variantToType, cardLabel, normalizeNode, renderMarkdown,
    collectForms, collectStandaloneCards, collectCards,
  };
}

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);

  const OPT_IDS = [
    'optHideCosmetic', 'optHideJunk', 'optHidePassthrough', 'optUpdate', 'optVisible',
    'optEvents', 'optDelayOutput', 'optCollapseEnums', 'optTruncate', 'optMdDataSource',
    'optMdBound', 'optMdRequired', 'optDiagnostics',
  ];
  const STORE_KEY = 'pa-yaml-cleaner';

  function readOpts() {
    return {
      hideCosmetic: $('optHideCosmetic').checked,
      hideJunkControls: $('optHideJunk').checked,
      hidePassthrough: $('optHidePassthrough').checked,
      includeUpdate: $('optUpdate').checked,
      includeVisible: $('optVisible').checked,
      includeEvents: $('optEvents').checked,
      includeDelayOutput: $('optDelayOutput').checked,
      collapseEnums: $('optCollapseEnums').checked,
      truncate: $('optTruncate').checked,
      includeDiagnostics: $('optDiagnostics').checked,
      mdShowDataSource: $('optMdDataSource').checked,
      mdShowBound: $('optMdBound').checked,
      mdShowRequired: $('optMdRequired').checked,
    };
  }

  // Persist filter checkboxes + last input across reloads (#6).
  function saveState() {
    try {
      const opts = {};
      OPT_IDS.forEach((id) => { opts[id] = $(id).checked; });
      localStorage.setItem(STORE_KEY, JSON.stringify({ opts, input: $('input').value }));
    } catch (e) { /* storage may be unavailable */ }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.opts) OPT_IDS.forEach((id) => { if (id in saved.opts) $(id).checked = saved.opts[id]; });
      if (typeof saved.input === 'string') $('input').value = saved.input;
    } catch (e) { /* ignore corrupt state */ }
  }

  function fmtStats(s) {
    const k = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
    const red = s.reduction > 0 ? ` · −${s.reduction}%` : '';
    return `${k(s.chars)} chars · ~${k(s.tokens)} tok${red}`;
  }

  let lastResult = null;

  // Fill a gutter element with line numbers matching the given text.
  function setGutter(gutterId, text) {
    const n = text === '' ? 1 : text.replace(/\n$/, '').split('\n').length;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    $(gutterId).textContent = s;
  }

  function run() {
    const text = $('input').value;
    const statusEl = $('status');
    setGutter('inputGutter', text);
    saveState();
    if (!text.trim()) {
      $('yamlOut').textContent = '';
      $('mdOut').textContent = '';
      $('jsonOut').textContent = '';
      $('mdPreview').innerHTML = '';
      setGutter('yamlGutter', '');
      setGutter('mdGutter', '');
      setGutter('jsonGutter', '');
      ['yamlStats', 'mdStats', 'jsonStats'].forEach((id) => { $(id).textContent = ''; });
      $('sourceBadge').textContent = '';
      statusEl.textContent = 'Paste some YAML to begin.';
      lastResult = null;
      return;
    }
    try {
      const opts = readOpts();
      const result = processYaml(text, opts);
      lastResult = result;
      $('yamlOut').textContent = result.cleanedYaml;
      $('mdOut').textContent = result.markdown;
      $('jsonOut').textContent = result.json;
      $('mdPreview').innerHTML = renderMarkdown(result.markdown);
      setGutter('yamlGutter', result.cleanedYaml);
      setGutter('mdGutter', result.markdown);
      setGutter('jsonGutter', result.json);
      $('yamlStats').textContent = fmtStats(result.stats.yaml);
      $('mdStats').textContent = fmtStats(result.stats.markdown);
      $('jsonStats').textContent = fmtStats(result.stats.json);

      const forms = collectForms(result.nodes);
      const cardCount = forms.reduce((a, f) => a + collectCards(f).length, 0)
        + collectStandaloneCards(result.nodes).length;
      $('sourceBadge').textContent = result.sources.length ? result.sources.join(', ') : '';
      const o = result.stats.original;
      statusEl.textContent =
        `${forms.length} form(s) · ${cardCount} data card(s) · input ~${Math.round(o.tokens / 100) / 10}k tokens → `
        + `YAML −${result.stats.yaml.reduction}% · MD −${result.stats.markdown.reduction}%`
        + (result.sources.length ? ` · Source: ${result.sources.join(', ')}` : '');
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
      console.error(err);
    }
  }

  // Trigger a file download of the given text (#7).
  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function copy(targetId, btn) {
    const text = $(targetId).textContent;
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
    });
  }

  // Keep a gutter scrolled in lock-step with its content element.
  function syncScroll(srcId, gutterId) {
    const src = $(srcId), gut = $(gutterId);
    src.addEventListener('scroll', () => { gut.scrollTop = src.scrollTop; });
  }

  document.addEventListener('DOMContentLoaded', () => {
    const onInput = debounce(run, 200);
    $('input').addEventListener('input', onInput);
    // Update the input gutter immediately (not debounced) so numbers track typing.
    $('input').addEventListener('input', () => setGutter('inputGutter', $('input').value));
    document.querySelectorAll('.opt').forEach((el) => el.addEventListener('change', run));
    $('copyYaml').addEventListener('click', (e) => copy('yamlOut', e.currentTarget));
    $('copyMd').addEventListener('click', (e) => copy('mdOut', e.currentTarget));
    $('copyJson').addEventListener('click', (e) => copy('jsonOut', e.currentTarget));
    $('dlYaml').addEventListener('click', () => download('cleaned.pa.yaml', $('yamlOut').textContent));
    $('dlMd').addEventListener('click', () => download('form-docs.md', $('mdOut').textContent));
    $('dlJson').addEventListener('click', () => download('form.json', $('jsonOut').textContent));
    $('clearBtn').addEventListener('click', () => { $('input').value = ''; run(); });

    syncScroll('input', 'inputGutter');
    syncScroll('yamlOut', 'yamlGutter');
    syncScroll('mdOut', 'mdGutter');
    syncScroll('jsonOut', 'jsonGutter');

    // Draggable splitter to resize the two panes.
    (function setupSplitter() {
      const splitter = $('splitter');
      const workspace = document.querySelector('.workspace');
      let dragging = false;
      const onMove = (clientX) => {
        const rect = workspace.getBoundingClientRect();
        const min = 220, max = rect.width - 280;
        let left = clientX - rect.left;
        left = Math.max(min, Math.min(max, left));
        workspace.style.setProperty('--leftw', left + 'px');
      };
      const start = (e) => {
        dragging = true;
        splitter.classList.add('dragging');
        document.body.classList.add('resizing');
        e.preventDefault();
      };
      const stop = () => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove('dragging');
        document.body.classList.remove('resizing');
      };
      splitter.addEventListener('mousedown', start);
      document.addEventListener('mousemove', (e) => { if (dragging) onMove(e.clientX); });
      document.addEventListener('mouseup', stop);
      // Touch support
      splitter.addEventListener('touchstart', start, { passive: false });
      document.addEventListener('touchmove', (e) => { if (dragging) onMove(e.touches[0].clientX); });
      document.addEventListener('touchend', stop);
      // Double-click resets to 50/50.
      splitter.addEventListener('dblclick', () => workspace.style.removeProperty('--leftw'));
    })();

    // Markdown Preview / Source toggle
    $('mdPreviewBtn').addEventListener('click', () => {
      $('mdPreviewBtn').classList.add('active');
      $('mdSourceBtn').classList.remove('active');
      $('mdPreview').style.display = '';
      $('mdSourceView').style.display = 'none';
    });
    $('mdSourceBtn').addEventListener('click', () => {
      $('mdSourceBtn').classList.add('active');
      $('mdPreviewBtn').classList.remove('active');
      $('mdPreview').style.display = 'none';
      $('mdSourceView').style.display = 'flex';
    });
    // Tabs
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.pane').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        $(tab.dataset.target).classList.add('active');
      });
    });

    loadState();
    run();
    // Focus the paste box, cursor at the end of any restored text.
    const ta = $('input');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
}
