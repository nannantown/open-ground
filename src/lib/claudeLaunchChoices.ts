// The claude CLI model aliases offered wherever a launch model is picked:
// the Board's defaults strip and the drawer's per-card run settings. A saved
// value outside this list (a pinned full model id, say) is kept as an extra
// option by each picker — never silently dropped.
export const TASK_MODEL_CHOICES: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku']
