// Only crossing the breakpoint resets the layout default. Resizing within the
// same mode must not undo a user's explicit collapse/open choice.
export function createBreakpointTransition(onChange, breakpoint = 1024) {
  let wasMobile
  return width => {
    const mobile = width <= breakpoint
    if (mobile === wasMobile) return false
    wasMobile = mobile
    onChange(mobile)
    return true
  }
}
