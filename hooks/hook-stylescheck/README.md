# hook-stylescheck

A PreToolUse hook that intercepts `Write`/`Edit` calls on frontend files and warns on design anti-patterns before they're written to disk.

## What it checks

| Pattern | Example | Why |
|---------|---------|-----|
| Hardcoded hex colors | `#3b82f6` | Use CSS variables or design tokens |
| Hardcoded rgb/rgba | `rgb(59, 130, 246)` | Same — use tokens |
| Inline style colors | `style={{ color: '#fff' }}` | Prefer Tailwind classes |
| Magic pixel font sizes | `fontSize: '14px'` | Use type scale (text-sm, text-base) |
| Non-standard z-index | `z-index: 47` | Use multiples of 10 or named tokens |
| `!important` | `color: red !important` | Indicates specificity issues |

## Files checked

`.tsx`, `.jsx`, `.css`, `.scss`, `.html`, `.svelte`

## Design profile

Create `~/.hooks/styles.json` to inject project-specific design context:

```json
{
  "design_system": "Tailwind CSS v4 + shadcn/ui",
  "color_tokens": ["--color-primary", "--color-secondary", "--color-accent"],
  "banned_patterns": ["styled-components", "emotion"],
  "notes": "Always use Tailwind classes. No inline styles."
}
```

## Install

```bash
hooks install stylescheck
```

## Event

`PreToolUse` — matcher: `Write|Edit`
