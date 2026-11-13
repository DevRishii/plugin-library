const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Parse a bare semantic version.
 *
 * Build metadata is accepted and discarded; it does not participate in precedence.
 *
 * @param {string} text Version such as `0.2.2-rc.1` or `0.2.2+build.5`.
 * @returns {{major: number, minor: number, patch: number, pre: string[]} | null}
 *   Parsed version, or `null` when the text is not a bare version.
 */
export function parseVersion(text) {
  const match = VERSION.exec(String(text ?? '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Compare two parsed versions using semantic-version ordering.
 *
 * @param {{major: number, minor: number, patch: number, pre: string[]}} left
 * @param {{major: number, minor: number, patch: number, pre: string[]}} right
 * @returns {number} Negative when `left` precedes `right`, positive when it follows.
 */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

/**
 * Parse a restricted comparison range.
 *
 * Supports `*`, bare versions, and space-separated comparators using
 * `>=`, `<=`, `>`, `<`, `=`, `^`, and `~`.
 *
 * @param {string} range Range text.
 * @returns {{any: boolean, comparators: {op: string, version: object}[]} | null}
 *   Parsed range, or `null` when the text is not a range this module understands.
 */
export function parseRange(range) {
  const text = String(range ?? '').trim();
  if (text === '' || text === '*' || text.toLowerCase() === 'x') {
    return { any: true, comparators: [] };
  }
  // Join an operator to its version so `>= 1.0.0` parses like `>=1.0.0`.
  const normalized = text.replace(/([<>=^~]+)\s+/g, '$1');
  const comparators = [];
  for (const token of normalized.split(/\s+/)) {
    const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
    if (!match) return null;
    const operator = match[1] ?? '=';
    const version = parseVersion(match[2]);
    if (!version) return null;
    if (operator === '^') {
      comparators.push({ op: '>=', version });
      comparators.push({ op: '<', version: caretUpperBound(version) });
    } else if (operator === '~') {
      comparators.push({ op: '>=', version });
      comparators.push({
        op: '<',
        version: { major: version.major, minor: version.minor + 1, patch: 0, pre: [] },
      });
    } else {
      comparators.push({ op: operator, version });
    }
  }
  return { any: false, comparators };
}

/**
 * Compute the exclusive upper bound a caret range implies.
 *
 * Caret allows changes that do not modify the leftmost non-zero component, so
 * `^0.0.3` stops at `0.0.4` rather than at `0.1.0`.
 *
 * @param {{major: number, minor: number, patch: number}} version Lower bound.
 * @returns {{major: number, minor: number, patch: number, pre: string[]}} Exclusive upper bound.
 */
function caretUpperBound(version) {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, pre: [] };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, pre: [] };
  return { major: 0, minor: 0, patch: version.patch + 1, pre: [] };
}

/**
 * Test whether a version falls inside a range.
 *
 * @param {string} versionText Installed version.
 * @param {string} rangeText Declared range.
 * @returns {boolean} `true` when the version satisfies every comparator.
 */
export function satisfiesRange(versionText, rangeText) {
  const version = parseVersion(versionText);
  const range = parseRange(rangeText);
  if (!version || !range) return false;
  if (range.any) return true;
  return range.comparators.every(({ op, version: bound }) => {
    const order = compareVersions(version, bound);
    if (op === '>=') return order >= 0;
    if (op === '>') return order > 0;
    if (op === '<=') return order <= 0;
    if (op === '<') return order < 0;
    return order === 0;
  });
}
