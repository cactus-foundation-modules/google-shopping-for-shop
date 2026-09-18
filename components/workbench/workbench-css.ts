// Stylesheet for the Google Shopping workbench, emitted once by the screen.
// Class prefix `gsw-`. Real CSS rather than inline styles so hover, focus
// rings, the sticky bars and the loading animations work; colours are tokens
// only, so it follows the admin's light/dark theme with no second palette.
export const workbenchCss = `
.gsw{display:grid;gap:1rem;min-width:0}
.gsw-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:0.75rem}
.gsw-title{margin:0 0 0.25rem;font-size:1.25rem}
.gsw-lede{margin:0;max-width:70ch;font-size:0.875rem;color:var(--color-text-secondary)}
.gsw-head-actions{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.gsw-muted{color:var(--color-text-secondary)}
.gsw-small{font-size:0.8125rem}
.gsw-nowrap{white-space:nowrap}
.gsw-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* --- Summary tiles ------------------------------------------------------- */
.gsw-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:0.5rem}
.gsw-tile{appearance:none;text-align:left;display:grid;gap:0.125rem;padding:0.625rem 0.75rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);color:var(--color-text);cursor:pointer;font:inherit}
.gsw-tile:hover{border-color:var(--color-border-strong);background:var(--color-bg-subtle)}
.gsw-tile:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsw-tile.is-active{border-color:var(--color-primary);background:var(--color-primary-subtle)}
.gsw-tile-label{font-size:0.75rem;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;color:var(--color-text-secondary)}
.gsw-tile-value{font-size:1.25rem;font-weight:700;font-variant-numeric:tabular-nums}
.gsw-tile-note{font-size:0.75rem;color:var(--color-text-secondary)}
.gsw-tile-value.is-good{color:var(--color-success)}
.gsw-tile-value.is-bad{color:var(--color-danger)}
.gsw-tile-value.is-warn{color:var(--color-warning)}
.gsw-skeleton-value{display:block;width:4rem;height:1.25rem;margin:0.125rem 0}

/* --- Chips --------------------------------------------------------------- */
.gsw-chips{display:flex;flex-wrap:wrap;gap:0.375rem;align-items:center}
.gsw-chips-label{font-size:0.75rem;font-weight:600;color:var(--color-text-secondary);margin-right:0.25rem}
.gsw-chip{appearance:none;display:inline-flex;align-items:center;gap:0.375rem;height:28px;padding:0 0.625rem;border:1px solid var(--color-border);border-radius:var(--radius-full);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.8125rem;cursor:pointer}
.gsw-chip:hover:not(:disabled){background:var(--color-bg-subtle);border-color:var(--color-border-strong)}
.gsw-chip:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsw-chip:disabled{opacity:0.55;cursor:default}
.gsw-chip.is-active{background:var(--color-primary);border-color:var(--color-primary);color:var(--color-on-primary)}
.gsw-chip-count{font-variant-numeric:tabular-nums;font-weight:600}
.gsw-chip-x{font-size:1rem;line-height:1}

/* --- Filter bar ---------------------------------------------------------- */
.gsw-filters{display:grid;gap:0.625rem}
.gsw-filter-row{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.gsw-search{position:relative;flex:1 1 320px;min-width:min(100%,240px)}
.gsw-search input{width:100%;height:38px;padding:0 4.75rem 0 0.75rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.875rem}
.gsw-search input:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsw-search-side{position:absolute;right:0.5rem;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:0.375rem}
.gsw-search-clear{appearance:none;border:0;background:transparent;color:var(--color-text-secondary);font-size:1.1rem;line-height:1;cursor:pointer;padding:0.125rem 0.25rem;border-radius:var(--radius-sm)}
.gsw-search-clear:hover{color:var(--color-text);background:var(--color-bg-subtle)}
.gsw-search-clear:focus-visible{outline:2px solid var(--color-border-focus)}
.gsw-kbd{font-family:var(--font-mono,monospace);font-size:0.6875rem;padding:0.0625rem 0.3125rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-secondary);background:var(--color-bg-subtle)}
.gsw-select{height:38px;max-width:100%;padding:0 1.75rem 0 0.625rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.8125rem;cursor:pointer}
.gsw-select:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsw-select.is-set{border-color:var(--color-primary);background:var(--color-primary-subtle)}

/* --- Spinner and progress ----------------------------------------------- */
@keyframes gsw-spin{to{transform:rotate(360deg)}}
.gsw-spinner{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:gsw-spin 0.7s linear infinite;flex-shrink:0;color:var(--color-primary)}
@keyframes gsw-progress{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
.gsw-progress{position:relative;height:3px;overflow:hidden;background:transparent}
.gsw-progress.is-on{background:var(--color-primary-subtle)}
.gsw-progress.is-on::after{content:"";position:absolute;inset:0;width:40%;background:var(--color-primary);animation:gsw-progress 1.1s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){
  .gsw-spinner{animation-duration:2s}
  .gsw-progress.is-on::after{animation:none;width:100%;opacity:0.5}
}

/* --- Status line --------------------------------------------------------- */
.gsw-status{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;min-height:1.5rem;font-size:0.8125rem;color:var(--color-text-secondary)}
.gsw-status strong{color:var(--color-text)}
.gsw-status-slow{flex-basis:100%;font-size:0.8125rem;color:var(--color-text-secondary)}
.gsw-message{margin:0;padding:0.5rem 0.75rem;border-radius:var(--radius-md);font-size:0.875rem;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.gsw-message.is-ok{background:var(--color-success-bg);color:var(--color-success)}
.gsw-message.is-error{background:var(--color-error-bg);color:var(--color-error)}
.gsw-message.is-info{background:var(--color-info-bg);color:var(--color-info)}
.gsw-message .btn{margin-left:auto}

/* --- Results card and table --------------------------------------------- */
.gsw-card{border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);min-width:0}
.gsw-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.625rem 0.75rem;border-bottom:1px solid var(--color-border)}
.gsw-scroll{overflow-x:auto}
.gsw-table{width:100%;border-collapse:collapse;font-size:0.875rem;min-width:1080px}
.gsw-table th{position:sticky;top:0;z-index:1;text-align:left;padding:0.5rem 0.75rem;background:var(--color-bg-subtle);font-size:0.75rem;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;color:var(--color-text-secondary);border-bottom:1px solid var(--color-border);white-space:nowrap}
.gsw-table td{padding:0.625rem 0.75rem;border-bottom:1px solid var(--color-border);vertical-align:top;color:var(--color-text)}
.gsw-table tbody tr:hover{background:transparent}
.gsw-table tbody tr.gsw-row:hover{background:var(--color-bg-subtle)}
.gsw-table tr.is-selected,.gsw-table tbody tr.gsw-row.is-selected:hover{background:var(--color-primary-subtle)}
.gsw-table tr.is-dirty td:last-child{box-shadow:inset 3px 0 0 var(--color-warning)}
.gsw-tbody{transition:opacity 120ms ease}
.gsw-tbody.is-busy{opacity:0.5;pointer-events:none}
.gsw-check{width:36px}
.gsw-check input{width:16px;height:16px;cursor:pointer;accent-color:var(--color-primary)}
.gsw-col-product{width:34%}
.gsw-col-google{width:22%}
.gsw-empty{padding:2.5rem 1rem;text-align:center;color:var(--color-text-secondary)}
.gsw-empty strong{display:block;color:var(--color-text);font-size:1rem;margin-bottom:0.25rem}

.gsw-product{display:flex;gap:0.75rem;min-width:0}
.gsw-thumb{width:56px;height:56px;flex-shrink:0;border-radius:var(--radius-md);object-fit:cover;border:1px solid var(--color-border);background:var(--color-bg-subtle)}
.gsw-thumb-empty{display:flex;align-items:center;justify-content:center;color:var(--color-text-secondary);font-size:0.75rem}
.gsw-product-body{min-width:0;display:grid;gap:0.25rem}
.gsw-product-name{font-weight:600;color:var(--color-text);text-decoration:none;overflow-wrap:anywhere}
.gsw-product-name:hover{text-decoration:underline;color:var(--color-primary)}
.gsw-meta{display:flex;flex-wrap:wrap;gap:0.25rem 0.75rem;font-size:0.75rem;color:var(--color-text-secondary)}
.gsw-meta code{font-family:var(--font-mono,monospace);font-size:0.75rem;color:var(--color-text)}
.gsw-linkish{appearance:none;border:0;background:transparent;padding:0;font:inherit;font-size:0.75rem;color:var(--color-primary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.gsw-linkish:hover{color:var(--color-primary-hover)}
.gsw-linkish:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsw-issues{display:flex;flex-wrap:wrap;gap:0.25rem}
.gsw-issues .badge{font-size:0.6875rem;padding:2px 8px}

.gsw-google{display:grid;gap:0.375rem;font-size:0.8125rem}
.gsw-gap{font-weight:600;font-variant-numeric:tabular-nums}
.gsw-gap.is-dearer{color:var(--color-danger)}
.gsw-gap.is-cheaper{color:var(--color-success)}
.gsw-held{font-size:0.75rem;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gsw-held strong{color:var(--color-warning)}
.gsw-google-actions{display:flex;flex-wrap:wrap;gap:0.375rem 0.75rem;align-items:center}
.gsw-google-actions a{font-size:0.8125rem}

/* --- Template editor ----------------------------------------------------- */
.gsw-editor{display:grid;gap:0.375rem}
.gsw-editor textarea{width:100%;min-height:3.25rem;resize:vertical;padding:0.5rem 0.625rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.8125rem;line-height:1.4}
.gsw-editor textarea:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsw-editor.is-dirty textarea{border-color:var(--color-warning)}
.gsw-preview{display:grid;gap:0.125rem;padding:0.375rem 0.5rem;border-radius:var(--radius-md);background:var(--color-bg-subtle);font-size:0.8125rem}
.gsw-preview-label{font-size:0.6875rem;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;color:var(--color-text-secondary)}
.gsw-preview-title{color:var(--color-text);overflow-wrap:anywhere}
.gsw-preview-cut{background:var(--color-error-bg);color:var(--color-error);text-decoration:line-through}
.gsw-length{font-size:0.75rem;font-variant-numeric:tabular-nums;color:var(--color-text-secondary)}
.gsw-length.is-over{color:var(--color-danger);font-weight:600}
.gsw-warn{font-size:0.75rem;color:var(--color-danger)}
.gsw-editor-actions{display:flex;flex-wrap:wrap;gap:0.375rem;align-items:center}
.gsw-editor-actions .gsw-spacer{flex:1}
.gsw-tokens{display:flex;flex-wrap:wrap;gap:0.25rem;padding:0.375rem;border:1px dashed var(--color-border);border-radius:var(--radius-md)}
.gsw-token{appearance:none;display:inline-flex;flex-direction:column;align-items:flex-start;gap:0;max-width:14rem;padding:0.1875rem 0.4375rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface);color:var(--color-text);font:inherit;cursor:pointer;text-align:left}
.gsw-token:hover{border-color:var(--color-primary);background:var(--color-primary-subtle)}
.gsw-token:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsw-token-name{font-family:var(--font-mono,monospace);font-size:0.6875rem;color:var(--color-primary-dark)}
.gsw-token-value{font-size:0.6875rem;color:var(--color-text-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* --- History sub-row ----------------------------------------------------- */
.gsw-subrow td{background:var(--color-bg-subtle)}
.gsw-history{display:grid;gap:0.5rem}
.gsw-history table{min-width:0;font-size:0.8125rem}
.gsw-history th,.gsw-history td{padding:0.35rem 0.5rem;background:transparent}

/* --- Sticky bars (bulk + unsaved) ---------------------------------------- */
.gsw-bar{position:sticky;top:0.5rem;z-index:6;display:grid;gap:0.5rem;padding:0.625rem 0.75rem;border:1px solid var(--color-primary-border);background:var(--color-primary-subtle);border-radius:var(--radius-md);box-shadow:var(--shadow-md)}
.gsw-bar.is-unsaved{border-color:var(--color-warning-border);background:var(--color-warning-bg)}
.gsw-bar-row{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.gsw-bar-count{font-weight:600;font-size:0.875rem;color:var(--color-text)}
.gsw-bar .gsw-spacer{flex:1}
.gsw-bar .gsw-editor textarea{background:var(--color-surface)}
.gsw-select-all{font-size:0.8125rem;color:var(--color-text)}

/* --- Pager --------------------------------------------------------------- */
.gsw-pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:0.5rem;padding:0.625rem 0.75rem;border-top:1px solid var(--color-border)}
.gsw-pager-controls{display:flex;flex-wrap:wrap;align-items:center;gap:0.375rem}
.gsw-pager input{width:4.5rem;height:32px;padding:0 0.5rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.8125rem;text-align:center}
.gsw-pager input:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}

/* --- Recent changes ------------------------------------------------------ */
.gsw-changes{border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface)}
.gsw-changes summary{cursor:pointer;padding:0.625rem 0.75rem;font-weight:600;font-size:0.875rem;list-style-position:inside}
.gsw-changes summary:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:-2px}
.gsw-changes ol{list-style:none;margin:0;padding:0 0.75rem 0.75rem;display:grid;gap:0.375rem}
.gsw-change{display:flex;flex-wrap:wrap;align-items:center;gap:0.25rem 0.75rem;padding:0.5rem 0.625rem;border:1px solid var(--color-border);border-radius:var(--radius-md);font-size:0.8125rem}
.gsw-change.is-undone{opacity:0.7}
.gsw-change-summary{flex:1 1 20rem;min-width:0;overflow-wrap:anywhere;color:var(--color-text)}

/* --- Confirm dialog ------------------------------------------------------ */
.gsw-overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:1rem;background:var(--color-overlay)}
.gsw-dialog{width:100%;max-width:640px;max-height:calc(100vh - 2rem);overflow:auto;display:grid;gap:0.75rem;padding:1.25rem;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);color:var(--color-text);box-shadow:var(--shadow-xl)}
.gsw-dialog h3{margin:0;font-size:1.0625rem}
.gsw-dialog p{margin:0;font-size:0.875rem}
.gsw-dialog ul{margin:0;padding-left:1.1rem;font-size:0.875rem;display:grid;gap:0.25rem}
.gsw-samples{display:grid;gap:0.375rem;font-size:0.8125rem}
.gsw-sample{display:grid;gap:0.125rem;padding:0.5rem;border-radius:var(--radius-md);background:var(--color-bg-subtle)}
.gsw-sample-before{color:var(--color-text-secondary);text-decoration:line-through;overflow-wrap:anywhere}
.gsw-sample-after{color:var(--color-text);overflow-wrap:anywhere}
.gsw-dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:0.5rem}
`
