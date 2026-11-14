import {
  ERROR_CODES,
  EXIT_CODES,
  VaultError,
  estimateTokens,
  toPosixPath,
} from './shared.mjs';

/**
 * @param {string[]} items
 * @returns {string[]}
 */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = String(item ?? '').trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Render a `path#symbol` pointer, resolving the line range from the index when
 * possible so the digest stays a pointer rather than a body copy.
 *
 * @param { { symbols: Record<string, any[]>, files: any[] } } index
 * @param {string} ref
 */
function symbolPointer(index, ref) {
  const raw = String(ref ?? '');
  const hashIdx = raw.indexOf('#');
  if (hashIdx === -1) return raw;
  const pathPart = toPosixPath(raw.slice(0, hashIdx));
  const symbolPart = raw.slice(hashIdx + 1).split(':')[0];
  let range = '';

  const symbolRows = index.symbols[symbolPart];
  if (Array.isArray(symbolRows)) {
    const hit = symbolRows.find((row) => toPosixPath(row?.path) === pathPart);
    if (hit && typeof hit.line === 'number') {
      const end = typeof hit.end_line === 'number' ? hit.end_line : hit.line;
      range = `:L${hit.line}-${end}`;
    }
  }

  if (range === '') {
    const fileEntry = index.files.find((file) => toPosixPath(file.path) === pathPart);
    const exp = Array.isArray(fileEntry?.exports)
      ? fileEntry.exports.find((candidate) => candidate?.name === symbolPart)
      : null;
    if (exp && typeof exp.line === 'number') {
      const end = typeof exp.end_line === 'number' ? exp.end_line : exp.line;
      range = `:L${exp.line}-${end}`;
    }
  }

  return `${pathPart}#${symbolPart}${range}`;
}

/**
 * @param { { notes: any[] } } index
 * @param {string} id
 */
function notePointer(index, id) {
  const linked = index.notes.find((note) => note.id === id);
  if (!linked) return `[[${id}]]`;
  return `[[${id}]] ${toPosixPath(linked.path)} - ${linked.summary || linked.title || id}`;
}

/**
 * Synthesize at most five pointers from depends_on, contracts and related when
 * the note does not author its own `read_first` list.
 *
 * @param { { notes: any[], symbols: Record<string, any[]>, files: any[] } } index
 * @param {any} note
 */
function synthesizeReadFirst(index, note) {
  const items = [];

  for (const id of Array.isArray(note.depends_on) ? note.depends_on : []) {
    items.push(notePointer(index, id));
  }
  for (const contract of Array.isArray(note.contracts) ? note.contracts : []) {
    const linked = index.notes.find((candidate) => candidate.id === contract);
    if (linked) {
      items.push(notePointer(index, contract));
    } else if (String(contract).includes('#')) {
      items.push(symbolPointer(index, contract));
    } else {
      items.push(String(contract));
    }
  }
  for (const id of Array.isArray(note.related) ? note.related : []) {
    items.push(notePointer(index, id));
  }

  return dedupe(items).slice(0, 5);
}

/**
 * Combine explicit contract ids with contract-type depends_on notes, keeping
 * short path/summary pointers only.
 *
 * @param { { notes: any[] } } index
 * @param {any} note
 */
function buildReadOnlyContracts(index, note) {
  const items = [];

  for (const contract of Array.isArray(note.contracts) ? note.contracts : []) {
    const linked = index.notes.find((candidate) => candidate.id === contract);
    if (linked) {
      items.push(`${contract} - ${toPosixPath(linked.path)} (${linked.summary || linked.title})`);
    } else {
      items.push(String(contract));
    }
  }

  for (const id of Array.isArray(note.depends_on) ? note.depends_on : []) {
    const linked = index.notes.find((candidate) => candidate.id === id);
    if (linked && linked.type === 'contract') {
      items.push(`${id} - ${toPosixPath(linked.path)} (${linked.summary || linked.title})`);
    }
  }

  return dedupe(items);
}

/**
 * Build the pointer-only digest for a note. Note bodies and source text never
 * enter this structure.
 *
 * @param { { notes: any[], symbols: Record<string, any[]>, files: any[] } } index
 * @param {any} note
 */
