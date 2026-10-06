import { ASSISTANT_RESERVE_Y_VAR } from './assistantWindow'

/** Empty floor at the bottom of a project screen's column, tall enough that
 *  nothing in the tab above reaches under the assistant's character at its
 *  default bottom-right spot (owner 2026-10-06: the character stays put and the
 *  screen makes room). `under` = how much of that height something below it
 *  (the folded agent-team bar) already fills. Zero height while the variable
 *  is unset (no assistant, or the owner dragged it elsewhere). */
export const AssistantFloor = ({ under = 0 }: { under?: number }) => (
  <div
    aria-hidden
    data-assistant-floor
    className="shrink-0"
    style={{ height: `max(0px, calc(var(${ASSISTANT_RESERVE_Y_VAR}, 0px) - ${under}px))` }}
  />
)
