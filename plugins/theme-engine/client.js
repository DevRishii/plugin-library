window.__ModuleLoader__.load({
  id: '@local/theme-engine',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin's settings row. */
    const NS = 'theme-engine';
    /** Override-layer identity; one layer per source in the theme runtime. */
    const SOURCE = '@local/theme-engine';
    /** Browser-local record of the chosen preset (third-party ids are not part of the built-in settings schema). */
    const STORAGE_KEY = 'dsh-theme-engine.preset';

    /**
     * Alias tokens in the order every preset's `dark` and `light` arrays use.
     * Only documented alias tokens are overridden; the bundled palettes below
     * still decide surfaces and labels the base sheets paint.
     */
    const TOKENS = [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-overlay',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-idle-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-specific-sidebar-fill',
    ];

    /**
     * Preset palettes: 14 alias tokens per color scheme, in {@link TOKENS}
     * order. Light and dark pairs keep the override layer valid under every
     * Appearance choice, including `system`.
     */
    const PRESETS = [
      {
        id: 'night-owl',
        name: 'Night Owl',
        dark: [
          '#011627', '#0b2942', '#0f2d44', '#0b2942', '#1d3b53', '#294d6b', '#82aaff',
          '#d6deeb', '#7e9bb5', '#ff5874', '#5f7e97', '#addb67', '#ecc48d', '#01111d',
        ],
        light: [
          '#f5f7fb', '#ffffff', '#e9eef5', '#ffffff', '#cfdae6', '#b3c4d6', '#2f6fb3',
          '#0b2942', '#4a6478', '#c53030', '#8296a8', '#4f7d1f', '#a86b12', '#eef3f9',
        ],
      },
      {
        id: 'tokyo-night-storm',
        name: 'Tokyo Night Storm',
        dark: [
          '#24283b', '#2f334d', '#1f2335', '#2f334d', '#3b4261', '#545c7e', '#7aa2f7',
          '#c0caf5', '#9aa5ce', '#f7768e', '#565f89', '#9ece6a', '#e0af68', '#1f2335',
        ],
        light: [
          '#e6e7ed', '#f6f6f9', '#dfe0e8', '#ffffff', '#c4c8da', '#a8afc8', '#2e5fbf',
          '#343b58', '#5c6390', '#d0244a', '#7b83a8', '#4e7d2f', '#8c6c3e', '#dcdee8',
        ],
      },
      {
        id: 'dracula',
        name: 'Dracula',
        dark: [
          '#282a36', '#343746', '#21222c', '#343746', '#44475a', '#6272a4', '#bd93f9',
          '#f8f8f2', '#a8b0d6', '#ff5555', '#6272a4', '#50fa7b', '#ffb86c', '#21222c',
        ],
        light: [
          '#f7f7fb', '#ffffff', '#ececf4', '#ffffff', '#d6d6e3', '#b9b9cc', '#644ac9',
          '#1f1f28', '#565672', '#cb3a2a', '#8f8fa8', '#14710a', '#a34d14', '#ededf5',
        ],
      },
      {
        id: 'nord',
        name: 'Nord',
        dark: [
          '#2e3440', '#3b4252', '#434c5e', '#3b4252', '#434c5e', '#4c566a', '#88c0d0',
          '#eceff4', '#b6c0d0', '#bf616a', '#8a97a8', '#a3be8c', '#ebcb8b', '#2b303b',
        ],
        light: [
          '#eceff4', '#ffffff', '#e5e9f0', '#ffffff', '#d8dee9', '#c2cad6', '#5e81ac',
          '#2e3440', '#4c566a', '#bf616a', '#8f9aab', '#6d8f54', '#c08a3e', '#e5e9f0',
        ],
      },
      {
        id: 'solarized',
        name: 'Solarized',
        dark: [
          '#002b36', '#073642', '#0a3a46', '#073642', '#0f4152', '#14505f', '#268bd2',
          '#bcc9c6', '#7d9491', '#dc322f', '#586e75', '#859900', '#b58900', '#001f28',
        ],
        light: [
          '#fdf6e3', '#eee8d5', '#f7f0dc', '#fffbf0', '#e6dfc9', '#d3cbb1', '#268bd2',
          '#586e75', '#6b8184', '#dc322f', '#93a1a1', '#859900', '#b58900', '#eee8d5',
        ],
      },
      {
        id: 'gruvbox',
        name: 'Gruvbox',
        dark: [
          '#282828', '#3c3836', '#32302f', '#3c3836', '#504945', '#665c54', '#fe8019',
          '#ebdbb2', '#a89984', '#fb4934', '#928374', '#b8bb26', '#fabd2f', '#1d2021',
        ],
        light: [
          '#fbf1c7', '#f2e5bc', '#ebdbb2', '#f9f5d7', '#e5d5a8', '#d5c4a1', '#af3a03',
          '#3c3836', '#7c6f64', '#9d0006', '#928374', '#79740e', '#b57614', '#f2e5bc',
        ],
      },
      {
        id: 'one-dark',
        name: 'One Dark',
        dark: [
          '#282c34', '#2c313a', '#21252b', '#2c313a', '#3a404c', '#4b5263', '#61afef',
          '#abb2bf', '#939aa6', '#e06c75', '#5c6370', '#98c379', '#e5c07b', '#21252b',
        ],
        light: [
          '#fafafa', '#f0f0f0', '#e5e5e6', '#ffffff', '#dbdbdc', '#c9c9ca', '#4078f2',
          '#383a42', '#696c77', '#e45649', '#a0a1a7', '#50a14f', '#c18401', '#eaeaeb',
        ],
      },
      {
        id: 'catppuccin',
        name: 'Catppuccin',
        dark: [
          '#1e1e2e', '#313244', '#181825', '#313244', '#313244', '#45475a', '#cba6f7',
          '#cdd6f4', '#a6adc8', '#f38ba8', '#7f849c', '#a6e3a1', '#f9e2af', '#181825',
        ],
        light: [
          '#eff1f5', '#e6e9ef', '#dce0e8', '#ffffff', '#ccd0da', '#bcc0cc', '#8839ef',
          '#4c4f69', '#6c6f85', '#d20f39', '#8c8fa1', '#40a02b', '#df8e1d', '#e6e9ef',
        ],
      },
    ];

    /**
     * Turn one preset's parallel color arrays into the theme runtime's
     * token -> { light, dark } override map.
     * @param preset - catalog entry with `light` and `dark` arrays.
     * @returns token overrides for the given preset.
     */
    function toTokens(preset) {
      const tokens = {};
      for (let index = 0; index < TOKENS.length; index += 1) {
        tokens[TOKENS[index]] = { light: preset.light[index], dark: preset.dark[index] };
      }
      return tokens;
    }

    const CATALOG = PRESETS.map((preset) => ({ ...preset, tokens: toTokens(preset) }));
    const BY_ID = new Map(CATALOG.map((preset) => [preset.id, preset]));

    /** English copy; the zh dictionary below mirrors its key set. */
    const en = {
      title: 'Theme presets',
      description: 'Recolor the interface with a preset palette. Each preset defines both a light and a dark variant, so Appearance still decides which one you see.',
      reset: 'Reset',
    };
    /** Simplified Chinese copy. */
    const zh = {
      title: '主题预设',
      description: '用预设配色为界面重新着色。每套预设都包含浅色与深色两种配色，实际显示哪一套由“外观”设置决定。',
      reset: '重置',
    };
    /** Fallback copy for a run without the locale service. */
    const FALLBACK = {
      title: 'Theme presets',
      description: 'Recolor the interface with a preset palette.',
      reset: 'Reset',
    };

    /** Read the last applied preset id, ignoring unknown or stale values. */
    function readSaved() {
      try {
        const id = window.localStorage.getItem(STORAGE_KEY);
        return id !== null && BY_ID.has(id) ? id : null;
      } catch (error) {
        return null;
      }
    }

    /** Persist the selection for this browser; failure keeps it page-local. */
    function writeSaved(id) {
      try {
        if (id === null) window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, id);
      } catch (error) {
        /* Storage is unavailable in some sandboxes; the choice lasts for this page. */
      }
    }

    /** Component-local sheet; unmounting the row removes it with the component. */
    const CSS = `
.dte-row{display:flex;flex-direction:column;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dte-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dte-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.dte-reset{border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:13px;line-height:20px;padding:2px 6px;border-radius:var(--dsw-radius-s,6px);cursor:pointer}
@media (hover:hover){.dte-reset:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.dte-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dte-grid{display:flex;flex-wrap:wrap;gap:8px}
.dte-card{box-sizing:border-box;flex:1 1 148px;max-width:216px;min-width:128px;display:flex;flex-direction:column;gap:8px;padding:8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-l,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}
@media (hover:hover){.dte-card:hover:not(.dte-selected){background:var(--dsw-alias-interactive-bg-hover)}}
.dte-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dte-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary)}
.dte-preview{display:flex;height:56px;border-radius:calc(var(--dsw-radius-l,10px) - 4px);overflow:hidden;border:.5px solid rgba(127,127,127,.2)}
.dte-half{display:flex;flex:1;min-width:0}
.dte-rail{width:14px;height:100%;flex:none}
.dte-body{display:flex;flex:1;min-width:0;padding:6px}
.dte-panel{display:flex;flex:1;flex-direction:column;justify-content:center;gap:4px;min-width:0;padding:0 6px;border-radius:3px}
.dte-bar{width:80%;height:4px;border-radius:2px;opacity:.7}
.dte-bar2{width:55%;opacity:.45}
.dte-accent{width:38%;height:3px;border-radius:2px;opacity:.9}
.dte-name{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:12px;line-height:18px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dte-check{color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px;flex:none}
`;

    /**
     * Miniature split preview: the preset's dark variant beside its light one,
     * each drawn from its own palette (artwork colors, not host tokens).
     * @param props - `preset` catalog entry.
     * @returns the preview element tree.
     */
    function Preview({ preset }) {
      const half = (colors, key) => h('div', {
        className: 'dte-half',
        key,
        style: { background: colors[0] },
      }, [
        h('div', { className: 'dte-rail', key: 'rail', style: { background: colors[13] } }),
        h('div', { className: 'dte-body', key: 'body' }, h('div', {
          className: 'dte-panel',
          style: { background: colors[1] },
        }, [
          h('div', { className: 'dte-bar', key: 'bar1', style: { background: colors[7] } }),
          h('div', { className: 'dte-bar dte-bar2', key: 'bar2', style: { background: colors[8] } }),
          h('div', { className: 'dte-accent', key: 'accent', style: { background: colors[6] } }),
        ])),
      ]);
      return h('div', { className: 'dte-preview' }, [
        half(preset.dark, 'dark'),
        half(preset.light, 'light'),
      ]);
    }

    /**
     * One selectable preset chip.
     * @param props - preset, selected flag, and the select callback.
     * @returns the card button.
     */
    function PresetCard({ preset, selected, onSelect }) {
      return h('button', {
        type: 'button',
        className: selected ? 'dte-card dte-selected' : 'dte-card',
        'aria-pressed': selected,
        onClick: () => onSelect(preset.id),
      }, [
        h(Preview, { key: 'preview', preset }),
        h('span', { className: 'dte-name', key: 'name' }, [
          h('span', { key: 'label' }, preset.name),
          selected ? h('span', { className: 'dte-check', key: 'check', 'aria-hidden': true }, '✓') : null,
        ]),
      ]);
    }

    /**
     * General-settings row: preset gallery plus reset.
     * @param props - locale translator and the injected preset actions.
     * @returns the row element tree.
     */
    function PresetRow(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => FALLBACK[key] ?? key;
      const readActive = typeof props.getActivePreset === 'function' ? props.getActivePreset : () => null;
      const [active, setActive] = React.useState(readActive);
      const choose = (id) => {
        if (typeof props.applyPreset === 'function') props.applyPreset(id);
        setActive(id);
      };
      return h('div', { className: 'dte-row' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'dte-head', key: 'head' }, [
          h('div', { className: 'dte-title', key: 'title' }, t('title')),
          active === null ? null : h('button', {
            type: 'button',
            className: 'dte-reset',
            key: 'reset',
            onClick: () => choose(null),
          }, t('reset')),
        ]),
        h('div', { className: 'dte-desc', key: 'desc' }, t('description')),
        h('div', { className: 'dte-grid', key: 'grid' }, CATALOG.map((preset) => h(PresetCard, {
          key: preset.id,
          preset,
          selected: active === preset.id,
          onSelect: choose,
        }))),
      ]);
    }

    return {
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'theme-engine: settings row copy');

        /** Active override layer; at most one, replaced on every selection. */
        let layer = null;
        let current = readSaved();

        /**
         * Apply a catalog preset, or clear the layer with `null`. Repeated
         * selection of the live preset is a no-op.
         * @param id - preset id from the catalog, or null for the base theme.
         */
        const applyPreset = (id) => {
          const next = id !== null && BY_ID.has(id) ? id : null;
          if (next === current && (next === null || layer !== null)) return;
          if (layer !== null) {
            layer();
            layer = null;
          }
          current = next;
          if (next !== null) layer = ctx.theme.overrideTokens(SOURCE, BY_ID.get(next).tokens);
          writeSaved(next);
        };

        if (current !== null) applyPreset(current);

        ctx.effect(() => () => {
          if (layer !== null) {
            layer();
            layer = null;
          }
        }, 'theme-engine: preset palette layer');

        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item',
          id: 'theme-presets',
          order: 10.5,
          locale: NS,
          inject: () => ({
            applyPreset,
            getActivePreset: () => current,
          }),
        }, PresetRow));
      },
    };
  },
});
