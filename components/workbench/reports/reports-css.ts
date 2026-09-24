// Extra styles for the Reports tab, on top of the workbench's own (class
// prefix `gsw-`, emitted with it). Prefix `gsr-`. Tokens only, so it follows
// the admin's light and dark themes with no second palette.
//
// The two series colours are deliberately the primary and the information
// token: both are defined for light and dark, both clear AA against the
// surface, and they are told apart by line style as well as by colour so the
// chart reads without either.
export const reportsCss = `
.gsr{display:grid;gap:1rem;min-width:0}
.gsr-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:0.75rem}
.gsr-actions{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}

.gsr-panel{border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);padding:0.875rem 1rem;display:grid;gap:0.75rem;min-width:0}
.gsr-panel-title{margin:0;font-size:1rem;font-weight:600;color:var(--color-text)}
.gsr-panel-note{margin:0;font-size:0.875rem;color:var(--color-text-secondary);max-width:80ch}

/* --- Range picker -------------------------------------------------------- */
.gsr-range{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center}
.gsr-dates{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;font-size:0.8125rem;color:var(--color-text-secondary)}
.gsr-dates input{height:38px;padding:0 0.625rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.8125rem}
.gsr-dates input:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}

/* --- Headline figures ---------------------------------------------------- */
.gsr-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:0.75rem}
.gsr-column{display:grid;gap:0.5rem;padding:0.75rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg-subtle);min-width:0}
.gsr-column-head{display:flex;align-items:center;gap:0.5rem;font-size:0.8125rem;font-weight:600;color:var(--color-text)}
.gsr-swatch{width:1.25rem;height:0;border-top-width:3px;border-top-style:solid;flex-shrink:0}
.gsr-swatch.is-organic{border-top-color:var(--color-primary)}
.gsr-swatch.is-ads{border-top-color:var(--color-info);border-top-style:dashed}
.gsr-figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,110px),1fr));gap:0.5rem}
.gsr-figure{display:grid;gap:0.125rem;min-width:0}
.gsr-figure-label{font-size:0.6875rem;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;color:var(--color-text-secondary)}
.gsr-figure-value{font-size:1.125rem;font-weight:700;font-variant-numeric:tabular-nums;color:var(--color-text);overflow-wrap:anywhere}
.gsr-figure-value.is-absent{font-size:0.8125rem;font-weight:500;color:var(--color-text-secondary)}

/* --- Chart --------------------------------------------------------------- */
.gsr-chart{display:grid;gap:0.5rem;min-width:0}
.gsr-chart-svg{width:100%;height:auto;max-height:260px;display:block}
.gsr-grid{stroke:var(--color-border);stroke-width:1;vector-effect:non-scaling-stroke}
.gsr-axis{fill:var(--color-text-secondary);font-size:10px;font-family:inherit}
.gsr-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}
.gsr-line.is-organic{stroke:var(--color-primary)}
.gsr-line.is-ads{stroke:var(--color-info);stroke-dasharray:6 4}
.gsr-dot.is-organic{fill:var(--color-primary)}
.gsr-dot.is-ads{fill:var(--color-info)}
.gsr-legend{display:flex;flex-wrap:wrap;gap:0.5rem 1rem;align-items:center;font-size:0.8125rem}
.gsr-key{display:inline-flex;align-items:center;gap:0.375rem;color:var(--color-text)}
.gsr-key::before{content:'';width:1.25rem;border-top-width:3px;border-top-style:solid}
.gsr-key.is-organic::before{border-top-color:var(--color-primary)}
.gsr-key.is-ads::before{border-top-color:var(--color-info);border-top-style:dashed}

/* --- Per-product table --------------------------------------------------- */
.gsr-table-wrap{overflow-x:auto;min-width:0;border:1px solid var(--color-border);border-radius:var(--radius-md)}
.gsr-table{width:100%;border-collapse:collapse;font-size:0.8125rem}
.gsr-table th,.gsr-table td{padding:0.5rem 0.625rem;text-align:left;border-bottom:1px solid var(--color-border);vertical-align:top}
.gsr-table tbody tr:last-child td{border-bottom:0}
.gsr-table th{font-weight:600;color:var(--color-text-secondary);white-space:nowrap;background:var(--color-bg-subtle)}
.gsr-table td.is-number,.gsr-table th.is-number{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.gsr-table .gsr-item-title{color:var(--color-text);font-weight:600;overflow-wrap:anywhere}
.gsr-table .gsr-item-id{display:block;font-family:var(--font-mono,monospace);font-size:0.6875rem;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gsr-absent{color:var(--color-text-secondary)}
.gsr-sort{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;padding:0;display:inline-flex;align-items:center;gap:0.25rem}
.gsr-sort:hover{color:var(--color-text)}
.gsr-sort:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}
.gsr-sort.is-active{color:var(--color-primary)}

/* --- Best sellers -------------------------------------------------------- */
.gsr-sellers{display:grid;gap:0.375rem}
.gsr-seller{display:flex;flex-wrap:wrap;align-items:baseline;gap:0.5rem 0.75rem;padding:0.5rem 0.625rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);min-width:0}
.gsr-seller-rank{font-variant-numeric:tabular-nums;font-weight:700;color:var(--color-text-secondary);min-width:2.5rem}
.gsr-seller-name{flex:1 1 18rem;min-width:0;color:var(--color-text);overflow-wrap:anywhere}
.gsr-seller-meta{font-size:0.75rem;color:var(--color-text-secondary)}

.gsr-empty{padding:2rem 1rem;text-align:center;color:var(--color-text-secondary)}
.gsr-empty strong{display:block;color:var(--color-text);font-size:1rem;margin-bottom:0.25rem}

/* --- Settings ------------------------------------------------------------ */
.gsr-settings{display:grid;gap:0.75rem}
.gsr-setting{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 0.75rem;min-width:0}
.gsr-setting label{font-size:0.875rem;color:var(--color-text)}
.gsr-setting input[type=number],.gsr-setting input[type=text],.gsr-setting select{height:36px;padding:0 0.625rem;border-radius:var(--radius-md);border:1px solid var(--color-border);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:0.8125rem}
.gsr-setting input[type=text]{flex:1 1 16rem;min-width:min(100%,12rem)}
.gsr-setting input:focus-visible,.gsr-setting select:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:1px}
.gsr-setting-note{flex:1 1 100%;margin:0;font-size:0.8125rem;color:var(--color-text-secondary);max-width:80ch}

/* --- This site's own live figures ---------------------------------------- */
/* Prefix gsl-, and kept visually apart from the Google panels above: a
   different panel border and a standing caption, so nobody reads one set of
   numbers as the other's. Tokens only, both themes. */
.gsl-panel{border:1px solid var(--color-primary);border-radius:var(--radius-lg);background:var(--color-surface);padding:0.875rem 1rem;display:grid;gap:0.75rem;min-width:0}
.gsl-banner{margin:0;font-size:0.8125rem;color:var(--color-text-secondary);max-width:80ch}
.gsl-source{display:inline-flex;align-items:center;gap:0.375rem;font-size:0.75rem;font-weight:600;color:var(--color-text-secondary)}
.gsl-dot{width:0.5rem;height:0.5rem;border-radius:50%;flex-shrink:0}
.gsl-dot.is-free{background:var(--color-primary)}
.gsl-dot.is-paid{background:var(--color-info)}

.gsl-feed{display:grid;gap:0.375rem}
.gsl-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:0.375rem 0.75rem;padding:0.5rem 0.625rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg-subtle);min-width:0}
.gsl-when{font-size:0.75rem;color:var(--color-text-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.gsl-what{flex:1 1 16rem;min-width:0;color:var(--color-text);overflow-wrap:anywhere}
.gsl-variant{display:block;font-size:0.75rem;color:var(--color-text-secondary);overflow-wrap:anywhere}
.gsl-badge{display:inline-flex;align-items:center;gap:0.25rem;font-size:0.6875rem;font-weight:600;padding:0.125rem 0.5rem;border-radius:999px;border:1px solid var(--color-border);color:var(--color-text-secondary);background:var(--color-surface);white-space:nowrap}
.gsl-badge.is-sold{border-color:var(--color-success);color:var(--color-success)}
.gsl-badge.is-pending{border-color:var(--color-warning);color:var(--color-warning)}
.gsl-open{appearance:none;border:0;background:transparent;color:var(--color-primary);font:inherit;font-size:0.75rem;font-weight:600;cursor:pointer;padding:0;text-decoration:underline}
.gsl-open:focus-visible{outline:2px solid var(--color-border-focus);outline-offset:2px}

.gsl-detail{display:grid;gap:0.5rem;padding:0.75rem;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-bg-subtle);min-width:0}
.gsl-detail dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:0.5rem;margin:0}
.gsl-detail dt{font-size:0.6875rem;font-weight:600;letter-spacing:0.02em;text-transform:uppercase;color:var(--color-text-secondary);margin:0}
.gsl-detail dd{margin:0;font-size:0.875rem;color:var(--color-text);overflow-wrap:anywhere}
.gsl-bought{margin:0;padding-left:1.1rem;font-size:0.8125rem;color:var(--color-text)}
`
