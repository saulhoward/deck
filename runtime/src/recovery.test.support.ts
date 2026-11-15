// These suites inject faux providers and faulting tool implementations. Give
// parent and child the same explicit test identity instead of hashing the entire
// installed dependency tree inside a checkpoint deadline. Production startup and
// the compatibility suites still fingerprint the actual executable/code bytes.
export const MESSAGE_RECOVERY_IMPLEMENTATION = "d1".repeat(32);
export const TASK_RECOVERY_IMPLEMENTATION = "d2".repeat(32);
export const SUBAGENT_RECOVERY_IMPLEMENTATION = "d3".repeat(32);
