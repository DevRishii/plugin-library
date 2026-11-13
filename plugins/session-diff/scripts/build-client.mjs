#!/usr/bin/env node
/**
 * build-client — regenerate the dictionaries `client.js` embeds from `locale/*.json`.
 *
 * `client.js` ships self-contained: it carries `const en` / `const zh` copies of
 * the locale dictionaries instead of loading the JSON files at runtime, so the
 * bundle must be regenerated after any locale edit. That generated relationship
 * is what `dsh-doctor`'s `plugin.client-bundle-stale` check guards against.
 *
 * Usage
 *   node scripts/build-client.mjs           rewrite client.js from locale/*.json
 *   node scripts/build-client.mjs --check   verify only; exit 1 when stale
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(ROOT, 'client.js')
const LANGUAGES = ['en', 'zh']
const INDENT = ' '.repeat(6)

/**
 * Read one locale dictionary, rejecting a `meta` block the bundle never carries.
 * @param language - locale code.
 * @returns the translation dictionary.
 */
function readDictionary(language) {
  const path = join(ROOT, 'locale', `${language}.json`)
  const dictionary = JSON.parse(readFileSync(path, 'utf8'))
  if (Object.hasOwn(dictionary, 'meta')) {
    throw new Error(`${path} carries "meta"; the bundle embeds translations only`)
  }
  return dictionary
}

/**
 * Render the `const <language> = { … }` block in the bundle's own formatting:
 * six-space entries, a comma between them, none after the last one.
 * @param language - locale code the block is bound to.
 * @param dictionary - translations to render.
 * @returns the block, trailing newline included.
 */
function renderBlock(language, dictionary) {
  const entries = Object.entries(dictionary).map(
    ([key, value]) => `${INDENT}${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  )
  return [`    const ${language} = {`, entries.join(',\n'), '    };'].join('\n') + '\n'
}

/**
 * Replace the existing dictionary block; refuse a bundle that has none.
 * @param text - bundle source.
 * @param language - locale code whose block to replace.
 * @param block - replacement block.
 * @returns the updated bundle source.
 */
function replaceBlock(text, language, block) {
  const pattern = new RegExp(`^ {4}const ${language} = \\{\\n[\\s\\S]*?^ {4}\\};\\n`, 'm')
  if (!pattern.test(text)) {
    throw new Error(`client.js has no \`const ${language}\` dictionary block to replace`)
  }
  return text.replace(pattern, block)
}

/**
 * Describe the first line that differs, so a stale bundle is diagnosable.
 * @param before - current bundle source.
 * @param after - regenerated bundle source.
 * @returns a one-line description of the first difference.
 */
function firstDifference(before, after) {
  const left = before.split('\n')
  const right = after.split('\n')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return `line ${index + 1}: bundle ${JSON.stringify(left[index] ?? '')} vs source ${JSON.stringify(right[index] ?? '')}`
    }
  }
  return 'no line differs'
}

const dictionaries = Object.fromEntries(
  LANGUAGES.map((language) => [language, readDictionary(language)]),
)
const [englishKeys, chineseKeys] = LANGUAGES.map((language) =>
  Object.keys(dictionaries[language]).sort(),
)
if (englishKeys.join('\n') !== chineseKeys.join('\n')) {
  throw new Error('locale/*.json disagree on their key set')
}

const original = readFileSync(BUNDLE, 'utf8')
let next = original
for (const language of LANGUAGES) {
  next = replaceBlock(next, language, renderBlock(language, dictionaries[language]))
}

const stale = next !== original
if (process.argv.includes('--check')) {
  console.log(
    stale
      ? `client.js is stale relative to locale/*.json (${firstDifference(original, next)}); run this script without --check`
      : 'client.js matches locale/*.json',
  )
  process.exit(stale ? 1 : 0)
}

writeFileSync(BUNDLE, next)
console.log(
  stale
    ? 'client.js rebuilt from locale/*.json'
    : 'client.js content already matched locale/*.json; bundle re-stamped',
)
