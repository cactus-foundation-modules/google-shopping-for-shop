// Extra styles for the Delivery tab, on top of the workbench's own (class
// prefix `gsw-`, emitted with it). Prefix `gsd-`. Tokens only, so it follows
// the admin's light and dark themes with no second palette.
export const deliveryCss = `
.gsd{display:grid;gap:1rem;min-width:0}
.gsd-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:0.75rem}
.gsd-actions{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}

.gsd-panel{border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);padding:0.875rem 1rem;display:grid;gap:0.625rem;min-width:0}
.gsd-panel.is-bad{border-color:var(--color-error-border,var(--color-danger));background:var(--color-error-bg)}
.gsd-panel-title{margin:0;font-size:1rem;font-weight:600;color:var(--color-text)}
.gsd-panel-note{margin:0;font-size:0.875rem;color:var(--color-text-secondary);max-width:80ch}

.gsd-notes{list-style:none;margin:0;padding:0;display:grid;gap:0.5rem}
.gsd-note{display:grid;gap:0.125rem;padding:0.5rem 0.75rem;border-left:3px solid var(--color-border-strong);border-radius:var(--radius-sm);background:var(--color-bg-subtle)}
.gsd-note.is-warning{border-left-color:var(--color-warning,var(--color-border-strong))}
.gsd-note.is-blocking{border-left-color:var(--color-danger)}
.gsd-note-where{font-size:0.75rem;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;color:var(--color-text-secondary)}
.gsd-note-text{font-size:0.875rem;color:var(--color-text);max-width:80ch}

.gsd-service{border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);padding:0.625rem 0.75rem;display:grid;gap:0.5rem;min-width:0}
.gsd-service-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:0.5rem 1rem}
.gsd-service-name{font-size:0.9375rem;font-weight:600;color:var(--color-text);overflow-wrap:anywhere}
.gsd-service-time{font-size:0.8125rem;color:var(--color-text-secondary)}

.gsd-groups{list-style:none;margin:0;padding:0;display:grid;gap:0.25rem}
.gsd-group{display:flex;flex-wrap:wrap;align-items:baseline;gap:0.375rem 0.75rem;padding:0.3125rem 0.5rem;border-radius:var(--radius-sm);background:var(--color-bg-subtle)}
.gsd-group-price{font-variant-numeric:tabular-nums;font-weight:600;color:var(--color-text);min-width:5rem}
.gsd-group-labels{flex:1 1 16rem;min-width:0;font-size:0.8125rem;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gsd-group.is-catch-all .gsd-group-labels{font-style:italic}

.gsd-compare{display:grid;gap:0.5rem}
.gsd-row{display:grid;gap:0.375rem;padding:0.625rem 0.75rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface)}
.gsd-row-head{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 0.75rem}
.gsd-row-name{flex:1 1 14rem;min-width:0;font-size:0.875rem;font-weight:600;color:var(--color-text);overflow-wrap:anywhere}
.gsd-diffs{list-style:none;margin:0;padding:0;display:grid;gap:0.25rem}
.gsd-diff{display:grid;gap:0.125rem;font-size:0.8125rem}
.gsd-diff-field{font-weight:600;color:var(--color-text)}
.gsd-diff-side{color:var(--color-text-secondary);overflow-wrap:anywhere}

.gsd-empty{padding:2rem 1rem;text-align:center;color:var(--color-text-secondary)}
.gsd-empty strong{display:block;color:var(--color-text);font-size:1rem;margin-bottom:0.25rem}

.gsd-confirm{display:grid;gap:0.625rem;padding:0.875rem 1rem;border:1px solid var(--color-warning,var(--color-border-strong));border-radius:var(--radius-lg);background:var(--color-bg-subtle)}
.gsd-confirm-title{margin:0;font-size:0.9375rem;font-weight:600;color:var(--color-text)}
.gsd-confirm-text{margin:0;font-size:0.875rem;color:var(--color-text-secondary);max-width:80ch}
`
