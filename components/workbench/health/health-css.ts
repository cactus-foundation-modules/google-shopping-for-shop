// Extra styles for the Health tab, on top of the workbench's own (class prefix
// `gsw-`, emitted with it). Prefix `gsh-`. Tokens only, so it follows the
// admin's light and dark themes with no second palette.
export const healthCss = `
.gsh{display:grid;gap:1rem;min-width:0}
.gsh-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:0.75rem}
.gsh-actions{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}

.gsh-panel{border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);padding:0.875rem 1rem;display:grid;gap:0.625rem;min-width:0}
.gsh-panel.is-bad{border-color:var(--color-error-border,var(--color-danger));background:var(--color-error-bg)}
.gsh-panel.is-good{border-color:var(--color-success-border,var(--color-border))}
.gsh-panel-title{margin:0;font-size:1rem;font-weight:600;color:var(--color-text)}
.gsh-panel-note{margin:0;font-size:0.875rem;color:var(--color-text-secondary);max-width:80ch}

.gsh-facts{display:flex;flex-wrap:wrap;gap:0.25rem 1.5rem;font-size:0.875rem;color:var(--color-text-secondary)}
.gsh-facts strong{color:var(--color-text);font-variant-numeric:tabular-nums}
.gsh-facts code{font-family:var(--font-mono,monospace);font-size:0.8125rem;color:var(--color-text);overflow-wrap:anywhere}

.gsh-issues{list-style:none;margin:0;padding:0;display:grid;gap:0.375rem}
.gsh-issue{display:grid;gap:0.125rem;padding:0.5rem 0.625rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg-subtle)}
.gsh-issue-title{font-size:0.875rem;font-weight:600;color:var(--color-text);overflow-wrap:anywhere}
.gsh-issue-detail{font-size:0.8125rem;color:var(--color-text-secondary);overflow-wrap:anywhere}

.gsh-codes{list-style:none;margin:0;padding:0;display:grid;gap:0.375rem}
.gsh-code{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 0.75rem;padding:0.5rem 0.625rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface)}
.gsh-code.is-active{border-color:var(--color-primary);background:var(--color-primary-subtle)}
.gsh-code-name{flex:1 1 16rem;min-width:0;font-size:0.875rem;color:var(--color-text);overflow-wrap:anywhere}
.gsh-code-count{font-variant-numeric:tabular-nums;font-weight:600;color:var(--color-text)}
.gsh-code-actions{display:flex;flex-wrap:wrap;gap:0.375rem;align-items:center}

.gsh-item{display:grid;gap:0.25rem;padding:0.625rem 0.75rem;border-bottom:1px solid var(--color-border)}
.gsh-item:last-child{border-bottom:0}
.gsh-item-title{font-size:0.875rem;font-weight:600;color:var(--color-text);overflow-wrap:anywhere}
.gsh-item-id{font-family:var(--font-mono,monospace);font-size:0.75rem;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gsh-item-reasons{display:flex;flex-wrap:wrap;gap:0.25rem}
.gsh-item-reasons .badge{font-size:0.6875rem;padding:2px 8px;white-space:normal;text-align:left}
.gsh-item-links{display:flex;flex-wrap:wrap;gap:0.75rem;font-size:0.8125rem}

.gsh-item-actions{display:flex;flex-wrap:wrap;gap:0.375rem;align-items:center}

/* --- Google's own words about one item ---------------------------------- */
.gsh-explain{display:grid;gap:0.5rem;margin-top:0.25rem;padding:0.625rem 0.75rem;border-left:3px solid var(--color-primary);border-radius:var(--radius-sm);background:var(--color-bg-subtle)}
.gsh-explain-head{font-size:0.75rem;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;color:var(--color-text-secondary)}
.gsh-explain-issue{display:grid;gap:0.125rem}
.gsh-explain-code{font-size:0.8125rem;font-weight:600;color:var(--color-text);overflow-wrap:anywhere}
.gsh-explain-text{font-size:0.875rem;color:var(--color-text);overflow-wrap:anywhere}
.gsh-explain-detail{font-size:0.8125rem;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gsh-explain-foot{display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center;font-size:0.75rem;color:var(--color-text-secondary)}
.gsh-explain.is-quiet{border-left-color:var(--color-border-strong)}
/* Asking again: the held answer stays readable, just visibly out of date.
   The BODY dims, never the heading - secondary text on the subtle background
   is already near the contrast floor, and 0.6 over it would drop under AA
   for as long as the call takes. */
.gsh-explain.is-asking .gsh-explain-issue,
.gsh-explain.is-asking .gsh-explain-text{opacity:0.75}
.gsh-explain.is-bad{border-left-color:var(--color-danger)}

.gsh-empty{padding:2rem 1rem;text-align:center;color:var(--color-text-secondary)}
.gsh-empty strong{display:block;color:var(--color-text);font-size:1rem;margin-bottom:0.25rem}
`