export function buildDigest(index, note) {
  const authored = Array.isArray(note.read_first) ? note.read_first.filter(Boolean) : [];
  const readFirst = authored.length > 0 ? authored.slice(0, 5).map(String) : synthesizeReadFirst(index, note);

  const ownedPaths =
    Array.isArray(note.paths) && note.paths.length > 0 ? note.paths.map(String) : ['(none)'];
  const contracts = buildReadOnlyContracts(index, note);
  const acceptance =
    Array.isArray(note.acceptance) && note.acceptance.length > 0
      ? note.acceptance.map(String)
      : ['(see slice spec)'];
  const openDecisions =
    Array.isArray(note.open_decisions) && note.open_decisions.length > 0
      ? note.open_decisions.map(String)
      : ['none'];

  return {
    id: String(note.id ?? ''),
    goal: String(note.summary || note.title || note.id || ''),
    status: String(note.status ?? ''),
    owner: String(note.owner ?? ''),
    read_first: readFirst.slice(0, 5),
    owned_paths: ownedPaths,
    read_only_contracts: contracts.length > 0 ? contracts : ['(none)'],
    acceptance,
    open_decisions: openDecisions,
  };
}

/**
 * @param {string[]} lines
 * @param {string[]} items
 */
function appendList(lines, items) {
  for (const item of items) lines.push(`- ${item}`);
}

/**
 * Fixed section order. `tokens` is embedded in the status line, so callers must
 * iterate render -> estimate until the number stabilises.
 *
 * @param {ReturnType<typeof buildDigest>} digest
 * @param {number} tokens
 * @param {boolean} truncated
 */
export function renderBriefMarkdown(digest, tokens, truncated) {
  const lines = [
    `# brief: ${digest.id}`,
    `goal: ${digest.goal}`,
    `status: ${digest.status} · owner: ${digest.owner} · tokens: ${tokens} (estimate)`,
    '## read_first (max 5)',
  ];
  appendList(lines, digest.read_first);
  lines.push('## owned_paths');
  appendList(lines, digest.owned_paths);
  lines.push('## read_only_contracts');
  appendList(lines, digest.read_only_contracts);
  lines.push('## acceptance');
  appendList(lines, digest.acceptance);
  lines.push('## open_decisions');
  appendList(lines, digest.open_decisions);
  if (truncated) lines.push('truncated: true');
  return `${lines.join('\n')}\n`;
}

/**
 * Render until the embedded token count matches the estimate of the rendered
 * text (stable within a handful of iterations because only digit width moves).
 *
 * @param {ReturnType<typeof buildDigest>} digest
 * @param {boolean} truncated
 */
function renderStable(digest, truncated) {
  let tokens = 0;
  let markdown = '';
  for (let i = 0; i < 8; i += 1) {
    markdown = renderBriefMarkdown(digest, tokens, truncated);
    const next = estimateTokens(markdown);
    if (next === tokens) break;
    tokens = next;
  }
  return { markdown, tokens };
}

/**
 * @param {ReturnType<typeof buildDigest>} digest
 */
function cloneDigest(digest) {
  return {
    ...digest,
    read_first: [...digest.read_first],
    owned_paths: [...digest.owned_paths],
    read_only_contracts: [...digest.read_only_contracts],
    acceptance: [...digest.acceptance],
    open_decisions: [...digest.open_decisions],
  };
}

/**
 * Enforce the brief token budget. Truncation order is fixed:
 * open_decisions -> read_first (trailing) -> owned_paths/read_only_contracts
 * (trailing). If even the minimal skeleton exceeds the budget, exit 2.
 *
 * @param {ReturnType<typeof buildDigest>} digest
 * @param {number} budget
 */
export function fitBriefToBudget(digest, budget) {
  const initial = renderStable(digest, false);
  if (initial.tokens <= budget) {
    return { ...initial, truncated: false, digest };
  }

  const work = cloneDigest(digest);
  let current = renderStable(work, true);

  while (current.tokens > budget && work.open_decisions.length > 0) {
    work.open_decisions.pop();
    current = renderStable(work, true);
  }

  while (current.tokens > budget && work.read_first.length > 0) {
    work.read_first.pop();
    current = renderStable(work, true);
  }

  while (current.tokens > budget && work.owned_paths.length > 0) {
    work.owned_paths.pop();
    current = renderStable(work, true);
  }

  if (current.tokens > budget) {
    throw new VaultError(
      EXIT_CODES.VALIDATION,
      ERROR_CODES.BUDGET_EXCEEDED,
      `brief exceeds ${budget}-token budget after truncation (${current.tokens} est. tokens)`,
    );
  }

  return { ...current, truncated: true, digest: work };
}
