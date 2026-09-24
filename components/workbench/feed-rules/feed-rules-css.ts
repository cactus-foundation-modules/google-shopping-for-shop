// Extra styles for the Feed Rules tab, on top of the workbench's own (class
// prefix `gsw-`, emitted with it). Prefix `gsr-`. Tokens only, so it follows
// the admin's light and dark themes with no second palette.
export const feedRulesCss = `
.gsr{display:grid;gap:1rem;min-width:0}
.gsr-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:0.75rem}
.gsr-counts{display:flex;flex-wrap:wrap;gap:0.25rem 1rem;font-size:0.8125rem;color:var(--color-text-secondary)}
.gsr-counts strong{color:var(--color-text);font-variant-numeric:tabular-nums}
.gsr-range{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;font-size:0.875rem;color:var(--color-text)}

.gsr-list{list-style:none;margin:0;padding:0;display:grid;gap:0.5rem}
.gsr-rule{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:0.75rem;align-items:start;padding:0.75rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface)}
.gsr-rule.is-off{background:var(--color-bg-subtle)}
.gsr-rule.is-off .gsr-rule-name{color:var(--color-text-secondary)}
.gsr-rule.is-dragging{opacity:0.5}
.gsr-rule.is-drop-target{border-color:var(--color-primary);box-shadow:inset 0 3px 0 var(--color-primary)}
.gsr-handle{display:grid;gap:0.25rem;justify-items:center}
.gsr-grip{cursor:grab;user-select:none;padding:0.125rem 0.375rem;border-radius:var(--radius-sm);color:var(--color-text-secondary);font-size:1rem;line-height:1;border:1px solid transparent;background:transparent}
.gsr-grip:hover{border-color:var(--color-border);background:var(--color-bg-subtle)}
.gsr-move{appearance:none;border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);border-radius:var(--radius-sm);width:28px;height:24px;font-size:0.75rem;cursor:pointer}
.gsr-move:disabled{opacity:0.4;cursor:default}
.gsr-move:focus-visible,.gsr-grip:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsr-rule-body{min-width:0;display:grid;gap:0.25rem}
.gsr-rule-name{font-weight:600;color:var(--color-text);overflow-wrap:anywhere}
.gsr-rule-when{font-size:0.8125rem;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gsr-rule-then{font-size:0.8125rem;color:var(--color-text);overflow-wrap:anywhere}
.gsr-rule-meta{display:flex;flex-wrap:wrap;gap:0.25rem 0.75rem;font-size:0.75rem;color:var(--color-text-secondary);align-items:center}
.gsr-rule-actions{display:flex;flex-wrap:wrap;gap:0.375rem;align-items:center;justify-content:flex-end}
.gsr-confirm{flex-basis:100%;margin:0}
.gsr-switch{display:inline-flex;align-items:center;gap:0.375rem;font-size:0.8125rem;color:var(--color-text);cursor:pointer}
.gsr-switch input{width:16px;height:16px;accent-color:var(--color-primary);cursor:pointer}

.gsr-editor{display:grid;gap:0.875rem;padding:1rem;border:1px solid var(--color-primary-border);border-radius:var(--radius-lg);background:var(--color-surface)}
.gsr-editor-title{margin:0;font-size:1.0625rem;color:var(--color-text)}
.gsr-field-block{display:grid;gap:0.375rem}
.gsr-label{font-size:0.8125rem;font-weight:600;color:var(--color-text)}
.gsr-hint{margin:0}
.gsr-input{height:38px;padding:0 0.625rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.875rem;min-width:0;max-width:100%}
.gsr-input:focus-visible,.gsr-textarea:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsr-wide{flex:1 1 20rem}
.gsr-textarea{min-width:min(100%,14rem);padding:0.375rem 0.625rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.8125rem;resize:vertical}
.gsr-action{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.gsr-group{display:grid;gap:0.5rem;padding:0.625rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg-subtle)}
.gsr-group.is-nested{background:var(--color-surface)}
.gsr-group-head{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;color:var(--color-text)}
.gsr-group-actions{display:flex;flex-wrap:wrap;gap:0.375rem}
.gsr-item{display:grid;gap:0.375rem}
.gsr-joiner{justify-self:start;font-size:0.6875rem;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:var(--color-text-secondary);padding:0 0.25rem}
.gsr-condition{display:flex;flex-wrap:wrap;gap:0.375rem;align-items:center}
.gsr-field{max-width:min(100%,22rem)}
.gsr-value{max-width:min(100%,24rem)}
.gsr-multi{height:auto;min-height:7rem;padding:0.25rem;max-width:min(100%,24rem)}
.gsr-empty{margin:0}
.gsr-editor-actions{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.gsr-editor-actions .gsw-spacer{flex:1}

.gsr-preview{display:grid;gap:0.5rem;padding:0.75rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-bg-subtle)}
.gsr-preview.is-stale{opacity:0.75}
.gsr-preview-lede{margin:0;font-size:0.875rem;color:var(--color-text)}
.gsr-preview-list{margin:0;padding-left:1.1rem;font-size:0.875rem;color:var(--color-text);display:grid;gap:0.125rem}
.gsr-samples summary{cursor:pointer;font-size:0.8125rem;font-weight:600;color:var(--color-text)}
.gsr-samples summary:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}
.gsr-samples ul{list-style:none;margin:0.5rem 0 0;padding:0;display:grid;gap:0.375rem;max-height:22rem;overflow:auto}
.gsr-samples li{display:grid;gap:0.125rem;padding:0.375rem 0.5rem;border-radius:var(--radius-sm);background:var(--color-surface)}
.gsr-sample-title{font-size:0.8125rem;color:var(--color-text);overflow-wrap:anywhere}

`
