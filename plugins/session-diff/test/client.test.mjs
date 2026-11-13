/**
 * Client-module contract test: load `client.js` in a browser-ish module-loader
 * environment, boot `apply()` over a fake client context, and check the tab,
 * header action, and locale dictionaries without rendering React.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/** The module entry `window.__ModuleLoader__.load` captured. */
let captured = null

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry
    },
  },
}

await import('../client.js?test=1')

/** Minimal React surface the factory touches; no component is rendered here. */
const ReactStub = {
  createElement: () => null,
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

/**
 * Resolve the React stub from the factory's `require`.
 * @param id - module specifier.
 * @returns the stub.
 */
function reactRequire(id) {
  if (id === 'react') return ReactStub
  throw new Error(`unexpected require(${JSON.stringify(id)})`)
}

/**
 * Build a Cordis-shaped client context that records every registration.
 * @returns the fake context and its captured registries.
 */
function makeContext() {
  const dictionaries = new Map()
  const tabs = []
  const entries = []
  const openTabs = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, value) {
        dictionaries.set(namespace, value)
        return () => {}
      },
      bind(namespace) {
        return (key, params) => {
          const dictionary = dictionaries.get(namespace)
          const source = dictionary === undefined ? undefined : dictionary.en
          const recorded = source === undefined ? undefined : source[key]
          const template = typeof recorded === 'string' ? recorded : key
          if (params === undefined) return template
          return template.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
        }
      },
    },
    slots: {
      inject(name, factory) {
        return factory()
      },
      register(definition, component) {
        entries.push({ definition, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabs.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab(kind) {
        openTabs.push(kind)
        return kind
      },
    },
  }
  return { ctx, dictionaries, tabs, entries, openTabs }
}

/**
 * Read one locale JSON file.
 * @param relative - path relative to this test file.
 * @returns the parsed dictionary.
 */
function readJson(relative) {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'))
}

/**
 * Drop plugin display metadata so only translation keys are compared.
 * @param dictionary - parsed locale or registered dictionary.
 * @returns a shallow copy without `meta`.
 */
function translations(dictionary) {
  return Object.fromEntries(Object.entries(dictionary).filter(([key]) => key !== 'meta'))
}

test('the module registers a receipt tab and a header opener, and apply opens nothing', () => {
  assert.ok(captured !== null, 'window.__ModuleLoader__.load was never called')
  assert.equal(captured.id, '@local/session-diff')

  const plugin = captured.factory(reactRequire)
  assert.ok(plugin !== null && typeof plugin === 'object')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'sidebarRight', 'sidebarRightTabs'])

  const fake = makeContext()
  plugin.apply(fake.ctx)
  assert.deepEqual(fake.openTabs, [], 'apply must not open a tab during registration')

  assert.equal(fake.tabs.length, 1)
  const tab = fake.tabs[0]
  assert.equal(tab.id, '@local/session-diff')
  assert.equal(tab.kind, 'receipt')
  assert.equal(tab.title(), 'Receipt')

  const bodies = fake.entries.filter((entry) => entry.definition.name === 'sidebar.right.pane.tab')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].definition.key, '@local/session-diff')
  assert.equal(bodies[0].definition.locale, 'session-diff')
  assert.equal(typeof bodies[0].component, 'function')

  const actions = fake.entries.filter((entry) => entry.definition.name === 'conversation.session.header.actions')
  assert.equal(actions.length, 1)
  assert.equal(actions[0].definition.id, 'session-diff')
  const injected = actions[0].definition.inject()
  assert.equal(typeof injected.openReceipt, 'function')

  injected.openReceipt()
  assert.deepEqual(fake.openTabs, ['receipt'])

  fake.ctx.sidebarRight.openTab = () => {
    throw new Error('sidebar unavailable')
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => injected.openReceipt(), 'a failed openTab must be contained')
  } finally {
    console.warn = warn
  }
})

test('the locale files are key-identical and match the registered dictionaries', () => {
  const plugin = captured.factory(reactRequire)
  const fake = makeContext()
  plugin.apply(fake.ctx)

  const dictionaries = fake.dictionaries.get('session-diff')
  assert.ok(dictionaries !== undefined)
  const enFile = translations(readJson('../locale/en.json'))
  const zhFile = translations(readJson('../locale/zh.json'))
  assert.deepEqual(Object.keys(enFile).sort(), Object.keys(zhFile).sort())
  assert.deepEqual(translations(dictionaries.en), enFile)
  assert.deepEqual(translations(dictionaries.zh), zhFile)
})

test('every t() key in client.js exists in both locale files', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const keys = new Set([...source.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1]))
  assert.ok(keys.size > 20, `expected many translation keys, found ${keys.size}`)

  const enFile = translations(readJson('../locale/en.json'))
  const zhFile = translations(readJson('../locale/zh.json'))
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(enFile, key), `missing en key: ${key}`)
    assert.ok(Object.prototype.hasOwnProperty.call(zhFile, key), `missing zh key: ${key}`)
  }
})
